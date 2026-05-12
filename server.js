import express from "express";
import helmet from "helmet";
import { loadRoutes } from "./helper/loadRoutes.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cors from "cors";
import { initializeConsole } from "./helper/consoleManager.js";
import { loadEnvironmentVariables } from "./helper/envLoader.js";
import { loadLocalOverrides } from "./helper/envOverlay.js";
import {
  connectToDatabase,
  isDatabaseConnected,
  checkDatabaseConnectionMW,
} from "./helper/dbManager.js";
import cookieParser from "cookie-parser";
import { v0Freeze } from "./helper/v0Freeze.js";
import { normalizeQuery } from "./helper/normalizeQuery.js";
import { publicGetLimiter } from "./helper/rateLimiters.js";
import { createOgMetaMiddleware } from "./helper/og/ogMeta.js";
import { ogBallotImage, ogProposalImage } from "./helper/og/ogImage.js";

// Initialize console with timestamps
initializeConsole();

// Load environment variables. The base file (.env.${NODE_ENV}) is loaded
// first; .env.local then overlays host-owned overrides on top so local
// edits survive when the docs docker-compose rewrites .env.development.
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  loadEnvironmentVariables(__dirname);
  loadLocalOverrides(__dirname);
} catch (error) {
  console.warn(`Error loading environment variables: ${error.message}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// JWT secret entropy floor. HS256 with a sub-256-bit secret is brute-
// forceable in minutes; refuse to start so a weak or empty value cannot
// ship to production unnoticed. Generate with `openssl rand -hex 32`.
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET must be configured");
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error(
    "JWT_SECRET must be at least 32 characters (use `openssl rand -hex 32`)"
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

// Security headers + server-stack disclosure. Helmet defaults cover
// X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS, and
// removal of X-Powered-By. CSP is left disabled here because the SPA
// build emits inline scripts; enable it after building a per-build
// nonce/hash policy or running Content-Security-Policy-Report-Only.
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Middleware
// Extended query parser so `?filter[key]=value` nests into
// req.query.filter.key — Express 5's default "simple" parser leaves
// those keys as literal strings.
app.set("query parser", "extended");
app.use(express.json()); // json parser
app.use(express.urlencoded({ extended: true })); // urlencoded parser
app.use(cookieParser()); // cookie parser
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true, // Important for cookies
  })
);
app.use("/api", checkDatabaseConnectionMW); // Check database connection for all API routes
// Per-IP rate cap on the entire /api surface — anonymous reads are
// otherwise free, and the aggregation-heavy routes (proposals listing,
// results, voters) can saturate the connection pool from one shell
// loop. Mounted before normalizeQuery so a stream of malformed-query
// 400s is also throttled.
app.use("/api", publicGetLimiter);
// Reject array/object-shaped values on known scalar query keys. Without
// this, an extended-parser request like `?status[$ne]=null` lands in
// route handlers as an object and crashes on `.toLowerCase()` (or
// worse — leaks an unbounded query into Mongo). See helper/normalizeQuery.js.
app.use("/api", normalizeQuery);
app.use("/api/v0", v0Freeze); // Return 410 for legacy-ballot write endpoints; reads pass through

// Start server
async function startServer() {
  try {
    // Try to connect to MongoDB but don't fail if connection isn't established
    await connectToDatabase();

    // Load all routes from the routes directory
    await loadRoutes(join(__dirname, "routes"), app);

    // Serve static files from the public directory (SvelteKit assets)
    app.use(express.static(join(__dirname, "public")));

    // Per-ballot / per-proposal OpenGraph cards. Slots between
    // express.static (so /social.png and other shipped assets keep their
    // fast path) and the SPA fallback (so unmatched URLs still serve
    // the generic SPA). Gated on OG_CARDS_ENABLED — leave unset to
    // preserve the legacy single-card behavior.
    if (process.env.OG_CARDS_ENABLED === "true") {
      app.get("/og/ballot/:ballotId.png", ogBallotImage);
      app.get("/og/proposal/:proposalId.png", ogProposalImage);

      const ogMeta = createOgMetaMiddleware({
        indexHtmlPath: join(__dirname, "public", "index.html"),
      });
      app.get(
        [
          "/ballots/:ballotId",
          "/ballots/:ballotId/proposals",
          "/ballots/:ballotId/proposals/:proposalId",
          "/ballots/:ballotId/proposals/:proposalId/results",
        ],
        ogMeta
      );
    }

    // Handle SPA routing - serve index.html for all non-API routes (Express 5: named wildcard)
    app.get("/{*splat}", (req, res, next) => {
      // Skip API routes
      if (req.path.startsWith("/api/")) {
        return next();
      }
      res.sendFile(join(__dirname, "public", "index.html"));
    });

    // 404 handler (only for API routes now) (Express 5: named wildcard)
    app.use("/api/{*rest}", (req, res) => {
      res.status(404).json({ error: "API route not found" });
    });

    // Error handlers (must be last!)

    // Handle URI decoding errors (like %c0, %80, etc.)
    app.use((err, req, res, next) => {
      if (err instanceof URIError) {
        console.warn(`Invalid URI attempted: ${req.url} from ${req.ip}`);
        return res.status(400).json({ error: "Invalid request" });
      }
      next(err);
    });

    // General error handler
    app.use((err, req, res, next) => {
      console.error(`Error processing request: ${err.message}`);
      res.status(err.status || 500).json({
        error:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : err.message,
      });
    });

    // Start listening
    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT} in ${process.env.NODE_ENV || "development"
        } mode`
      );
      if (!isDatabaseConnected()) {
        console.warn(
          "Server started without database connection. Some features may not work."
        );
        console.info(
          "The application will automatically try to reconnect to the database."
        );
      }
    });
  } catch (error) {
    console.error(`Server error: ${error.message}`);
    // Don't exit the process - let the server continue running
  }
}

startServer();

export default app;
