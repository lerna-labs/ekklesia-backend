/**
 * Frontend build version, as reported by the public health endpoint.
 *
 * This backend does not always ship co-located with the frontend build:
 * the frontend is commonly its own container or served from a CDN, so
 * `public/version.json` legitimately does not exist under this app. That
 * is the normal case, not a failure, so it is not logged. A file that is
 * present but unreadable or malformed points at an actual build artifact
 * problem and is logged.
 *
 * Read once per process and cached, since `version.json` does not change
 * for the life of a running deployment.
 */
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultVersionFrontendPath = join(__dirname, '../public/version.json');

let frontendVersionCache = null;

/**
 * @param {string} [versionFrontendPath] override for the file to read,
 *   used by tests so they never touch this repo's real `public/` directory
 */
export async function loadFrontendVersion(versionFrontendPath = defaultVersionFrontendPath) {
  if (frontendVersionCache !== null) return frontendVersionCache;

  try {
    const raw = await fs.readFile(versionFrontendPath, 'utf8');
    const parsed = JSON.parse(raw);
    frontendVersionCache = parsed || 'unknown';
  } catch (error) {
    if (error.code === 'ENOENT') {
      frontendVersionCache = 'unknown';
    } else {
      console.error(`Frontend version.json is present but unreadable: ${error.message}`);
      frontendVersionCache = 'unknown';
    }
  }

  return frontendVersionCache;
}

export function _resetFrontendVersionCache() {
  frontendVersionCache = null;
}
