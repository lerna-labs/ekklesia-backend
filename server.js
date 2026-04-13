import express from "express";
import { loadRoutes } from "./helper/loadRoutes.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cors from "cors";
import { initializeConsole } from "./helper/consoleManager.js";
import { loadEnvironmentVariables } from "./helper/envLoader.js";
import {
  connectToDatabase,
  isDatabaseConnected,
  checkDatabaseConnectionMW,
} from "./helper/dbManager.js";
import cookieParser from "cookie-parser";
import { v0Freeze } from "./helper/v0Freeze.js";

// Initialize console with timestamps
initializeConsole();

// Load environment variables
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  loadEnvironmentVariables(__dirname);
} catch (error) {
  console.warn(`Error loading environment variables: ${error.message}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

// Middleware
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
