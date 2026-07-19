// express router
import { Router } from 'express';
const router = Router();

// schema import
import { Vote } from '../../../schema/Vote.js';
import { Ballot } from '../../../schema/Ballot.js';
import { User } from '../../../schema/User.js';
import { validateAddress } from '../../../helper/validateAddress.js';
import { cacheControl } from '../../../helper/cacheControl.js';
import { projectVoteEntries } from '../../../helper/voterDetailMapper.js';
import { aggregationLimiter } from '../../../helper/rateLimiters.js';

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
 * @param {string} [req.query.search=''] - Search term matched (case-insensitive substring, special regex characters escaped) against the bech32/CIP-129 userId OR the resolved display name (DRep name or Cardano handle) from the User collection. A leading `$` is stripped so users typing a handle as they see it rendered (`$adam`) still match the bare stored name (`adam`).
 * @param {string} [req.query.sort='votes'] - Sort field: 'userId', 'votes', 'lastLogin', or 'lastVoteAt' (default: 'votes')
 * @param {string} [req.query.direction='desc'] - Sort direction: 'asc' or 'desc' (default: 'desc')
 *
 * @returns {Object} 200 - Response object containing:
 *   - data: Array of voter objects, each containing:
 *     - userId: ID of the voter
 *     - votes: Number of votes cast by this voter
 *     - lastLogin: ISO 8601 timestamp of last login (null if never logged in)
 *     - lastVoteAt: ISO 8601 timestamp of the voter's most recent submitted vote (always set — every voter in the directory has at least one submitted vote)
 *     - name: Display name (drep name or Cardano handle) when resolved; null otherwise
 *   - pagination: Object with total, page, limit, totalPages
 *   OR
 *   - status: "msg"
 *   - message: "No voters found" (if no voters match criteria)
 * @returns {Object} 400 - Error if query parameters are invalid (page, limit, sort, or direction)
 * @returns {Object} 500 - Server error while fetching voter list
 */
router.get('/', aggregationLimiter, cacheControl(300), async (req, res) => {
  const {
    page = 1,
    limit = 25, // Changed default from 10 to 25 to match frontend
    search = '',
    sort = 'votes',
    direction = 'desc',
  } = req.query;

  // Validate pagination parameters
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  if (isNaN(pageNum) || pageNum < 1) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid page parameter, must be a positive integer',
    });
  }

  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid limit parameter, must be a positive integer between 1 and 100',
    });
  }

  // Validate sort parameters
  const validSortFields = ['userId', 'votes', 'lastLogin', 'lastVoteAt'];
  const validDirections = ['asc', 'desc'];

  if (!validSortFields.includes(sort)) {
    return res.status(400).json({
      status: 'error',
      message: `Invalid sort parameter, must be one of: ${validSortFields.join(', ')}`,
    });
  }

  if (!validDirections.includes(direction)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid direction parameter, must be asc or desc',
    });
  }

  try {
    // Build match conditions for filtering.
    //
    // The `userId: { $type: "string" }` guard drops two flavors of
    // garbage from the directory:
    //   1. Pre-rename Vote rows that still carry the legacy `voterId`
    //      field and no `userId` — those used to collapse into a single
    //      `{ userId: null, votes: <count> }` bucket because $group
    //      treats missing fields as null. Backfill via
    //      __scripts/backfillVoteUserId.js promotes them; this filter
    //      keeps the API honest until the script runs and after, as a
    //      defense-in-depth guard against any future regression.
    //   2. Anything else where the field was nulled out by hand.
    // `excludedAt: null` drops operator-flagged invalid votes from the
    // directory entirely — a voter only surfaces here when they cast at
    // least one *non-excluded* vote. A voter excluded from one ballot
    // still appears if they voted legitimately on a different ballot.
    let matchConditions = {
      submittedAt: { $ne: null },
      userId: { $type: 'string' },
      excludedAt: null,
    };

    // Escape special regex characters in search string
    const escapeRegex = (string) => {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    // Cardano handles are stored bare in User.name (`adam`) but the
    // frontend renders them with a leading `$` (`$adam`). Strip a
    // single leading `$` from the search input so users typing what
    // they see still match. Stripping happens BEFORE regex escape so
    // we don't quote the `$` and then "strip" something that's no
    // longer there.
    //
    // Safe for DReps whose on-chain metadata name literally includes
    // a leading `$` (e.g. a DRep deliberately tying their name to a
    // handle) because the match below is an unanchored case-insensitive
    // substring — `adam` is still contained in `$adam`, so stripping
    // can only ever widen the match set, never miss one.
    const normalizedSearch = search.startsWith('$') ? search.slice(1) : search;

    // Case-insensitive substring match. Used against `userId` AND the
    // joined `User.name` further down — see the $or stage in the
    // pipelines below. Empty string after $-stripping means the user
    // typed only `$`, treat that as "no filter".
    const searchRegex = normalizedSearch
      ? new RegExp(`${escapeRegex(normalizedSearch)}`, 'i')
      : null;

    // Stages used to filter grouped voters by `userId` OR resolved
    // `User.name`. Only built when the user actually supplied a search
    // term — for the unsearched listing we keep the original flow
    // (cheaper, no per-voter User join during count/sort).
    //
    // We can't push this filter up into the initial Vote $match: a
    // voter's NAME lives on the User collection, not on each Vote row,
    // so we have to $lookup post-$group. That's also why the join is
    // gated behind `search` — for big directories we don't want to pay
    // the per-row lookup on every list call.
    const searchStages = searchRegex
      ? [
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'userSearchData',
            },
          },
          {
            $addFields: {
              searchName: {
                $cond: {
                  if: { $gt: [{ $size: '$userSearchData' }, 0] },
                  then: { $arrayElemAt: ['$userSearchData.name', 0] },
                  else: null,
                },
              },
            },
          },
          {
            $match: {
              $or: [{ _id: searchRegex }, { searchName: searchRegex }],
            },
          },
        ]
      : [];

    // First count total unique voters with filters applied
    const countResult = await Vote.aggregate([
      {
        $match: matchConditions,
      },
      {
        $group: {
          _id: '$userId',
        },
      },
      ...searchStages,
      {
        $count: 'total',
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
          _id: '$userId',
          votes: { $sum: 1 },
          // Most recent submitted vote per voter. Free piggyback on
          // the existing $group — every Vote row is already being
          // scanned for the count. Surfaced unconditionally so
          // frontend can render the column even when sorting by
          // something else; also drives sort=lastVoteAt below.
          lastVoteAt: { $max: '$submittedAt' },
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

    // Add lookup for last login data if sorting by lastLogin.
    //
    // Joins against `users` (User._id is the bech32/CIP-129 voter id).
    // The previous implementation joined against `sessions`, but the
    // sessions collection has a 1-hour TTL (schema/Session.js:54) —
    // it's the auth-challenge handshake, not a persistent login
    // record. Voters inactive for more than an hour appeared as
    // lastLogin: null in the directory. routes/api/v0/session.js
    // upserts User.lastLogin on every successful login, so User is
    // the durable source.
    if (sort === 'lastLogin') {
      pipeline.push(
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'userData',
          },
        },
        {
          $addFields: {
            lastLogin: {
              $cond: {
                if: { $gt: [{ $size: '$userData' }, 0] },
                then: { $arrayElemAt: ['$userData.lastLogin', 0] },
                else: null,
              },
            },
            // Surface name from the same User join so the directory
            // can render "Display Name (drep1y…)" instead of just
            // the bech32. Null for voters with no User row or with
            // an unresolved name — crons/voterNameBackfill.js fills
            // those in over time.
            name: {
              $cond: {
                if: { $gt: [{ $size: '$userData' }, 0] },
                then: { $arrayElemAt: ['$userData.name', 0] },
                else: null,
              },
            },
            // Separate field for sortable handling of nulls. Voters
            // with no User row (historical voters who haven't logged in
            // since the User collection landed) sort to the epoch end
            // of whichever direction was requested.
            lastLoginSortValue: {
              $cond: {
                if: { $gt: [{ $size: '$userData' }, 0] },
                then: { $arrayElemAt: ['$userData.lastLogin', 0] },
                else: new Date(0),
              },
            },
          },
        },
      );
    }

    // Add sorting based on the requested field and direction
    const sortOrder = direction === 'asc' ? 1 : -1;

    // Create sort stage based on requested field
    if (sort === 'userId') {
      pipeline.push({ $sort: { _id: sortOrder } });
    } else if (sort === 'votes') {
      pipeline.push({ $sort: { votes: sortOrder, _id: 1 } });
    } else if (sort === 'lastLogin') {
      // Fixed sort syntax - use the pre-computed field
      pipeline.push({ $sort: { lastLoginSortValue: sortOrder, _id: 1 } });
    } else if (sort === 'lastVoteAt') {
      // lastVoteAt is always present on every grouped row (every
      // voter in the directory has at least one submittedAt by the
      // $match filter), so no null-handling field is needed — sort
      // the accumulator directly.
      pipeline.push({ $sort: { lastVoteAt: sortOrder, _id: 1 } });
    }

    // Add pagination
    pipeline.push(
      { $skip: skip },
      { $limit: limitNum },
      {
        $project: {
          _id: 0,
          userId: '$_id',
          votes: 1,
          lastLogin: 1,
          lastVoteAt: 1,
          // Only the sort=lastLogin branch populates `name` in the
          // pipeline (via the $lookup above); the other branches
          // attach it post-aggregation. Keep it in the projection
          // regardless — Mongo silently drops fields that aren't
          // present, so this is a no-op when name wasn't joined.
          name: 1,
        },
      },
    );

    const voters = await Vote.aggregate(pipeline);

    if (!voters || voters.length === 0) {
      return res.status(200).json({
        status: 'msg',
        message: 'No voters found',
      });
    }

    // Only fetch lastLogin separately if we're not already sorting by
    // it — when sort === "lastLogin" the in-pipeline $lookup above
    // already attached lastLogin to each row.
    //
    // Source is `users.lastLogin` (upserted by /api/v0/session on
    // every successful login), NOT `sessions.updatedAt`. Sessions
    // expire after 1h via TTL and represent the nonce handshake, not
    // a durable login record.
    if (sort !== 'lastLogin') {
      const userIds = voters.map((voter) => voter.userId);
      const users = await User.find({ _id: { $in: userIds } }).select('_id lastLogin name');

      const userById = new Map();
      users.forEach((u) => {
        userById.set(u._id, u);
      });

      voters.forEach((voter) => {
        const u = userById.get(voter.userId);
        voter.lastLogin = u?.lastLogin || null;
        voter.name = u?.name || null;
      });
    } else {
      // sort=lastLogin path joined User in the aggregation. Make sure
      // `name` is at least explicitly null when the join missed (the
      // $project keeps the field, but a doc without a User row never
      // had name set, so it'd be absent from JSON).
      voters.forEach((voter) => {
        if (voter.name === undefined) voter.name = null;
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
    console.error('Error fetching voter list:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error while fetching voter list',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
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
router.get('/types', cacheControl(300), async (req, res) => {
  try {
    const voters = await Vote.aggregate([
      {
        $match: { submittedVote: { $exists: true }, excludedAt: null },
      },
      {
        $group: { _id: '$userId' },
      },
    ]);

    // Extract voter types from IDs
    const voterTypes = voters.reduce((types, voter) => {
      const userId = voter._id;
      if (userId.startsWith('stake')) {
        types.stake = (types.stake || 0) + 1;
      } else if (userId.startsWith('drep')) {
        types.drep = (types.drep || 0) + 1;
      } else if (userId.startsWith('pool')) {
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
    console.error('Error fetching voter types:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Server error while fetching voter types',
    });
  }
});

/**
 * @route GET /api/v0/voters/:userId
 * @description Get detailed information about a specific voter including voting history across all ballots. Response is cached for 300 seconds. Voter ID is validated and converted to CIP129 format if applicable. A voter is considered found when they have cast at least one submitted, non-excluded vote (the same basis as the voter directory listing).
 * @access Public
 *
 * @param {string} req.params.userId - The ID of the voter to retrieve (must start with "stake", "drep", or "pool")
 *
 * @returns {Object} 200 - Voter object containing:
 *   - voterType: Type of voter ("stake", "drep", or "pool")
 *   - userId: Validated voter ID (CIP129 format if applicable)
 *   - name: Display name (drep name or Cardano handle) when resolved; null otherwise
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
 * @returns {Object} 404 - Error if the voter has cast no submitted, non-excluded votes
 * @returns {Object} 500 - Server error while fetching voter data
 */
router.get('/:userId', cacheControl(300), async (req, res) => {
  let userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({
      status: 'error',
      message: 'Voter ID is required',
    });
  }

  // Check voter ID type
  let voterType;
  if (userId.startsWith('stake')) {
    voterType = 'stake';
  } else if (userId.startsWith('drep')) {
    voterType = 'drep';
  } else if (userId.startsWith('pool')) {
    voterType = 'pool';
  } else {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid ID format: must start with stake, drep, or pool',
    });
  }

  let userIdValidated = validateAddress(userId, voterType);
  if (userIdValidated.error) {
    return res.status(400).json({
      status: 'error',
      message: userIdValidated.error,
    });
  }
  // use CIP129 from here on
  if (userIdValidated.cip129) userIdValidated = userIdValidated.cip129;

  // A voter "exists" for this endpoint when they've cast at least one
  // submitted, non-excluded vote — the SAME source of truth the
  // directory list (GET /api/v0/voters) is built from. Mirror its
  // match conditions exactly so list and detail never disagree.
  //
  // We deliberately do NOT gate on UserCache here. That collection is
  // only populated by the Hydra/v1 validation path, so legacy v0
  // ballots — which hold the bulk of historical votes — have no
  // UserCache rows, and every one of their voters (DReps key- and
  // script-based, pools, stake) would 404 on this detail view despite
  // appearing in the directory. Voting power, when a cache row does
  // exist, is still attached as optional enrichment via the $lookup
  // below (preserveNullAndEmptyArrays keeps powerless voters visible).
  const hasVotes = await Vote.exists({
    userId: userIdValidated,
    submittedAt: { $ne: null },
    excludedAt: null,
  });
  if (!hasVotes) {
    return res.status(404).json({
      status: 'error',
      message: 'Voter not found',
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

  // get votes for the voter - needs pagination at some point.
  // `excludedAt: null` hides operator-flagged invalid votes from this
  // voter's per-ballot history; ballots where every vote was excluded
  // simply don't appear, consistent with "no longer a valid voter on
  // this ballot."
  const ballots = await Vote.aggregate([
    {
      $match: {
        userId: userIdValidated,
        submittedAt: { $ne: null },
        excludedAt: null,
      },
    },
    {
      $group: {
        _id: '$ballotId',
        votes: { $push: '$$ROOT' },
      },
    },
    {
      $lookup: {
        from: 'ballots',
        localField: '_id',
        foreignField: '_id',
        as: 'ballot',
      },
    },
    {
      $unwind: '$ballot',
    },
    // Add lookup to get voting power from UserCache
    {
      $lookup: {
        from: 'usercaches',
        let: { ballotId: '$_id', voter: userIdValidated },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$ballotId', '$$ballotId'] }, { $eq: ['$userId', '$$voter'] }],
              },
            },
          },
        ],
        as: 'voterPower',
      },
    },
    {
      $unwind: {
        path: '$voterPower',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: 'proposals',
        localField: 'votes.proposalId',
        foreignField: '_id',
        as: 'proposalDetails',
      },
    },
    {
      $project: {
        _id: 1,
        votes: 1,
        ballot: 1,
        proposalDetails: 1,
        votingPower: '$voterPower.votingPower',
      },
    },
    {
      $sort: { votedAt: -1 }, // Sort by most recent votes first
    },
  ]);

  // Properly hydrate and include virtuals
  const populatedBallots = await Ballot.populate(ballots, {
    path: 'ballot',
  });

  // Process the votes to include proposal information
  const votes = populatedBallots
    .map((item) => {
      // Get the ballot with virtuals
      const ballotWithVirtuals = item.ballot.toObject({ virtuals: true });

      // Filter to only include proposals the voter has voted on
      const votedProposals = item.proposalDetails
        .map((p) => {
          const vote = item.votes.find((v) => v.proposalId?.toString() === p._id.toString());
          if (vote?.submittedVote === undefined || vote?.submittedVote === null) return null; // Skip if no vote found

          // Project per-vote-type. Likert/Weighted store object entries
          // ({ option, value }) which the previous primitive-only mapper
          // collapsed to []. See projectVoteEntries for the full shape.
          const voteEntries = projectVoteEntries(vote.submittedVote, p);

          return {
            proposalId: p._id,
            title: p.title,
            voteType: p.voteType,
            vote: voteEntries,
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

  voterData.proposalsVoted = votes.reduce((count, ballot) => count + ballot.proposals.length, 0);

  // lastVoteDate used to read `votes[0].votedAt`, but `votedAt` is
  // not a field on the projected ballot summary above (the schema
  // field is `submittedAt` on Vote, not `votedAt`), so this always
  // returned undefined / null. Query the real value directly from
  // the Vote collection — the existing { userId, submittedAt } index
  // makes this a single B-tree seek.
  const lastVote = await Vote.findOne({
    userId: userIdValidated,
    submittedAt: { $ne: null },
    excludedAt: null,
  })
    .sort({ submittedAt: -1 })
    .select('submittedAt')
    .lean();
  voterData.lastVoteDate = lastVote?.submittedAt || null;

  // Last login + display name come from the User collection (durable,
  // upserted on every successful /api/v0/session PUT, and topped up
  // for historical voters by crons/voterNameBackfill.js). The Sessions
  // collection TTLs after 1 hour and was returning null for anyone
  // inactive since the request window — that wasn't a "never logged
  // in" signal, it was a "session record already expired" signal.
  const user = await User.findById(userIdValidated).select('lastLogin name');
  voterData.lastLogin = user?.lastLogin || null;
  voterData.name = user?.name || null;

  // Return the voter data
  return res.status(200).json(voterData);
});

export default router;
