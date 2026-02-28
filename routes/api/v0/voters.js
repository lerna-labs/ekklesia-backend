// express router
import { Router } from "express";
const router = Router();

// schema import
import { Session } from "../../../schema/Session.js";
import { Vote } from "../../../schema/Vote.js";
import { Ballot } from "../../../schema/Ballot.js";
import { UserCache } from "../../../schema/UserCache.js";
import { validateAddress } from "../../../helper/validateAddress.js";
import { cacheControl } from "../../../helper/cacheControl.js";

// helper
const API_URL = process.env.API_URL;

/**
 * @route GET /api/v0/voters
 * @description Get a paginated list of voters who have submitted votes, with filtering, sorting, and search capabilities. Response is cached for 300 seconds. Only voters with submitted votes are included.
 * @access Public
 *
 * @param {Object} req.query
 * @param {number} [req.query.page=1] - Page number for pagination (minimum: 1)
 * @param {number} [req.query.limit=25] - Number of items per page (minimum: 1, maximum: 100)
 * @param {string} [req.query.search=''] - Search term for voter ID (case-insensitive regex match, special regex characters escaped)
 * @param {string} [req.query.sort='votes'] - Sort field: 'userId', 'votes', or 'lastLogin' (default: 'votes')
 * @param {string} [req.query.direction='desc'] - Sort direction: 'asc' or 'desc' (default: 'desc')
 *
 * @returns {Object} 200 - Response object containing:
 *   - data: Array of voter objects, each containing:
 *     - userId: ID of the voter
 *     - votes: Number of votes cast by this voter
 *     - lastLogin: ISO 8601 timestamp of last login (null if never logged in)
 *   - pagination: Object with total, page, limit, totalPages
 *   OR
 *   - status: "msg"
 *   - message: "No voters found" (if no voters match criteria)
 * @returns {Object} 400 - Error if query parameters are invalid (page, limit, sort, or direction)
 * @returns {Object} 500 - Server error while fetching voter list
 */
router.get("/", cacheControl(300), async (req, res) => {
  const {
    page = 1,
    limit = 25, // Changed default from 10 to 25 to match frontend
    search = "",
    sort = "votes",
    direction = "desc",
  } = req.query;

  // Validate pagination parameters
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  if (isNaN(pageNum) || pageNum < 1) {
    return res.status(400).json({
      status: "error",
      message: "Invalid page parameter, must be a positive integer",
    });
  }

  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({
      status: "error",
      message:
        "Invalid limit parameter, must be a positive integer between 1 and 100",
    });
  }

  // Validate sort parameters
  const validSortFields = ["userId", "votes", "lastLogin"];
  const validDirections = ["asc", "desc"];

  if (!validSortFields.includes(sort)) {
    return res.status(400).json({
      status: "error",
      message: `Invalid sort parameter, must be one of: ${validSortFields.join(
        ", "
      )}`,
    });
  }

  if (!validDirections.includes(direction)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid direction parameter, must be asc or desc",
    });
  }

  try {
    // Build match conditions for filtering
    let matchConditions = {
      submittedAt: { $ne: null },
    };

    // Escape special regex characters in search string
    const escapeRegex = (string) => {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    // Add search by voter ID if provided
    const searchRegex = search
      ? new RegExp(`${escapeRegex(search)}`, "i")
      : null;

    if (search) {
      matchConditions.userId = searchRegex;
    }

    // First count total unique voters with filters applied
    const countResult = await Vote.aggregate([
      {
        $match: matchConditions,
      },
      {
        $group: {
          _id: "$userId",
        },
      },
      ...(search
        ? [
          {
            $match: { _id: searchRegex },
          },
        ]
        : []),
      {
        $count: "total",
      },
    ]);

    const total = countResult.length > 0 ? countResult[0].total : 0;

    // Calculate pagination values
    const totalPages = Math.ceil(total / limitNum);
    const skip = (pageNum - 1) * limitNum;

    // Get paginated voters with filters and sorting
    const pipeline = [
      {
        $match: matchConditions,
      },
      {
        $group: {
          _id: "$userId",
          votes: { $sum: 1 },
        },
      },
      ...(search
        ? [
          {
            $match: { _id: searchRegex },
          },
        ]
        : []),
    ];

    // Add lookup for last login data if sorting by lastLogin
    if (sort === "lastLogin") {
      pipeline.push(
        {
          $lookup: {
            from: "sessions",
            let: { userId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$userId", "$$userId"] },
                },
              },
              { $sort: { updatedAt: -1 } },
              { $limit: 1 },
              { $project: { _id: 0, updatedAt: 1 } },
            ],
            as: "sessionData",
          },
        },
        {
          $addFields: {
            lastLogin: {
              $cond: {
                if: { $gt: [{ $size: "$sessionData" }, 0] },
                then: { $arrayElemAt: ["$sessionData.updatedAt", 0] },
                else: null,
              },
            },
            // Add a separate field to handle null sorting
            lastLoginSortValue: {
              $cond: {
                if: { $gt: [{ $size: "$sessionData" }, 0] },
                then: { $arrayElemAt: ["$sessionData.updatedAt", 0] },
                else: new Date(0), // Use epoch date for sorting nulls first in ascending order
              },
            },
          },
        }
      );
    }

    // Add sorting based on the requested field and direction
    const sortOrder = direction === "asc" ? 1 : -1;

    // Create sort stage based on requested field
    if (sort === "userId") {
      pipeline.push({ $sort: { _id: sortOrder } });
    } else if (sort === "votes") {
      pipeline.push({ $sort: { votes: sortOrder, _id: 1 } });
    } else if (sort === "lastLogin") {
      // Fixed sort syntax - use the pre-computed field
      pipeline.push({ $sort: { lastLoginSortValue: sortOrder, _id: 1 } });
    }

    // Add pagination
    pipeline.push(
      { $skip: skip },
      { $limit: limitNum },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          votes: 1,
          lastLogin: 1,
        },
      }
    );

    const voters = await Vote.aggregate(pipeline);

    if (!voters || voters.length === 0) {
      return res.status(200).json({
        status: "msg",
        message: "No voters found",
      });
    }

    // Only fetch lastLogin separately if we're not already sorting by it
    // (since in that case we already have the data)
    if (sort !== "lastLogin") {
      // Get the last login for each voter
      const userIds = voters.map((voter) => voter.userId);
      const lastLogins = await Session.find({
        userId: { $in: userIds },
      }).sort({ updatedAt: -1 });

      const lastLoginMap = {};
      lastLogins.forEach((login) => {
        if (!lastLoginMap[login.userId]) {
          lastLoginMap[login.userId] = login.updatedAt;
        }
      });

      // Add last login to each voter
      voters.forEach((voter) => {
        voter.lastLogin = lastLoginMap[voter.userId] || null;
      });
    }

    // Return data with pagination metadata
    return res.status(200).json({
      data: voters,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching voter list:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching voter list",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

/**
 * @route GET /api/v0/voters/types
 * @description Get counts of different voter types (stake, drep, pool) based on voters who have submitted votes. Response is cached for 300 seconds.
 * @access Public
 *
 * @returns {Array} 200 - Array of objects, each containing:
 *   - type: Voter type string ("stake", "drep", or "pool")
 *   - count: Number of voters of this type who have submitted votes
 * @returns {Object} 500 - Server error while fetching voter types
 */
router.get("/types", cacheControl(300), async (req, res) => {
  try {
    const voters = await Vote.aggregate([
      {
        $match: { submittedVote: { $exists: true } },
      },
      {
        $group: { _id: "$userId" },
      },
    ]);

    // Extract voter types from IDs
    const voterTypes = voters.reduce((types, voter) => {
      const userId = voter._id;
      if (userId.startsWith("stake")) {
        types.stake = (types.stake || 0) + 1;
      } else if (userId.startsWith("drep")) {
        types.drep = (types.drep || 0) + 1;
      } else if (userId.startsWith("pool")) {
        types.pool = (types.pool || 0) + 1;
      }
      return types;
    }, {});

    // Format response as array of objects with type and count
    const response = Object.entries(voterTypes).map(([type, count]) => ({
      type,
      count,
    }));

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching voter types:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching voter types",
    });
  }
});

/**
 * @route GET /api/v0/voters/:userId
 * @description Get detailed information about a specific voter including voting history across all ballots. Response is cached for 300 seconds. Voter ID is validated and converted to CIP129 format if applicable. Voter must exist in UserCache to be found.
 * @access Public
 *
 * @param {string} req.params.userId - The ID of the voter to retrieve (must start with "stake", "drep", or "pool")
 *
 * @returns {Object} 200 - Voter object containing:
 *   - voterType: Type of voter ("stake", "drep", or "pool")
 *   - userId: Validated voter ID (CIP129 format if applicable)
 *   - votes: Array of ballot objects the voter has voted on, each containing:
 *     - _id: Ballot ID
 *     - title: Ballot title
 *     - votePeriodStart: ISO 8601 timestamp when voting period started
 *     - votePeriodEnd: ISO 8601 timestamp when voting period ended
 *     - votingPower: Voting power of the voter for this ballot
 *     - status: Ballot status ("live", "closed", or "upcoming")
 *     - proposals: Array of proposals voted on, each containing:
 *       - proposalId: Proposal ID
 *       - title: Proposal title
 *       - vote: Array of vote option labels (or IDs for scale votes, "Abstain" for abstain votes)
 *   - ballotsVoted: Number of ballots the voter has voted on
 *   - proposalsVoted: Total number of proposals the voter has voted on across all ballots
 *   - lastVoteDate: ISO 8601 timestamp of most recent vote (null if never voted)
 *   - lastLogin: ISO 8601 timestamp of last login (null if never logged in)
 * @returns {Object} 400 - Error if:
 *   - Voter ID is missing
 *   - Voter ID format is invalid (doesn't start with stake, drep, or pool)
 *   - Voter ID validation fails
 * @returns {Object} 404 - Error if voter not found in UserCache
 * @returns {Object} 500 - Server error while fetching voter data
 */
router.get("/:userId", cacheControl(300), async (req, res) => {
  let userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({
      status: "error",
      message: "Voter ID is required",
    });
  }

  // Check voter ID type
  let voterType;
  if (userId.startsWith("stake")) {
    voterType = "stake";
  } else if (userId.startsWith("drep")) {
    voterType = "drep";
  } else if (userId.startsWith("pool")) {
    voterType = "pool";
  } else {
    return res.status(400).json({
      status: "error",
      message: "Invalid ID format: must start with stake, drep, or pool",
    });
  }

  let userIdValidated = validateAddress(userId, voterType);
  if (userIdValidated.error) {
    return res.status(400).json({
      status: "error",
      message: userIdValidated.error,
    });
  }
  // use CIP129 from here on
  if (userIdValidated.cip129) userIdValidated = userIdValidated.cip129;
  // check if voter is in votercache
  const userCache = await UserCache.findOne({ userId: userIdValidated });
  if (!userCache) {
    return res.status(404).json({
      status: "error",
      message: "Voter not found",
    });
  }

  // // get voter data from API
  // let voterData = await getVoterData(userId, voterType);
  // if (voterData.error) {
  //   console.log("Error fetching voter data:", voterData.error);
  //   return res.status(voterData.status).json(voterData);
  // }

  // add voterType to voterData
  let voterData = {};
  voterData.voterType = voterType;
  voterData.userId = userIdValidated;

  // get votes for the voter - needs pagination at some point
  const ballots = await Vote.aggregate([
    {
      $match: {
        userId: userIdValidated,
        submittedAt: { $ne: null },
      },
    },
    {
      $group: {
        _id: "$ballotId",
        votes: { $push: "$$ROOT" },
      },
    },
    {
      $lookup: {
        from: "ballots",
        localField: "_id",
        foreignField: "_id",
        as: "ballot",
      },
    },
    {
      $unwind: "$ballot",
    },
    // Add lookup to get voting power from UserCache
    {
      $lookup: {
        from: "usercaches",
        let: { ballotId: "$_id", voter: userIdValidated },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$ballotId", "$$ballotId"] },
                  { $eq: ["$userId", "$$voter"] },
                ],
              },
            },
          },
        ],
        as: "voterPower",
      },
    },
    {
      $unwind: {
        path: "$voterPower",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: "proposals",
        localField: "votes.proposalId",
        foreignField: "_id",
        as: "proposalDetails",
      },
    },
    {
      $project: {
        _id: 1,
        votes: 1,
        ballot: 1,
        proposalDetails: 1,
        votingPower: "$voterPower.votingPower",
      },
    },
    {
      $sort: { votedAt: -1 }, // Sort by most recent votes first
    },
  ]);

  // Properly hydrate and include virtuals
  const populatedBallots = await Ballot.populate(ballots, {
    path: "ballot",
  });

  // Process the votes to include proposal information
  const votes = populatedBallots
    .map((item) => {
      // Get the ballot with virtuals
      const ballotWithVirtuals = item.ballot.toObject({ virtuals: true });

      // Filter to only include proposals the voter has voted on
      const votedProposals = item.proposalDetails
        .map((p) => {
          const vote = item.votes.find(
            (v) => v.proposalId?.toString() === p._id.toString()
          );
          if (
            vote?.submittedVote === undefined ||
            vote?.submittedVote === null
          )
            return null; // Skip if no vote found

          // vote.submittedVote is an array of voteOption ids - extract the label from p.voteOptions
          const voteLabels = vote.submittedVote.map((id) => {
            const option = p.voteOptions.find((o) => o.id.toString() === id.toString());
            // set label for abstain votes
            if (id === "abstain") {
              return "Abstain";
            }
            // on scale votes return the id
            if (p.voteType === "scale") {
              return id;
            }
            // otherwise return the found label or null
            return option ? option.label : null;
          }).filter(Boolean);


          return {
            proposalId: p._id,
            title: p.title,
            vote: voteLabels,
          };
        })
        .filter(Boolean); // Remove null entries (proposals without votes)

      // If there are no voted proposals, return null
      if (votedProposals.length === 0) return null;

      return {
        _id: item._id,
        title: item.ballot.title,
        votePeriodStart: item.ballot.votePeriodStart,
        votePeriodEnd: item.ballot.votePeriodEnd,
        votingPower: item.votingPower || 0, // Include voting power in the response
        status: ballotWithVirtuals.status,
        proposals: votedProposals,
      };
    })
    .filter(Boolean); // Filter out any null ballots (no votes)

  // Add voting statistics
  voterData.votes = votes;
  voterData.ballotsVoted = votes.length;
  // voterData = ballots[0]?.votingPower;

  voterData.proposalsVoted = votes.reduce(
    (count, ballot) => count + ballot.proposals.length,
    0
  );
  voterData.lastVoteDate = votes.length > 0 ? votes[0].votedAt : null;

  // get last login for the voter
  const lastLogin = await Session.findOne({
    userId: userIdValidated,
  }).sort({ updatedAt: -1 });
  if (lastLogin) {
    voterData.lastLogin = lastLogin.updatedAt;
  } else {
    voterData.lastLogin = null;
  }

  // Return the voter data
  return res.status(200).json(voterData);
});

export default router;
