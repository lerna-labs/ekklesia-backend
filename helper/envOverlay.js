// Layer a local override file on top of whatever loadEnvironmentVariables
// loaded. The host-owned .env.local (gitignored) is loaded *after* the
// container-written .env.development so local edits survive Docker restarts
// of the docs repo's voting-api service.
//
// A real environment variable supplied by the runtime (container
// `environment:`/`env_file:`, Kubernetes, CI) always wins, even over
// .env.local. Only a value that the runtime did not actually set can be
// filled in, or overridden, by a dotenv file.
//
// Precedence (highest first):
//   process env at launch (what the runtime actually supplied)
//   .env.local             (host-owned, user-editable, optional)
//   .env.development        (written by the docs docker-compose at container start)

import { existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Snapshot of the environment as the runtime actually supplied it, captured
// when this module is first evaluated. ES module imports are resolved and
// evaluated before the importing script's own top-level code runs, so as
// long as no module loads a dotenv file at its own import time ahead of this
// one, this snapshot reflects only what the container/OS/CI set - not
// anything a dotenv file (base or local) later fills in.
const runtimeEnvSnapshot = { ...process.env };

export function loadLocalOverrides(rootDir) {
  const p = path.join(rootDir, '.env.local');
  if (!existsSync(p)) return { loaded: false, path: p };
  const result = dotenv.config({ path: p, override: true });
  if (result.error) {
    console.warn(`Failed to load ${p}: ${result.error.message}`);
    return { loaded: false, path: p, error: result.error };
  }
  // .env.local is allowed to win over the base dotenv file, but never over a
  // variable the runtime actually supplied. Restore anything real.
  for (const key of Object.keys(runtimeEnvSnapshot)) {
    if (process.env[key] !== runtimeEnvSnapshot[key]) {
      process.env[key] = runtimeEnvSnapshot[key];
    }
  }
  console.info(`Loaded local env overrides from ${p}`);
  return { loaded: true, path: p, parsed: result.parsed };
}
