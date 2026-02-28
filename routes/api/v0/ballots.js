// express router
import { Router } from "express";
const router = Router();

// schema import
import { Ballot } from "../../../schema/Ballot.js";
import { Proposal } from "../../../schema/Proposal.js";
import { Vote } from "../../../schema/Vote.js";

// helper
import { verifyToken } from "../../../helper/verifyToken.js";
import validator from "validator";
import mongoose from "mongoose";
import { getBallot } from "../../../helper/middleWare.js";
import { checkVotingPower } from "../../../helper/voterValidation.js";
import { calculateSimpleMedian, calculateWeightedMedian } from "../../../helper/calculateMedians.js";

/**
 * @route GET /api/v0/ballots
 * @description Get all ballots with pagination, filtering and search capabilities. Results are sorted by votePeriodEnd (newest first). Each ballot includes a singleProposal field if it has exactly one proposal (for faster frontend navigation).
 * @access Public
 *
 * @param {Object} req.query
 * @param {string} [req.query.voterType] - Filter by voter type (case-insensitive regex match, must be alphanumeric)
 * @param {string} [req.query.status] - Filter by status: 'live', 'closed', or 'upcoming' (case-insensitive)
 * @param {string} [req.query.search] - Search term for ballot title or MongoDB ObjectId (1-100 characters, sanitized, case-insensitive regex match)
 * @param {number} [req.query.page=1] - Page number for pagination (minimum: 1)
 * @param {number} [req.query.limit=10] - Number of items per page (minimum: 1, maximum: 100)
 *
 * @returns {Object} 200 - Response object containing:
 *   - data: Array of ballot objects (excludes internal fields like voterValidationScript, rollupScript, etc.)
 *   - pagination: Object with total, page, limit, totalPages
 * @returns {Object} 400 - Error if:
 *   - Search term is not between 1 and 100 characters
 *   - Search contains invalid characters ($, {, })
 *   - voterType format is invalid (not alphanumeric)
 *   - status parameter is invalid (not 'live', 'closed', or 'upcoming')
 *   - page parameter is invalid (not a positive integer)
 *   - limit parameter is invalid (not between 1 and 100)
 * @returns {Object} 500 - Server error while fetching ballots
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

    // Create search criteria that matches either title or ID
    const searchQuery = validator.escape(search);

    // Set up the OR query
    matchStage.$or = [{ title: { $regex: new RegExp(searchQuery, "i") } }];

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
    // Create base aggregation pipeline for filtering
    const filterPipeline = [
      // Initial match stage for voterType and search
      { $match: matchStage },
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
      // Lookup proposals for each ballot
      {
        $lookup: {
          from: "proposals",
          localField: "_id",
          foreignField: "ballotId",
          as: "proposals",
        },
      },
      // Add singleProposal field if ballot has exactly one proposal - this allows for faster navigation on the frontend
      {
        $addFields: {
          singleProposal: {
            $cond: {
              if: { $eq: [{ $size: "$proposals" }, 1] },
              then: { $arrayElemAt: ["$proposals._id", 0] },
              else: null,
            },
          },
        },
      },
      // Sort by voting period end date
      { $sort: { votePeriodEnd: -1 } },
      // Apply pagination
      { $skip: skip },
      { $limit: limitNum },
      // Exclude fields we don't want to return
      {
        $project: {
          id: 0,
          voterValidationScript: 0,
          rollupScript: 0,
          voteAuthorityId: 0,
          voteAuthorityAddress: 0,
          proposalPeriodStart: 0,
          proposalPeriodEnd: 0,
          startupScript: 0,
          startupAt: 0,
          resultTxHash: 0,
          proposals: 0, // Remove proposals array from output
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
 * @description Get all unique voter types from all ballots in the system. Useful for filtering or displaying voter type options.
 * @access Public
 *
 * @returns {Array<string>} 200 - Array of unique voter type strings (e.g., ["stake", "drep", "pool"])
 * @returns {Object} 500 - Server error while fetching voter types
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
 * @description Get a specific ballot by ID with voter validation and voting power if authentication token is present
 * @access Public (enhanced with voter-specific data if authenticated)
 *
 * @param {string} req.params.ballotId - The MongoDB ObjectId of the ballot to retrieve
 *
 * @returns {Object} 200 - The ballot object with additional fields:
 *   - All standard ballot fields (title, description, voterType, votePeriodStart, etc.)
 *   - voterValidated: Boolean indicating if authenticated voter is valid for this ballot (only if authenticated)
 *   - votingPower: Number representing authenticated voter's voting power (only if authenticated and validated)
 *   - totalAllowedVoterCount: Number of voters eligible to vote in this ballot
 *   - totalVotingPower: Total voting power across all eligible voters
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 * @returns {Object} 500 - Server error (handled by getBallot middleware)
 */
router.get("/:ballotId", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();

  // check if voter token is present
  const voterToken = verifyToken(req);
  // import voter validation from ballot
  const { validateVoter, allowedVoterCount, getTotalWeight } = await import(
    "../../../config/" + ballot.voterValidationScript
  );
  if (voterToken.userId) {
    // check if voter is valid voter
    ballot.voterValidated = await validateVoter(voterToken.userId, ballot._id);
    // get voting power
    if (ballot.voterValidated) {
      ballot.votingPower = await checkVotingPower(voterToken.userId, ballot._id);
    }
  }

  // get total voter count for ballot
  ballot.totalAllowedVoterCount = await allowedVoterCount(ballot._id);

  // get total weight count for ballot
  ballot.totalVotingPower = await getTotalWeight(ballot._id);

  // cleanup ballot data
  delete ballot.voterValidationScript;

  // Return the ballot
  return res.status(200).json(ballot);
});

/**
 * @route GET /api/v0/ballots/:ballotId/proposals
 * @description Get all proposals for a specific ballot with filtering, sorting and pagination. Enhanced with voter-specific data (voterVote, hasVoted) if authenticated.
 * @access Public (enhanced with voter-specific data if authenticated)
 *
 * @param {string} req.params.ballotId - The ID of the ballot to get proposals for
 * @param {Object} req.query
 * @param {number} [req.query.page=1] - Page number for pagination (minimum: 1)
 * @param {number} [req.query.limit=10] - Number of items per page (minimum: 1, maximum: 100)
 * @param {string} [req.query.search] - Search term for proposal title or ID (1-100 characters, sanitized)
 * @param {string} [req.query.sort] - Sort field: 'title', 'commentCount', or 'voteCount' (default: '_id')
 * @param {string} [req.query.direction='desc'] - Sort direction: 'asc' or 'desc'
 * @param {string} [req.query.hasVoted] - Filter by whether authenticated user has voted: 'true' or 'false' (only works when authenticated)
 * @param {string} [req.query.tags] - Filter by tags (comma-separated, e.g., 'tag1,tag2')
 * @param {string} [req.query.categories] - Filter by categories (comma-separated, e.g., 'cat1,cat2')
 *
 * @returns {Object} 200 - Response object containing:
 *   - data: Array of proposal objects with computed fields (commentCount, voteCount, votingPower)
 *   - pagination: Object with total, page, limit, totalPages
 *   - sort: Object with field and direction
 *   - filters: Object with applied filter values
 * @returns {Object} 400 - Error if query parameters are invalid
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:ballotId/proposals/", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();
  const voterToken = verifyToken(req);
  const userId = voterToken.userId || false;

  // Extract and validate pagination parameters
  const {
    page = 1,
    limit = 10,
    search,
    sort,
    direction = "desc",
    hasVoted,
    tags, // New parameter for filtering by tags
    categories, // New parameter for filtering by categories
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

  // Determine sort direction value (1 for ascending, -1 for descending)
  const sortDirection = direction.toLowerCase() === "asc" ? 1 : -1;

  // Determine sort field and validate
  let sortField = { _id: 1 }; // Default sort by ID, newest first

  if (sort) {
    // Validate sort parameter
    if (!["title", "commentCount", "voteCount"].includes(sort)) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid sort field, must be 'title', 'commentCount', or 'voteCount'",
      });
    }

    // Set sort field based on parameter with _id as secondary sort field
    switch (sort) {
      case "title":
        sortField = { title: sortDirection, _id: 1 };
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

    // Set up the OR query to match title or ID
    matchStage.$or = [{ title: { $regex: new RegExp(searchQuery, "i") } }];

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

  // Add tags filter if provided (filter by array containing at least one of the specified tags)
  if (tags) {
    const tagsList = tags.split(',').map(tag => tag.trim());
    if (tagsList.length > 0) {
      matchStage.tags = { $in: tagsList };
    }
  }

  // Add categories filter if provided (filter by array containing at least one of the specified categories)
  if (categories) {
    const categoriesList = categories.split(',').map(category => category.trim());
    if (categoriesList.length > 0) {
      matchStage.categories = { $in: categoriesList };
    }
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
    // add the updatedAt field from result if exists, otherwise set it to null
    {
      $addFields: {
        "updatedAt": {
          $cond: {
            if: { $gt: [{ $size: "$results" }, 0] },
            then: { $arrayElemAt: ["$results.updatedAt", 0] },
            else: null,
          },
        },
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
    // Add this lookup stage after the votes lookup and before the addFields stage
    {
      $lookup: {
        from: "votercaches",
        localField: "ballotId",
        foreignField: "ballotId",
        as: "voterCaches",
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
            // Treat missing or null submittedAt as "not valid"
            cond: { $ne: [{ $ifNull: ["$$vote.submittedAt", null] }, null] },
          },
        },
        // Calculate total voting power of unique voters who voted
        votingPower: {
          $sum: {
            $map: {
              input: {
                // Get unique voters first  
                $setUnion: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: "$allVotes",
                          as: "vote",
                          cond: { $ne: ["$$vote.submittedAt", null] },
                          cond: { $ne: [{ $ifNull: ["$$vote.submittedAt", null] }, null] },
                        }
                      },
                      as: "vote",
                      in: "$$vote.userId"
                    }
                  }
                ]
              },
              as: "uniqueVoterId",
              in: {
                // Get voting power for this voter from voterCache
                $let: {
                  vars: {
                    voterCache: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$voterCaches",
                            as: "cache",
                            cond: {
                              $and: [
                                { $eq: ["$$cache.userId", "$$uniqueVoterId"] },
                                { $eq: ["$$cache.ballotId", "$ballotId"] }
                              ]
                            }
                          }
                        },
                        0
                      ]
                    }
                  },
                  in: { $ifNull: ["$$voterCache.votingPower", 1] }
                }
              }
            }
          }
        },
      },
    },
  ];

  // Add voter-specific fields only if userId is present
  if (userId) {
    // Add a field to indicate if the voter has voted on this proposal
    aggregationPipeline.push({
      $addFields: {
        userVote: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$allVotes",
                as: "vote",
                cond: { $eq: ["$$vote.userId", userId] },
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
                      { $eq: ["$$vote.userId", userId] },
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
        },
      });
    }
  }

  // Project fields based on whether user is logged in
  aggregationPipeline.push({
    $project: {
      _id: 1,
      title: 1,
      description: 1,
      categories: 1,
      tags: 1,
      ipfsHash: 1,
      data: 1,
      ballotId: 1,
      voteType: 1,
      voterBudget: 1,
      voteOptions: 1,
      voteIncrement: 1,
      abstainAllowed: 1,
      commentCount: 1,
      voteCount: {
        $size: {
          $setUnion: [
            {
              $map: {
                input: "$validVotes",
                as: "vote",
                in: "$$vote.userId"
              }
            }
          ]
        },
      },
      votingPower: 1,
      result: 1,
      updatedAt: 1,
      // Include vote data for scale voteType proposals to calculate medians
      validVotes: {
        $cond: {
          if: { $eq: ["$voteType", "scale"] },
          then: {
            $map: {
              input: "$validVotes",
              as: "vote",
              in: {
                submittedVote: "$$vote.submittedVote",
                userId: "$$vote.userId"
              }
            }
          },
          else: "$$REMOVE"
        }
      },
      voterCaches: {
        $cond: {
          if: { $eq: ["$voteType", "scale"] },
          then: "$voterCaches",
          else: "$$REMOVE"
        }
      },
      // Only include user-specific fields when a user is logged in
      ...(userId && {
        voterVote: "$userVote.vote",
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

    // Calculate medians for scale voteType proposals
    for (const proposal of proposals) {
      if (proposal.voteType === "scale" && proposal.voteOptions && proposal.voteOptions.length > 0) {
        const lowerBound = proposal.voteOptions[0].id;
        const upperBound = proposal.voteOptions[proposal.voteOptions.length - 1].id;

        // Ensure result object exists
        if (!proposal.result) {
          proposal.result = {};
        }

        // Calculate simple median based on submitted votes
        proposal.result.median = calculateSimpleMedian(
          proposal.validVotes || [],
          lowerBound,
          upperBound
        );

        // Calculate weighted median based on voting power
        proposal.result.medianWeighted = calculateWeightedMedian(
          proposal.validVotes || [],
          proposal.voterCaches || [],
          lowerBound,
          upperBound
        );

        // clean up results to not expose all single votes, only keep abstain
        if (proposal.result.results) {
          proposal.result.results = proposal.result.results.filter(result => result.id === "abstain");
          // Add a field for valid votes which are not abstain with count and votingpower
          // get votingpower for all votes which are not abstained from voter cache
          const votingPowerNoAbstain = proposal.validVotes.filter(vote => vote.submittedVote[0] !== "abstain").map(vote => vote.userId).map(userId => proposal.voterCaches.find(cache => cache.userId === userId)?.votingPower).reduce((sum, power) => sum + power, 0);
          proposal.result.results.push({
            id: "votes",
            label: "Votes",
            count: proposal.validVotes.filter(vote => vote.submittedVote[0] !== "abstain").length,
            votingPower: votingPowerNoAbstain
          });
        }


        // Clean up temporary fields used for calculation
        delete proposal.validVotes;
        delete proposal.voterCaches;
      }
    }

    // Return proposals with pagination metadata and updated filters
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
        tags: tags ? tags.split(',').map(tag => tag.trim()) : undefined,
        categories: categories ? categories.split(',').map(category => category.trim()) : undefined
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

/**
  * @route GET /api/v0/ballots/:ballotId/categories
  * @description Get all unique categories from proposals in a specific ballot
  * @access Public
  *
  * @param {string} req.params.ballotId - The ID of the ballot to get categories for
  *
  * @returns {Array} 200 - List of unique categories from proposals in the ballot
  * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
  * @returns {Object} 500 - Server error
  */
router.get("/:ballotId/categories", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();
  try {
    // Fetch all proposals for the ballot and extract unique categories
    const proposals = await Proposal.find({ ballotId: ballot._id }).select("categories");
    const categories = [...new Set(proposals.flatMap((proposal) => proposal.categories))];

    // Return the list of unique categories
    return res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching categories",
    });
  }
});

/**
 * @route GET /api/v0/ballots/:ballotId/tags
 * @description Get all unique tags from proposals in a specific ballot
 * @access Public
 *
 * @param {string} req.params.ballotId - The ID of the ballot to get tags for
 *
 * @returns {Array} 200 - List of unique tags from proposals in the ballot
 * @returns {Object} 404 - Error if ballot not found (handled by getBallot middleware)
 * @returns {Object} 500 - Server error
 */
router.get("/:ballotId/tags", getBallot, async (req, res) => {
  const ballot = req.ballot.toObject();
  try {
    // Fetch all proposals for the ballot and extract unique tags
    const proposals = await Proposal.find({ ballotId: ballot._id }).select("tags");
    const tags = [...new Set(proposals.flatMap((proposal) => proposal.tags))];

    // Return the list of unique tags
    return res.status(200).json(tags);
  } catch (error) {
    console.error("Error fetching tags:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching tags",
    });
  }
});

export default router;
