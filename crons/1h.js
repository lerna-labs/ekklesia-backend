// Conosole log
console.log("Starting hourly cron job...");

// Load environment variables first
import { loadEnvironmentVariables } from "../helper/envLoader.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from project root
// Assuming project root is two directories up from the crons folder
try {
  loadEnvironmentVariables(path.resolve(__dirname, ".."));
} catch (error) {
  console.warn(`Error loading environment variables: ${error.message}`);
  process.exit(1);
}

import {
  isDatabaseConnected,
  connectToDatabase,
  disconnectFromDatabase,
} from "../helper/dbManager.js";

// connect db
if (!isDatabaseConnected()) {
  await connectToDatabase();
}

// disconnect from db
await disconnectFromDatabase();

// Conosole log
console.log("Finished hourly cron job.");
process.exit(0);
