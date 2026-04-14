// Layer a local override file on top of whatever loadEnvironmentVariables
// loaded. The host-owned .env.local (gitignored) is loaded *after* the
// container-written .env.development with { override: true } so local edits
// survive Docker restarts of the docs repo's voting-api service.
//
// Precedence (last wins):
//   .env.development  (written by the docs docker-compose at container start)
//   .env.local        (host-owned, user-editable, optional)

import { existsSync } from "fs";
import path from "path";
import dotenv from "dotenv";

export function loadLocalOverrides(rootDir) {
  const p = path.join(rootDir, ".env.local");
  if (!existsSync(p)) return { loaded: false, path: p };
  const result = dotenv.config({ path: p, override: true });
  if (result.error) {
    console.warn(`Failed to load ${p}: ${result.error.message}`);
    return { loaded: false, path: p, error: result.error };
  }
  console.info(`Loaded local env overrides from ${p}`);
  return { loaded: true, path: p, parsed: result.parsed };
}
