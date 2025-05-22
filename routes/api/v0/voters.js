// express router
import { Router } from "express";
const router = Router();

// schema import
import { Session } from "../../../schema/Session.js";
import { Vote } from "../../../schema/Vote.js";
import { Ballot } from "../../../schema/Ballot.js";
import { VoterCache } from "../../../schema/VoterCache.js";
import { validateAddress } from "../../../helper/validateAddress.js";
import { cacheControl } from "../../../helper/cacheControl.js";

// helper
const API_URL = process.env.API_URL;

/**
 * @route GET /api/v0/voters
 * @description Get a paginated list of voters with filtering, sorting, and search capabilities
 * @access Public
 *
 * @param {Object} req.query
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=25] - Number of items per page (max 100)
 * @param {string} [req.query.search] - Search term for voter ID
 * @param {string} [req.query.sort='votes'] - Sort field ('voterId', 'votes', or 'lastLogin')
 * @param {string} [req.query.direction='desc'] - Sort direction ('asc' or 'desc')
 *
 * @returns {Object} 200 - List of voters with pagination metadata
 * @returns {Object} 400 - Error if query parameters are invalid
 * @returns {Object} 404 - Error if no voters found
 * @returns {Object} 500 - Server error
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
  const validSortFields = ["voterId", "votes", "lastLogin"];
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
      submittedValue: { $exists: true },
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
      matchConditions.voterId = searchRegex;
    }

    // First count total unique voters with filters applied
    const countResult = await Vote.aggregate([
      {
        $match: matchConditions,
      },
      {
        $group: {
          _id: "$voterId",
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
          _id: "$voterId",
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
            let: { voterId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$voterId", "$$voterId"] },
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
    if (sort === "voterId") {
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
          voterId: "$_id",
          votes: 1,
          lastLogin: 1,
        },
      }
    );

    const voters = await Vote.aggregate(pipeline);

    if (!voters || voters.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "No voters found",
      });
    }

    // Only fetch lastLogin separately if we're not already sorting by it
    // (since in that case we already have the data)
    if (sort !== "lastLogin") {
      // Get the last login for each voter
      const voterIds = voters.map((voter) => voter.voterId);
      const lastLogins = await Session.find({
        voterId: { $in: voterIds },
      }).sort({ updatedAt: -1 });

      const lastLoginMap = {};
      lastLogins.forEach((login) => {
        if (!lastLoginMap[login.voterId]) {
          lastLoginMap[login.voterId] = login.updatedAt;
        }
      });

      // Add last login to each voter
      voters.forEach((voter) => {
        voter.lastLogin = lastLoginMap[voter.voterId] || null;
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
 * @description Get counts of different voter types (stake, drep, pool)
 * @access Public
 *
 * @returns {Array} 200 - Array of objects with voter type and count
 * @returns {Object} 500 - Server error
 */
router.get("/types", cacheControl(300), async (req, res) => {
  try {
    const voters = await Vote.aggregate([
      {
        $match: { submittedValue: { $exists: true } },
      },
      {
        $group: { _id: "$voterId" },
      },
    ]);

    // Extract voter types from IDs
    const voterTypes = voters.reduce((types, voter) => {
      const voterId = voter._id;
      if (voterId.startsWith("stake")) {
        types.stake = (types.stake || 0) + 1;
      } else if (voterId.startsWith("drep")) {
        types.drep = (types.drep || 0) + 1;
      } else if (voterId.startsWith("pool")) {
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
 * @route GET /api/v0/voters/:voterId
 * @description Get detailed information about a specific voter including voting history
 * @access Public
 *
 * @param {string} req.params.voterId - The ID of the voter to retrieve
 *
 * @returns {Object} 200 - The voter object with voting history and statistics
 * @returns {Object} 400 - Error if voter ID is invalid or missing
 * @returns {Object} 404 - Error if voter not found
 * @returns {Object} 500 - Server error
 */
router.get("/:voterId", cacheControl(300), async (req, res) => {
  let voterId = req.params.voterId;
  if (!voterId) {
    return res.status(400).json({
      status: "error",
      message: "Voter ID is required",
    });
  }

  // Check voter ID type
  let voterType;
  if (voterId.startsWith("stake")) {
    voterType = "stake";
  } else if (voterId.startsWith("drep")) {
    voterType = "drep";
  } else if (voterId.startsWith("pool")) {
    voterType = "pool";
  } else {
    return res.status(400).json({
      status: "error",
      message: "Invalid ID format: must start with stake, drep, or pool",
    });
  }

  let voterIdValidated = validateAddress(voterId, voterType);
  if (voterIdValidated.error) {
    return res.status(400).json({
      status: "error",
      message: voterIdValidated.error,
    });
  }
  // use CIP129 from here on
  if (voterIdValidated.cip129) voterIdValidated = voterIdValidated.cip129;
  // check if voter is in votercache
  const voterCache = await VoterCache.findOne({ voterId: voterIdValidated });
  if (!voterCache) {
    return res.status(404).json({
      status: "error",
      message: "Voter not found",
    });
  }

  // // get voter data from API
  // let voterData = await getVoterData(voterId, voterType);
  // if (voterData.error) {
  //   console.log("Error fetching voter data:", voterData.error);
  //   return res.status(voterData.status).json(voterData);
  // }

  // add voterType to voterData
  let voterData = {};
  voterData.voterType = voterType;
  voterData.voterId = voterIdValidated;

  // get votes for the voter - needs pagination at some point
  // !! THIS DISPLAYS REALTIME DATA WHY
  const ballots = await Vote.aggregate([
    {
      $match: {
        voterId: voterIdValidated,
        submittedValue: { $exists: true },
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
    // Add lookup to get voting power from VoterCache
    {
      $lookup: {
        from: "votercaches",
        let: { ballotId: "$_id", voter: voterIdValidated },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$ballotId", "$$ballotId"] },
                  { $eq: ["$voterId", "$$voter"] },
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
        votingPower: "$voterPower.votingPower", // Changed from weight to votingPower
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
            vote?.submittedValue === undefined ||
            vote?.submittedValue === null
          )
            return null; // Skip if no vote found

          return {
            proposalId: p._id,
            voteOptions: p.voteOptions,
            name: p.name,
            vote: vote.submittedValue,
          };
        })
        .filter(Boolean); // Remove null entries (proposals without votes)

      // If there are no voted proposals, return null
      if (votedProposals.length === 0) return null;

      return {
        _id: item._id,
        name: item.ballot.name,
        votePeriodStart: item.ballot.votePeriodStart,
        votePeriodEnd: item.ballot.votePeriodEnd,
        voteWeighted: item.ballot.voteWeighted,
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
    voterId: voterIdValidated,
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
