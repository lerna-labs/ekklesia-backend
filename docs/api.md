# Ekklesia Voting Backend API

**Document version:** 1.1.0  
**API version:** 0.5.33  
**Last updated:** 2026-02-26

This document describes the REST API for the Ekklesia voting backend: endpoints, authentication, rate limits, request/response shapes, and search parameters. The machine-readable specification is in [openapi.yaml](./openapi.yaml).

---

## Table of contents

1. [Base URLs and paths](#1-base-urls-and-paths)
2. [Authentication](#2-authentication)
3. [Rate limits](#3-rate-limits)
4. [Common responses and shapes](#4-common-responses-and-shapes)
5. [Status & health](#5-status--health)
6. [Ballots](#6-ballots)
7. [Proposals](#7-proposals)
8. [Votes](#8-votes)
9. [Comments](#9-comments)
10. [Session](#10-session)
11. [Dashboard](#11-dashboard)
12. [Transactions](#12-transactions)
13. [Voters](#13-voters)
14. [FAQs](#14-faqs)
15. [Data models (summary)](#15-data-models-summary)
16. [Changelog](#16-changelog)

---

## 1. Base URLs and paths

| Environment | Base URL | Notes |
|-------------|----------|--------|
| Local      | `http://localhost:3000` | Health at root; API under `/api/v0` |
| Production | `https://api.example.com` | Replace with actual host |

- **Health/status:** Mounted at **server root** (e.g. `GET /health`, `GET /health/health`, `GET /health/db`).
- **REST API:** All other endpoints are under **`/api/v0`** (e.g. `GET /api/v0/ballots`, `POST /api/v0/session`).

---

## 2. Authentication

- **Methods:** HTTP-only cookie `token` or `Authorization: Bearer <JWT>`.
- **Obtaining a token:** Use [Session](#10-session): POST to request a nonce, then PUT with signature to receive the JWT (and cookie).
- **Protected routes:** Require a valid JWT; otherwise respond with `401 Unauthorized`.
- **Session types:** One set of session endpoints supports both **standard** (single signer) and **multisig** (script address); for multisig, include `scriptAddress` in the body.

---

## 3. Rate limits

| Endpoint | Limit | Window | Response when exceeded |
|----------|--------|--------|-------------------------|
| `POST /api/v0/session` (nonce) | 5 requests | 1 minute per IP | `429` body: `{ "status": "error", "message": "Too many nonce requests. Please try again later." }` |
| `PUT /api/v0/session` (verify) | 10 requests | 1 minute per IP | `429` body: `{ "status": "error", "message": "Too many authentication attempts. Please try again later." }` |

Standard `RateLimit-*` headers are sent when applicable. No other endpoints are rate-limited in the current implementation.

---

## 4. Common responses and shapes

### Pagination

Paginated list responses include a `pagination` object:

| Field       | Type    | Description                          |
|------------|---------|--------------------------------------|
| `total`    | integer | Total items matching the query       |
| `page`     | integer | Current page (1-based)              |
| `limit`    | integer | Page size (max 100)                  |
| `totalPages` | integer | Total number of pages             |

### Error responses

| Status | Meaning   | Body shape (typical)                |
|--------|-----------|-------------------------------------|
| `400`  | Bad request | `{ "status": "error", "message": "..." }` |
| `401`  | Unauthorized | `{ "status": "error", "message": "Unauthorized" }` or similar |
| `403`  | Forbidden | `{ "status": "error", "message": "..." }` |
| `404`  | Not found | `{ "status": "error", "message": "..." }` |
| `500`  | Server error | `{ "status": "error", "message": "..." }` |

---

## 5. Status & health

Base path: **server root** (e.g. `http://localhost:3000`).

### GET /health

Full system status (uptime, versions, database, network).

**Auth:** None.

**Response `200`:** JSON object (StatusResponse):

| Field        | Type   | Description                    |
|-------------|--------|--------------------------------|
| `status`    | string | e.g. `"operational"`           |
| `message`   | string | Human-readable status          |
| `timestamp` | string | ISO 8601                       |
| `environment` | string | e.g. development, production |
| `network`   | string | Blockchain network name        |
| `networkId` | number | Network ID                     |
| `server`    | object | `uptime`, `uptimeSeconds`, `version`, `nodeVersion`, `memoryUsage` (rss, heapTotal, heapUsed) |
| `frontend`  | string | Frontend version if available   |
| `database`  | object | `status` ("connected" \| "disconnected"), `message` |

---

### GET /health/health

Simple liveness check for load balancers.

**Auth:** None.

**Response `200`:** `{ "status": "healthy" }`

---

### GET /health/db

Database connection status.

**Auth:** None.

**Response `200`:**

| Field     | Type   | Description        |
|----------|--------|--------------------|
| `status` | string | `"connected"` \| `"disconnected"` |
| `message` | string | Human-readable message |

---

## 6. Ballots

Base path: **/api/v0/ballots**

### GET /api/v0/ballots

List ballots with pagination and filters.

**Auth:** Optional (adds voter-specific fields when present).

**Query parameters:**

| Name       | Type   | Default | Description                          |
|------------|--------|---------|--------------------------------------|
| `voterType`| string | —       | Filter by voter type                  |
| `status`   | string | —       | `live` \| `closed` \| `upcoming`     |
| `search`   | string | —       | Search ballot title or ID (1–100 chars) |
| `page`     | integer| 1       | Page number                          |
| `limit`    | integer| 10      | Page size (1–100)                    |

**Response `200`:**

- `data`: array of [Ballot](#ballot) objects  
- `pagination`: [Pagination](#pagination)

---

### GET /api/v0/ballots/voterTypes

List unique voter types across all ballots.

**Auth:** None.

**Response `200`:** Array of strings (e.g. `["stake","drep","pool"]`).

---

### GET /api/v0/ballots/:ballotId

Get a single ballot by ID. If authenticated, includes voter validation and voting power.

**Auth:** Optional.

**Path:** `ballotId` — ballot ID (string).

**Response `200`:** [Ballot](#ballot) plus when authenticated:

- `voterValidated` (boolean)
- `votingPower` (number)
- `totalAllowedVoterCount` (number)
- `totalVotingPower` (number)

**Response `404`:** Ballot not found.

---

### GET /api/v0/ballots/:ballotId/proposals

List proposals for a ballot with sorting and filters.

**Auth:** Optional.

**Path:** `ballotId` — ballot ID.

**Query parameters:**

| Name        | Type   | Default | Description                                      |
|-------------|--------|---------|--------------------------------------------------|
| `page`      | integer| 1       | Page number                                      |
| `limit`     | integer| 10      | Page size (1–100)                                |
| `search`    | string | —       | Search proposal title or ID                      |
| `sort`      | string | _id     | `title` \| `commentCount` \| `voteCount`         |
| `direction` | string | desc    | `asc` \| `desc`                                  |
| `hasVoted`  | string | —       | `"true"` \| `"false"` (only when authenticated)  |
| `tags`      | string | —       | Comma-separated tags                             |
| `categories`| string | —       | Comma-separated categories                       |

**Response `200`:**

- `data`: array of [Proposal](#proposal)
- `pagination`: [Pagination](#pagination)
- `sort`: `{ "field", "direction" }`
- `filters`: applied filters

---

### GET /api/v0/ballots/:ballotId/categories

Unique categories for proposals in the ballot.

**Auth:** None.

**Path:** `ballotId` — ballot ID.

**Response `200`:** Array of strings.

---

### GET /api/v0/ballots/:ballotId/tags

Unique tags for proposals in the ballot.

**Auth:** None.

**Path:** `ballotId` — ballot ID.

**Response `200`:** Array of strings.

---

## 7. Proposals

Base path: **/api/v0/proposals**

### GET /api/v0/proposals/:proposalId

Get a proposal by ID with voting stats and, when authenticated, the user’s vote.

**Auth:** Optional.

**Path:** `proposalId` — proposal ID.

**Response `200`:** [Proposal](#proposal) plus:

- `voterVote`: array of vote option IDs or `null`
- `ballotStatus`: string
- `results`: object or null
- `totalVotes`, `totalVoterCount`, `totalVotingPower`: numbers

---

### GET /api/v0/proposals/:proposalId/comments

List comments for a proposal (by creation date).

**Auth:** None.

**Path:** `proposalId` — proposal ID.

**Response `200`:** Array of [Comment](#comment).

---

### GET /api/v0/proposals/:proposalId/results

Voting results for the proposal (counts and voting power per option).

**Auth:** None.

**Path:** `proposalId` — proposal ID.

**Response `200`:** Proposal-like object with:

- `results`: array of `{ value, label, count, votingPower }`
- `totalVotes`: number

---

### GET /api/v0/proposals/:proposalId/results/grouped

Results broken down by voter group. Uses stored data when available, otherwise computed on the fly.

**Auth:** None.

**Path:** `proposalId` — proposal ID.

**Response `200`:**

- `proposalId`: string
- `groups`: object — keys are group names; each value has `results` (array of `{ value, label, count, votingPower }`) and `totalVotes`

---

### GET /api/v0/proposals/:proposalId/short

Short form of the proposal (minimal fields).

**Auth:** None.

**Path:** `proposalId` — proposal ID.

**Response `200`:** [Proposal](#proposal) (reduced fields).

---

## 8. Votes

Base path: **/api/v0/vote**

### POST /api/v0/vote/:proposalId

Submit or update a vote on a proposal.

**Auth:** Required (cookie or Bearer).

**Path:** `proposalId` — proposal ID.

**Body (JSON):**

| Field | Type   | Required | Description                                  |
|-------|--------|----------|----------------------------------------------|
| `vote`| array  | yes      | Vote option IDs (numbers) and/or `"abstain"`; min length 1 |

**Response `200`:** [Vote](#vote) plus `changes` (boolean) if the vote was updated.

**Responses:** `400`, `401`, `403`, `404`, `500` as applicable.

---

## 9. Comments

Base path: **/api/v0/comments**

Comments support top-level posts and replies (`parentId`). They can be **live** or **withdrawnByAdmin**. Responses include `replyCount`, `likeCount`, and when authenticated `userLiked`. Author info is returned as `author` (with `type`: proposer, admin, drep, user). Comments can only be created on live proposals before the vote’s `feedbackEndDate`.

**Alternative:** `GET /api/v0/proposals/:proposalId/comments` returns a simple list of comments for that proposal (see [Proposals](#7-proposals)).

---

### GET /api/v0/comments

Paginated top-level comments for a proposal.

**Auth:** Optional (adds `userLiked` when present). Admins can filter by status.

**Query parameters:**

| Name       | Type   | Required | Default | Description |
|------------|--------|----------|---------|-------------|
| `proposal` | string | yes      | —       | Proposal ID (ObjectId) |
| `status`   | string | no       | —       | `live` \| `withdrawn` \| `withdrawnByAdmin` (admins only) |
| `sort`     | string | no       | date    | `date` \| `replyCount` \| `likeCount` |
| `direction`| string | no       | desc    | `asc` \| `desc` |
| `userType` | string | no       | —       | Filter by author type: comma-separated `proposer`, `admin`, `drep` |
| `page`     | integer| no       | 1       | Page number |
| `limit`    | integer| no       | 10      | Page size (1–100) |

**Response `200`:**

- `data`: array of [CommentResponse](#commentresponse) objects
- `meta`: `{ page, limit, total, totalPages, hasNextPage, hasPreviousPage }`

**Responses:** `400`, `404`, `500`.

---

### POST /api/v0/comments

Create a comment (or reply) on a live proposal.

**Auth:** Required.

**Body (JSON):**

| Field       | Type   | Required | Description |
|------------|--------|----------|-------------|
| `proposalId` | string | yes    | Proposal ID |
| `content`  | string | yes      | Comment content (max 2000 chars) |
| `parentId` | string | no       | Parent comment ID for replies |

**Response `201`:** [Comment](#comment) (raw document with `proposalId`, `parentId`, `userId`, `content`, `status`, `createdAt`, `updatedAt`).

**Responses:** `400`, `401`, `404`, `500`.

---

### GET /api/v0/comments/:commentId

Get a single comment by ID. Public users see only live comments; author sees own in any status; admins can filter by status.

**Auth:** Optional.

**Path:** `commentId` — comment ObjectId.

**Query:** `status` (optional; admins only).

**Response `200`:** [CommentResponse](#commentresponse) (includes `author`, `replyCount`, `likeCount`, `userLiked`, and `withdrawalDetails` when applicable).

**Responses:** `400`, `404`, `500`.

---

### PUT /api/v0/comments/:commentId

Update comment content. **Author only;** allowed only within **15 minutes** of creation.

**Auth:** Required.

**Path:** `commentId` — comment ObjectId.

**Body (JSON):** `content` (string, required, max 2000).

**Response `200`:** [Comment](#comment) (updated document).

**Responses:** `400`, `401`, `403`, `404`, `500`.

---

### GET /api/v0/comments/:commentId/replies

Paginated replies to a comment. Parent must exist and be live. Sorted by `createdAt` ascending.

**Auth:** Optional.

**Path:** `commentId` — parent comment ObjectId.

**Query:** `status`, `page` (default 1), `limit` (default 10, max 100).

**Response `200`:**

- `data`: array of [CommentResponse](#commentresponse)
- `meta`: `{ page, limit, total, totalPages, hasNextPage, hasPreviousPage }`

**Responses:** `400`, `404`, `500`.

---

### POST /api/v0/comments/:commentId/like

Toggle like on a comment. **Live comments only;** before the vote’s `feedbackEndDate`.

**Auth:** Required.

**Path:** `commentId` — comment ObjectId.

**Response `201`** (like added): `{ "status": "success", "message": "Comment liked.", "liked": true, "likeCount": number }`

**Response `200`** (like removed): `{ "status": "success", "message": "Like removed.", "liked": false, "likeCount": number }`

**Responses:** `400`, `401`, `404`, `500`.

---

### PUT /api/v0/comments/:commentId/withdraw

Withdraw a live comment (vote **admin** only). Allowed until the vote’s `feedbackEndDate`.

**Auth:** Required (must be in proposal’s vote admins).

**Path:** `commentId` — comment ObjectId.

**Body (JSON):**

| Field     | Type   | Required | Description |
|----------|--------|----------|-------------|
| `category` | string | yes    | One of: `Inappropriate content`, `Spam`, `Policy violation`, `Duplicate`, `Other` |
| `comment`  | string | no     | Optional reason note |

**Response `200`:** [Comment](#comment) with `status: "withdrawnByAdmin"` and `withdrawalDetails`.

**Responses:** `400`, `401`, `403`, `404`, `500`.

---

## 10. Session

Base path: **/api/v0/session**

Unified endpoints for standard and multisig auth. For multisig, include `scriptAddress` in the body where noted. [Rate limits](#3-rate-limits) apply to POST and PUT.

### GET /api/v0/session

Validate the current session and return user identity and profile.

**Auth:** Required.

**Response `200`:**

| Field      | Type   | Description                    |
|------------|--------|--------------------------------|
| `userId`   | string | Required; authenticated user ID |
| `name`     | string | Optional; DRep name or handle  |
| `lastLogin`| string | Optional; ISO 8601             |

**Response `401`:** Unauthorized.

---

### POST /api/v0/session

Request a nonce for signing (standard or multisig). **Rate limit: 5 req/min per IP.**

**Auth:** None.

**Body (JSON):**

| Field          | Type   | Required | Description                                      |
|----------------|--------|----------|--------------------------------------------------|
| `signerAddress`| string | yes      | Signer address                                   |
| `signType`     | string | yes      | e.g. `drep`, `stake`, `pool`                     |
| `scriptAddress`| string | no       | For multisig; CIP129 script address (identity)   |

**Response `200`:**

| Field            | Type   | Description                                |
|------------------|--------|--------------------------------------------|
| `dataHex`        | string | Nonce to sign (hex)                        |
| `userId`         | string | Signer address or script address (multisig)|
| `userIdHex`      | string | —                                          |
| `signerAddressHex` | string | —                                       |
| `calidusID`      | string | Optional; for pool signers                 |
| `scriptAddress`  | string | Present only for multisig                  |

**Responses:** `400`, `403`.

---

### PUT /api/v0/session

Verify signature and log in (issue JWT and set cookie). **Rate limit: 10 req/min per IP.**

**Auth:** None.

**Body (JSON):**

| Field          | Type   | Required | Description                    |
|----------------|--------|----------|--------------------------------|
| `signerAddress`| string | yes      | Signer address                 |
| `signType`     | string | yes      | Signature type                 |
| `signature`    | object | yes      | Signature payload (see [Signature](#signature)) |
| `scriptAddress`| string | no       | For multisig only              |

**Response `200`:**

- `token`: string (JWT)
- `expiresIn`: string (date-time)
- `userId`: string

**Response `400`:** Bad request (e.g. invalid signature).

---

### DELETE /api/v0/session

Log out (clear auth cookie).

**Auth:** Required.

**Response `200`:** `{ "status": "success", "message": "Logged out successfully" }`

**Response `401`:** Unauthorized.

---

## 11. Dashboard

Base path: **/api/v0/dashboard**

All dashboard endpoints require authentication.

### GET /api/v0/dashboard

Current user’s dashboard summary.

**Response `200`:**

| Field              | Type    | Description                    |
|--------------------|---------|--------------------------------|
| `userId`           | string  | Authenticated user ID          |
| `lastLogin`        | string  | ISO 8601 or null              |
| `multiSig`         | boolean | Whether auth is multisig       |
| `pendingVotesCount`| number  | Pending (unsubmitted) votes    |

---

### GET /api/v0/dashboard/ballots

Ballots the user can vote on or has already voted on, with voting power.

**Response `200`:** Array of [Ballot](#ballot) objects, each possibly with `votingPower`.

---

### GET /api/v0/dashboard/pending

Pending (unsubmitted) votes for the user.

**Response `200`:** Either `{ "message": "no pending votes" }` or an array of [Vote](#vote) objects.

---

### POST /api/v0/dashboard/:ballotId/checkout

Request checkout for a ballot (create transaction data for signing).

**Path:** `ballotId` — ballot ID.

**Body (JSON):** `signerAddress` (string), `signType` (string).

**Response `200`:** [TransactionResponse](#transactionresponse).

**Responses:** `400`, `401`, `404`.

---

### PUT /api/v0/dashboard/:ballotId/checkout

Submit a signed transaction to finalize votes.

**Path:** `ballotId` — ballot ID.

**Body (JSON):** `signerAddress`, `signType`, `data` (merkle root string), `signature` (object).

**Response `200`:** `{ "status": "ok", "message": "Votes submitted", "transaction": "<transactionId>" }`

**Responses:** `400`, `401`, `404`.

---

### POST /api/v0/dashboard/:ballotId/checkout/multisig

Request multisig checkout (create or get transaction).

**Path:** `ballotId` — ballot ID.

**Body (JSON):** `scriptAddress`, `signerAddress`, `signType`.

**Response `200`:** [TransactionResponse](#transactionresponse).

---

### PUT /api/v0/dashboard/:ballotId/checkout/multisig

Submit a multisig signature. If the script is satisfied, votes are finalized.

**Path:** `ballotId` — ballot ID.

**Body (JSON):** `signerAddress`, `signType`, `scriptAddress`, `data`, `signature`.

**Response `200`:** Either  
- `{ "status": "info", "message": "MultiSig not complete yet" }` or  
- `{ "status": "ok", "message": "Votes submitted", "transaction": "<id>" }`

**Responses:** `400`, `401`, `403`, `404`.

---

### POST /api/v0/dashboard/:ballotId/checkout/multisig/:transactionId

Get an existing pending multisig transaction by ID.

**Path:** `ballotId`, `transactionId`.

**Body (JSON):** `scriptAddress`, `signerAddress`, `signType`.

**Response `200`:** [TransactionResponse](#transactionresponse).

**Responses:** `400`, `401`, `404`.

---

## 12. Transactions

Base path: **/api/v0/transactions**

All require authentication.

### GET /api/v0/transactions

List the authenticated user’s transactions (newest first).

**Response `200`:** Array of [Transaction](#transaction).

---

### GET /api/v0/transactions/:transactionId

Get a single transaction by ID.

**Path:** `transactionId` — transaction ID.

**Response `200`:** [Transaction](#transaction).

**Response `404`:** Not found.

---

## 13. Voters

Base path: **/api/v0/voters**

### GET /api/v0/voters

Paginated list of voters with optional search and sort.

**Auth:** None.

**Query parameters:**

| Name       | Type   | Default | Description                |
|------------|--------|---------|----------------------------|
| `page`     | integer| 1       | Page number                |
| `limit`    | integer| 25      | Page size (1–100)          |
| `search`   | string | —       | Search by userId           |
| `sort`     | string | votes   | `userId` \| `votes` \| `lastLogin` |
| `direction`| string | desc    | `asc` \| `desc`            |

**Response `200`:** Either  
- `{ "status": "msg", "message": "No voters found" }` or  
- `data`: array of `{ userId, votes, lastLogin }`, plus `pagination`.

---

### GET /api/v0/voters/types

Counts per voter type (stake, drep, pool).

**Auth:** None.

**Response `200`:** Array of `{ type: "stake"|"drep"|"pool", count: number }`.

---

### GET /api/v0/voters/:userId

Detailed voter info and voting history.

**Auth:** None.

**Path:** `userId` — user/voter ID (must start with stake, drep, or pool).

**Response `200`:** Object with e.g. `voterType`, `userId`, `votes` (array of ballot/vote details), `ballotsVoted`, `proposalsVoted`, `lastVoteDate`, `lastLogin`.

**Responses:** `400`, `404`, `500`.

---

## 14. FAQs

Base path: **/api/v0/faqs**

### GET /api/v0/faqs

List live FAQs with optional search and filters.

**Auth:** None.

**Query parameters:**

| Name     | Type   | Description                          |
|----------|--------|--------------------------------------|
| `search` | string | Search title or content (1–100 chars)|
| `tags`   | string | Comma-separated (e.g. `voter,proposer`) |
| `featured` | string | `"true"` \| `"false"`              |

**Response `200`:** Array of [FAQ](#faq).

**Responses:** `400`, `500`.

---

## 15. Data models (summary)

### Ballot

`_id`, `title`, `description`, `ipfsHash`, `voterType`, `voterDescription`, `votePeriodStart`, `votePeriodEnd`, `voteFilters`, `voteWeighted`, `proposalPeriodStart`, `proposalPeriodEnd`, `resultTxHash`, `status` (live \| closed \| upcoming), `createdAt`, `updatedAt`.

### Proposal

`_id`, `ballotId`, `ipfsHash`, `title`, `description`, `categories`, `tags`, `data`, `voteType` (choice \| multi-choice \| budget \| weighted \| ranked \| scale \| likert), `voteIncrement`, `voterBudget`, `minSelections`, `maxSelections`, `requireAnswer`, `voteOptions` (array of `{ id, label, cost?, description?, referenceUrl?, imageUrl?, metadata? }`), `commentCount`, `voteCount`, `votingPower`, `result`, `createdAt`, `updatedAt`.

### Vote

`_id`, `userId`, `ballotId`, `proposalId`, `vote` (array), `submittedVote` (array or null), `submittedAt`, `createdAt`, `updatedAt`.

### Comment

`_id`, `proposalId`, `parentId` (null for top-level), `userId`, `content` (max 2000), `status` (live \| withdrawnByAdmin), `withdrawalDetails` (optional; category, userId, comment, date), `createdAt`, `updatedAt`.

### CommentResponse

As returned by list/get: `_id`, `parentId`, `content`, `createdAt`, `updatedAt`, `replyCount`, `likeCount`, `userLiked`, `author` (object with _id, name, type: proposer \| admin \| drep \| user), and optionally `withdrawalDetails`.

### CommentLike

`_id`, `commentId`, `userId`. One like per user per comment (unique on commentId + userId). Used for like counts and toggle.

### Transaction

`_id`, `userId`, `ballotId`, `merkleRoot`, `votes` (object keyed by proposalId), `txHash`, `status` (created \| pending \| submitted), `signature`, `multiSig`, `createdAt`, `updatedAt`.

### TransactionResponse

Returned by checkout endpoints: `_id`, `userId`, `ballotId`, `merkleRoot`, `votes`, `dataHex`, `userIdHex`, `calidusID` (optional).

### Signature

Opaque object; structure depends on sign type (drep, stake, pool). Used in session verify and checkout payloads.

### FAQ

`_id`, `title`, `content`, `tags` (array). Only FAQs with `is_live: true` are returned.

### Pagination

`total`, `page`, `limit`, `totalPages`.

---

## 16. Changelog

| Version | Date       | Changes |
|---------|------------|--------|
| 1.0.0   | 2026-02-26 | Initial comprehensive API doc: all endpoints, rate limits, params, return objects; versioning and TOC. |
| 1.1.0   | 2026-02-26 | Comments: new /comments routes (list, create, get, update, replies, like, withdraw); Comment and CommentLike schemas; CommentResponse shape. |

For API version history, see [openapi.yaml](./openapi.yaml) `info.version`.
