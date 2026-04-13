// Middleware that freezes writes to the legacy /api/v0 ballot surface.
// Reads remain available for archival rendering. Non-ballot v0 features
// (session, comments, FAQs) are not frozen — those stay live on v0.
//
// Hydra-backed writes land under /api/v1.

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Resource prefixes that are now owned by Hydra/v1. Anything else under /api/v0
// (/session, /comments, /faqs) passes through unchanged.
const FROZEN_PREFIXES = [
  "/ballots",
  "/proposals",
  "/vote",
  "/votes",
  "/voters",
  "/transactions",
  "/dashboard",
];

export function v0Freeze(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();

  const frozen = FROZEN_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
  );
  if (!frozen) return next();

  return res.status(410).json({
    error: "Endpoint moved to /api/v1",
    message:
      "Ballot, proposal, vote, and voter mutations are now served under /api/v1. " +
      "Legacy /api/v0 remains read-only for archival data.",
    migration: "https://docs.ekklesia.vote/api/",
  });
}
