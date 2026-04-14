// Shared bootstrap for scaffold scripts — loads the env file matching
// NODE_ENV (defaults to development) and opens a Mongo connection.

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import process from "process";
import { connectToDatabase, disconnectFromDatabase } from "../../../helper/dbManager.js";
import { loadLocalOverrides } from "../../../helper/envOverlay.js";

export async function bootstrap() {
  const env = process.env.NODE_ENV || "development";
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const envPath = join(repoRoot, `.env.${env}`);
  dotenv.config({ path: envPath });
  console.info(`[scaffold] loaded env from ${envPath}`);
  loadLocalOverrides(repoRoot);
  await connectToDatabase();
  return { env };
}

export async function teardown() {
  await disconnectFromDatabase();
}

/**
 * Minimal flag parser: supports `--key=value`, `--key value`, and bare flags.
 * Returns { flags: {...}, positional: [...] }.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      if (body.includes("=")) {
        const [k, ...rest] = body.split("=");
        flags[k] = rest.join("=");
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
