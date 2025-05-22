// express router
import { Router } from "express";
const router = Router();

// schema import
import { Ballot } from "../../../schema/Ballot.js";
import { Proposal } from "../../../schema/Proposal.js";
import { Vote } from "../../../schema/Vote.js";

// helper
import { verifyToken } from "../../../helper/verifyToken.js";
import { cacheControl } from "../../../helper/cacheControl.js";
import validator from "validator";
import mongoose from "mongoose";
import { getBallot } from "../../../helper/middleWare.js";

/**
 * @route GET /api/v0/ballots
 * @description Get all ballots with pagination, filtering and search capabilities
 * @access Public
 *
 * @param {Object} req.query
 * @param {string} [req.query.voterType] - Filter by voter type
 * @param {string} [req.query.status] - Filter by status ('live', 'closed', or 'upcoming')
 * @param {string} [req.query.search] - Search term for ballot name or ID
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=10] - Number of items per page (max 100)
 *
 * @returns {Object} 200 - List of ballots with pagination metadata
 * @returns {Object} 400 - Error if query parameters are invalid
 * @returns {Object} 500 - Server error
 */
router.get("/", async (req, res) => {
  const { voterType, status, search, page = 1, limit = 10 } = req.query;
  let matchStage = {};

  // Validate search parameter
  if (search) {
    if (!validator.isLength(search, { min: 1, max: 100 })) {
      return res.status(400).json({
        status: "error",
        message: "Search term must be between 1 and 100 characters",
      });
    }

    // Check for potentially dangerous characters
    if (
      validator.contains(search, "$") ||
      validator.contains(search, "{") ||
      validator.contains(search, "}")
    ) {
      return res.status(400).json({
        status: "error",
        message: "Search contains invalid characters",
      });
    }

    // Create search criteria that matches either name or ID
    const searchQuery = validator.escape(search);

    // Set up the OR query
    matchStage.$or = [{ name: { $regex: new RegExp(searchQuery, "i") } }];

    // Check if search might be a valid MongoDB ObjectID (24 hex characters)
    if (validator.isMongoId(search)) {
      // Import mongoose and convert string to ObjectId for proper MongoDB comparison
      try {
        const objectId = new mongoose.Types.ObjectId(search);
        matchStage.$or.push({ _id: objectId });
      } catch (err) {
        console.log("Invalid ObjectId format:", err.message);
      }
    }
  }

  // validate voterType
  if (voterType && !validator.isAlphanumeric(voterType)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid voterType format",
    });
  }

  // Validate status parameter
  if (
    status &&
    !["live", "closed", "upcoming"].includes(status.toLowerCase())
  ) {
    return res.status(400).json({
      status: "error",
      message:
        "Invalid status parameter, must be 'live', 'closed', or 'upcoming'",
    });
  }

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

  // Add voterType filter if provided
  if (voterType) {
    // Validate the voterType parameter
    if (!validator.isAlphanumeric(voterType)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid voterType format",
      });
    }
    matchStage.voterType = { $regex: new RegExp(`^${voterType}$`, "i") };
  }

  try {
    // Current date for status calculations
    const now = new Date();

    // Create base aggregation pipeline for filtering
    const filterPipeline = [
      // Initial match stage for voterType and search
      { $match: matchStage },

      // Add computed status field
      {
        $addFields: {
          status: {
            $cond: {
              if: { $gt: ["$votePeriodEnd", now] },
              then: {
                $cond: {
                  if: { $lte: ["$votePeriodStart", now] },
                  then: "live",
                  else: "upcoming",
                },
              },
              else: "closed",
            },
          },
        },
      },

      // Apply status filter if provided
      ...(status ? [{ $match: { status: status.toLowerCase() } }] : []),
    ];

    // Count total documents matching the filter (for pagination metadata)
    const countPipeline = [...filterPipeline, { $count: "total" }];

    const totalResults = await Ballot.aggregate(countPipeline);
    const total = totalResults.length > 0 ? totalResults[0].total : 0;

    // Calculate pagination values
    const totalPages = Math.ceil(total / limitNum);
    const skip = (pageNum - 1) * limitNum;

    // Create data retrieval pipeline with pagination
    const dataPipeline = [
      ...filterPipeline,
      // Sort by voting period end date
      { $sort: { votePeriodEnd: -1 } },
      // Apply pagination
      { $skip: skip },
      { $limit: limitNum },
      // Exclude fields we don't want to return
      // !! needs checking
      {
        $project: {
          id: 0,
          voterValidationScript: 0,
          rollupScript: 0,
          voteAuthorityId: 0,
          voteAuthorityAddress: 0,
          resultBeaconToken: 0,
        },
      },
    ];

    // Execute aggregation for paginated data
    const ballots = await Ballot.aggregate(dataPipeline);

    // Return empty array with pagination metadata if no ballots are found
    if (!ballots || ballots.length === 0) {
      return res.status(200).json({
        data: [],
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
        },
      });
    }

    // Return the list of ballots with pagination metadata
    return res.status(200).json({
      data: ballots,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching ballots:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching ballots",
    });
  }
});

/**
 * @route GET /api/v0/ballots/voterTypes
 * @description Get all unique voter types from all ballots
 * @access Public
 *
 * @returns {Array} 200 - Array of unique voter types
 * @returns {Object} 500 - Server error
 */
router.get("/voterTypes", async (req, res) => {
  try {
    // Fetch all ballots and extract unique voterTypes
    const ballots = await Ballot.find().select("voterType");
    const voterTypes = [...new Set(ballots.map((ballot) => ballot.voterType))];

    // Return the list of unique voterTypes
    return res.status(200).json(voterTypes);
  } catch (error) {
    console.error("Error fetching voter types:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching voter types",
    });
  }
});

/**
 * @route GET /api/v0/ballots/:ballotId
 * @description Get a specific ballot by ID with voter validation if token is present
 * @access Public
 *
 * @param {string} req.params.ballotId - The ID of the ballot to retrieve
 *
 * @returns {Object} 200 - The ballot object with additional voter-specific data if authenticated
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 * @returns {Object} 500 - Server error (handled by getBallot middleware)
 */
router.get("/:ballotId", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();

  // check if voter token is present
  const voterToken = verifyToken(req);
  // import voter validation from ballot
  const { validateVoter, allowedVoterCount, getWeight } = await import(
    "../../../config/" + ballot.voterValidationScript
  );
  if (voterToken.voterId) {
    // check if voter is valid voter
    ballot.voterValidated = await validateVoter(voterToken.voterId, ballot._id);
    // get voting power
    if (ballot.voterValidated) {
      ballot.votingPower = await getWeight(voterToken.voterId, ballot._id);
    }
  }

  // get total voter count for ballot
  ballot.totalAllowedVoterCount = await allowedVoterCount();

  // get total weight count for ballot
  const { getTotalWeight } = await import(
    "../../../config/" + ballot.voterValidationScript
  );
  ballot.totalVotingPower = await getTotalWeight();

  // cleanup ballot data
  delete ballot.voterValidationScript;

  // Return the ballot
  return res.status(200).json(ballot);
});

/**
 * @route GET /api/v0/ballots/:ballotId/proposals
 * @description Get all proposals for a specific ballot with filtering, sorting and pagination
 * @access Public (enhanced with voter-specific data if authenticated)
 *
 * @param {string} req.params.ballotId - The ID of the ballot to get proposals for
 * @param {Object} req.query
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=10] - Number of items per page (max 100)
 * @param {string} [req.query.committee] - Filter by committee
 * @param {string} [req.query.roadmap] - Filter by roadmap
 * @param {string} [req.query.type] - Filter by proposal type
 * @param {string} [req.query.search] - Search term for proposal name or ID
 * @param {string} [req.query.sort] - Sort field ('cost', 'name', 'commentCount', 'voteCount')
 * @param {string} [req.query.direction='desc'] - Sort direction ('asc' or 'desc')
 * @param {string} [req.query.hasVoted] - Filter by whether authenticated user has voted ('true'/'false')
 * @param {string} [req.query.thresholdReached] - Filter by threshold status ('true'/'false')
 *
 * @returns {Object} 200 - List of proposals with pagination, sorting and filter metadata
 * @returns {Object} 400 - Error if query parameters are invalid
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:ballotId/proposals/", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();
  const voterToken = verifyToken(req);
  const voterId = voterToken.voterId || false;

  // Extract and validate pagination parameters
  const {
    page = 1,
    limit = 10,
    committee,
    roadmap,
    type,
    search,
    sort,
    direction = "desc",
    hasVoted, // New filter parameter
    thresholdReached, // New filter parameter for threshold status
  } = req.query;
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  // Validate pagination parameters
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

  // Validate hasVoted parameter
  if (hasVoted !== undefined && !["true", "false"].includes(hasVoted)) {
    return res.status(400).json({
      status: "error",
      message: "hasVoted must be 'true' or 'false'",
    });
  }

  // Validate thresholdReached parameter
  if (
    thresholdReached !== undefined &&
    !["true", "false"].includes(thresholdReached)
  ) {
    return res.status(400).json({
      status: "error",
      message: "thresholdReached must be 'true' or 'false'",
    });
  }

  // Determine sort direction value (1 for ascending, -1 for descending)
  const sortDirection = direction.toLowerCase() === "asc" ? 1 : -1;

  // Determine sort field and validate
  let sortField = { _id: -1 }; // Default sort by ID, newest first

  if (sort) {
    // Validate sort parameter
    if (!["cost", "name", "commentCount", "voteCount"].includes(sort)) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid sort field, must be 'cost', 'name', 'commentCount', or 'voteCount'",
      });
    }

    // Set sort field based on parameter with _id as secondary sort field
    switch (sort) {
      case "cost":
        sortField = { "data.cost": sortDirection, _id: 1 };
        break;
      case "name":
        sortField = { name: sortDirection, _id: 1 };
        break;
      case "commentCount":
        sortField = { commentCount: sortDirection, _id: 1 };
        break;
      case "voteCount":
        sortField = { voteCount: sortDirection, _id: 1 };
        break;
    }
  }

  // Calculate skip value for pagination
  const skip = (pageNum - 1) * limitNum;

  // Build initial match stage
  const matchStage = { ballotId: new mongoose.Types.ObjectId(req.ballotId) };

  // Add search filter if provided
  if (search) {
    if (!validator.isLength(search, { min: 1, max: 100 })) {
      return res.status(400).json({
        status: "error",
        message: "Search term must be between 1 and 100 characters",
      });
    }

    // Sanitize search input
    const searchQuery = validator.escape(search);

    // Set up the OR query to match name or ID
    matchStage.$or = [{ name: { $regex: new RegExp(searchQuery, "i") } }];

    // Check if search might be a valid MongoDB ObjectID
    if (validator.isMongoId(search)) {
      try {
        const objectId = new mongoose.Types.ObjectId(search);
        matchStage.$or.push({ _id: objectId });
      } catch (err) {
        console.log("Invalid ObjectId format:", err.message);
      }
    }

    // Remove the ballotId from the top level since we're using $or
    const ballotId = matchStage.ballotId;
    delete matchStage.ballotId;

    // Add ballotId condition to each $or item
    matchStage.$or = matchStage.$or.map((condition) => ({
      ...condition,
      ballotId: ballotId,
    }));
  }

  // Add committee filter if provided - Fix path to reflect actual data structure
  if (committee) {
    matchStage["data.data.committee"] = committee;
  }

  // Add roadmap filter if provided - Fix path to reflect actual data structure
  if (roadmap) {
    matchStage["data.data.roadmap"] = roadmap;
  }

  // Add type filter if provided - Fix path to reflect actual data structure
  if (type) {
    matchStage["data.data.type"] = type;
  }

  // Build base aggregation pipeline with common stages
  const aggregationPipeline = [
    // Match proposals for the given ballot and filters if specified
    { $match: matchStage },

    // Lookup comments from the Comment collection
    {
      $lookup: {
        from: "comments",
        localField: "_id",
        foreignField: "proposalId",
        as: "comments",
      },
    },
    // Add a field that counts the comments
    {
      $addFields: {
        commentCount: { $size: "$comments" },
      },
    },
    // First, lookup results to have access to it
    {
      $lookup: {
        from: "results",
        localField: "_id",
        foreignField: "proposalId",
        as: "results",
      },
    },
    // Then add the result field from results array
    {
      $addFields: {
        result: { $arrayElemAt: ["$results", 0] },
      },
    },
    // Now lookup votes from the Vote collection
    {
      $lookup: {
        from: "votes",
        localField: "_id",
        foreignField: "proposalId",
        as: "allVotes",
      },
    },
    // Calculate voteCount after we have the result data
    {
      $addFields: {
        validVotes: {
          $filter: {
            input: "$allVotes",
            as: "vote",
            cond: { $ne: ["$$vote.submittedAt", null] },
          },
        },
        voteCount: {
          $cond: {
            if: { $ifNull: ["$result", false] },
            then: {
              $reduce: {
                input: "$result.results",
                initialValue: 0,
                in: { $add: ["$$value", "$$this.count"] },
              },
            },
            else: 0, // Return 0 if no results are available
          },
        },
        // Calculate threshold reached
        thresholdReached: {
          $cond: {
            if: { $ifNull: ["$result", false] },
            then: {
              $let: {
                vars: {
                  // Find the "yes" votes (value 1)
                  yesVotes: {
                    $reduce: {
                      input: {
                        $filter: {
                          input: "$result.results",
                          as: "voteResult",
                          cond: { $eq: ["$$voteResult.value", 1] },
                        },
                      },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.votingPower"] },
                    },
                  },
                  // Find the "no" votes (value -1)
                  noVotes: {
                    $reduce: {
                      input: {
                        $filter: {
                          input: "$result.results",
                          as: "voteResult",
                          cond: { $eq: ["$$voteResult.value", -1] },
                        },
                      },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.votingPower"] },
                    },
                  },
                  // Find the "abstain" votes (value 0)
                  abstainVotes: {
                    $reduce: {
                      input: {
                        $filter: {
                          input: "$result.results",
                          as: "voteResult",
                          cond: { $eq: ["$$voteResult.value", 0] },
                        },
                      },
                      initialValue: 0,
                      in: { $add: ["$$value", "$$this.votingPower"] },
                    },
                  },
                  // Calculate total votes (yes + no + abstain)
                  totalVotingPower: {
                    $sum: "$result.results.votingPower",
                  },
                },
                in: {
                  $cond: {
                    if: { $eq: [{ $add: ["$$yesVotes", "$$noVotes"] }, 0] },
                    then: false, // No votes cast yet
                    else: {
                      $gt: [
                        // Yes votes divided by total votes (excluding abstains)
                        {
                          $divide: [
                            "$$yesVotes",
                            {
                              $add: [
                                "$$yesVotes",
                                "$$noVotes",
                                // Remove abstain votes from denominator
                              ],
                            },
                          ],
                        },
                        0.5, // 50% threshold
                      ],
                    },
                  },
                },
              },
            },
            else: false, // No results available
          },
        },
      },
    },
  ];

  // Add voter-specific fields only if voterId is present
  if (voterId) {
    // Add a field to indicate if the voter has voted on this proposal
    aggregationPipeline.push({
      $addFields: {
        userVote: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$allVotes",
                as: "vote",
                cond: { $eq: ["$$vote.voterId", voterId] },
              },
            },
            0,
          ],
        },
        hasVoted: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: "$validVotes",
                  as: "vote",
                  cond: {
                    $and: [
                      { $eq: ["$$vote.voterId", voterId] },
                      { $ne: ["$$vote.submittedAt", null] },
                    ],
                  },
                },
              },
            },
            0,
          ],
        },
      },
    });

    // Apply hasVoted filter if provided (only for logged-in users)
    if (hasVoted !== undefined) {
      aggregationPipeline.push({
        $match: { hasVoted: hasVoted === "true" },
      });
    }
  } else if (hasVoted !== undefined) {
    // If no voter is logged in and hasVoted filter is requested, return empty list
    if (hasVoted === "true") {
      return res.status(200).json({
        data: [],
        pagination: {
          total: 0,
          page: pageNum,
          limit: limitNum,
          totalPages: 0,
        },
        sort: {
          field: sort || "_id",
          direction: direction.toLowerCase(),
        },
        filters: {
          hasVoted: hasVoted,
          thresholdReached: thresholdReached,
        },
      });
    }
  }

  // Apply thresholdReached filter if provided (for all users)
  if (thresholdReached !== undefined) {
    aggregationPipeline.push({
      $match: { thresholdReached: thresholdReached === "true" },
    });
  }

  // Project fields based on whether user is logged in
  aggregationPipeline.push({
    $project: {
      _id: 1,
      name: 1,
      data: 1,
      ballotId: 1,
      voteOptions: 1,
      commentCount: 1,
      voteCount: 1,
      result: 1,
      thresholdReached: 1,
      // Only include user-specific fields when a user is logged in
      ...(voterId && {
        voterVote: "$userVote.value",
        hasVoted: 1,
      }),
    },
  });

  try {
    // Create a copy of the pipeline for counting total documents
    const countPipeline = [...aggregationPipeline];
    countPipeline.push({ $count: "total" });

    // Get total count
    const totalResults = await Proposal.aggregate(countPipeline);
    const total = totalResults.length > 0 ? totalResults[0].total : 0;

    // Calculate total pages
    const totalPages = Math.ceil(total / limitNum);

    // Add sorting and pagination to the main pipeline
    aggregationPipeline.push(
      { $sort: sortField }, // Sort based on the provided field and direction
      { $skip: skip },
      { $limit: limitNum }
    );

    // Fetch the proposals from the database
    const proposals = await Proposal.aggregate(aggregationPipeline);

    // Return proposals with pagination metadata
    return res.status(200).json({
      data: proposals.length > 0 ? proposals : [],
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
      sort: {
        field: sort || "_id",
        direction: direction.toLowerCase(),
      },
      filters: {
        hasVoted: hasVoted,
        thresholdReached: thresholdReached, // Add the threshold filter to response
      },
    });
  } catch (error) {
    console.error("Error fetching proposals:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching proposals",
    });
  }
});

export default router;
