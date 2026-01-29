// express router
import { Router } from "express";
const router = Router();

// schema import
import { FAQ } from "../../../schema/FAQ.js";

// helper
import { cacheControl } from "../../../helper/cacheControl.js";
import validator from "validator";

/**
 * @route GET /api/v0/faqs
 * @description Get all live FAQs (is_live=true) with search and filtering capabilities. Results are sorted by featured status (featured first), then by creation date. Only FAQs with is_live=true are returned.
 * @access Public
 *
 * @param {Object} req.query
 * @param {string} [req.query.search] - Search term for FAQ title or content (1-100 characters, sanitized, case-insensitive regex match)
 * @param {string} [req.query.tags] - Filter by tags (comma-separated, e.g., 'voter,proposer'). FAQs must have at least one matching tag.
 * @param {string} [req.query.featured] - Filter by featured status: 'true' or 'false' (case-insensitive)
 *
 * @returns {Array} 200 - Array of FAQ objects matching the search and filter criteria, each containing:
 *   - _id: MongoDB ObjectId of the FAQ
 *   - title: Title/question text of the FAQ
 *   - content: Answer content of the FAQ
 *   - tags: Array of tag strings
 *   Note: is_live, createdAt, updatedAt, and featured fields are excluded from response
 * @returns {Object} 400 - Error if:
 *   - Search term is not between 1 and 100 characters
 *   - Search contains invalid characters ($, {, })
 *   - Tags parameter is empty after parsing
 *   - Featured parameter is not 'true' or 'false'
 * @returns {Object} 500 - Server error while fetching FAQs
 */
router.get("/", async (req, res) => {
  const { search, tags, featured } = req.query;
  let matchStage = {
    is_live: true, // Only return live FAQs
  };

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

    // Sanitize search input
    const searchQuery = validator.escape(search);

    // Create search criteria that matches either title or content
    matchStage.$or = [
      { title: { $regex: new RegExp(searchQuery, "i") } },
      { content: { $regex: new RegExp(searchQuery, "i") } },
    ];
  }

  // Validate and add tags filter if provided
  if (tags) {
    const tagsList = tags.split(",").map((tag) => tag.trim()).filter(Boolean);

    if (tagsList.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid tags parameter, must provide at least one tag",
      });
    }

    // Filter FAQs that have at least one of the specified tags
    matchStage.tags = { $in: tagsList };
  }

  // Validate and add featured filter if provided
  if (featured !== undefined) {
    if (!["true", "false"].includes(featured.toLowerCase())) {
      return res.status(400).json({
        status: "error",
        message: "Invalid featured parameter, must be 'true' or 'false'",
      });
    }
    matchStage.featured = featured.toLowerCase() === "true";
  }

  try {
    // Fetch FAQs from the database, excluding is_live from the response
    const faqs = await FAQ.find(matchStage)
      .select("-is_live -createdAt -updatedAt -featured")
      .sort({ featured: -1 });

    // Return the list of FAQs
    return res.status(200).json(faqs);
  } catch (error) {
    console.error("Error fetching FAQs:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while fetching FAQs",
    });
  }
});

export default router;
