// GET /api/v1/ballots — unified listing across all ballot sources.
//
// Accepts the same query shape as /api/v0/ballots for frontend parity, plus
// an optional `source` filter to restrict to a single adapter. Each returned
// row carries a `source` discriminator so the frontend can render conditionally.

import { Router } from "express";
import validator from "validator";
import mongoose from "mongoose";
import { listUnified, getUnified } from "../../../helper/ballotAdapters/index.js";

const router = Router();

/**
 * State-aware cache TTL (seconds). Results are served separately via
 * /api/v1/results/*, so a ballot's definition is effectively static for
 * its lifetime — the main reason to invalidate is a status transition
 * (upcoming → live → closed) or admin metadata changes.
 */
function ballotMaxAge(status) {
  switch (status) {
    case "closed": return 3600;   // 1h — changes are extremely rare
    case "live":   return 120;    // 2m — rolling status + window fields matter
    case "upcoming":
    default:       return 30;     // 30s — admin may still be editing
  }
}

function applyBallotCache(res, doc) {
  if (!doc) {
    res.set("Cache-Control", "no-store");
    return;
  }
  const maxAge = ballotMaxAge(doc.status);
  res.set("Cache-Control", `public, max-age=${maxAge}`);
}

router.get("/", async (req, res) => {
  const { voterType, status, search, page = 1, limit = 10, source } = req.query;

  const filter = {};

  if (search) {
    if (!validator.isLength(search, { min: 1, max: 100 })) {
      return res.status(400).json({
        status: "error",
        message: "Search term must be between 1 and 100 characters",
      });
    }
    if (["$", "{", "}"].some((c) => search.includes(c))) {
      return res.status(400).json({
        status: "error",
        message: "Search contains invalid characters",
      });
    }
    const escaped = validator.escape(search);
    filter.$or = [{ title: { $regex: new RegExp(escaped, "i") } }];
    if (validator.isMongoId(search)) {
      filter.$or.push({ _id: new mongoose.Types.ObjectId(search) });
    }
  }

  if (voterType) {
    if (!validator.isAlphanumeric(voterType)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid voterType format",
      });
    }
    filter.voterType = { $regex: new RegExp(`^${voterType}$`, "i") };
  }

  if (status) {
    if (!["live", "closed", "upcoming"].includes(status.toLowerCase())) {
      return res.status(400).json({
        status: "error",
        message: "Invalid status parameter, must be 'live', 'closed', or 'upcoming'",
      });
    }
    filter.status = status.toLowerCase();
  }

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
      message: "Invalid limit parameter, must be a positive integer between 1 and 100",
    });
  }

  if (source && !["legacy", "hydra"].includes(source)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid source parameter, must be 'legacy' or 'hydra'",
    });
  }

  try {
    const result = await listUnified({
      filter,
      page: pageNum,
      limit: limitNum,
      source,
    });
    // Listing cache: 60s — long enough to matter, short enough that a new
    // ballot or status flip lands reasonably quickly.
    res.set("Cache-Control", "public, max-age=60");
    return res.status(200).json({ data: result.items, pagination: result.pagination });
  } catch (error) {
    console.error("Error fetching unified ballots:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching ballots",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const doc = await getUnified(req.params.id);
    if (!doc) {
      return res.status(404).json({ status: "error", message: "Ballot not found" });
    }
    applyBallotCache(res, doc);
    return res.status(200).json({ data: doc });
  } catch (error) {
    console.error("Error fetching ballot:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching ballot",
    });
  }
});

export default router;
