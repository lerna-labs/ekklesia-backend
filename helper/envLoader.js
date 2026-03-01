import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Loads environment variables based on NODE_ENV
 * @param {string} [rootDir] - Optional root directory path to load from
 * @returns {void}
 */
export function loadEnvironmentVariables(rootDir) {
  console.log("Loading environment variables...", rootDir);
  // If rootDir is not provided, use the directory of the calling file
  if (!rootDir) {
    // Get the module URL that imported this function
    const callerURL = new Error().stack
      .split("\n")[2]
      .match(/at\s+.+\s+\((.+):\d+:\d+\)/)?.[1];

    if (callerURL) {
      const callerPath = fileURLToPath(callerURL);
      rootDir = path.dirname(callerPath);
    } else {
      // Fallback to current process directory
      rootDir = process.cwd();
    }
  }

  // Load environment variables based on NODE_ENV
  const environment = process.env.NODE_ENV || "development";
  const envPath = path.resolve(rootDir, `.env.${environment}`);
  const defaultEnvPath = path.resolve(rootDir, ".env");

  try {
    // Try to load environment-specific .env file first
    const envConfig = dotenv.config({ path: envPath, quiet: true });

    if (envConfig.error) {
      console.log(`No .env.${environment} found, trying default .env`);
      // Load default .env file
      const defaultConfig = dotenv.config({ path: defaultEnvPath, quiet: true });

      if (defaultConfig.error) {
        console.warn("No .env file found");
      } else {
        console.log(`Loaded environment variables from .env`);
      }
    } else {
      console.log(`Loaded environment variables from .env.${environment}`);
    }
  } catch (error) {
    console.warn(`Error loading environment variables: ${error.message}`);
    throw error;
  }
}
