// Load a config/<name> validation script.
//
// ESM dynamic imports cache modules by specifier for the lifetime of
// the process — fine in production, a footgun in dev where a file
// edit (without a clean nodemon restart) leaves stale code resident.
// In development we re-stat the file and re-import with an mtime
// query suffix when it's changed; production caches forever.
//
// Treat this as the single entry point for `voterValidationScript` /
// `votingPowerScript` resolution. Routes shouldn't `import()` config
// files directly.

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { stat } from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, "..", "config");

const isDev = process.env.NODE_ENV !== "production";

// Per-script mtime cache so we only re-import when the file actually
// changes, not on every request.
const lastSeen = new Map(); // name → mtime ms

export async function loadValidationScript(name) {
  if (!name || typeof name !== "string" || name.includes("/") || name.includes("..")) {
    throw new Error(`Invalid validation script name: ${name}`);
  }
  const fullPath = join(CONFIG_DIR, name);

  if (!isDev) {
    return import(pathToFileURL(fullPath).href);
  }

  let mtime = 0;
  try {
    const s = await stat(fullPath);
    mtime = s.mtimeMs;
  } catch {
    // fall through; import will throw a clearer error
  }
  const prev = lastSeen.get(name);
  lastSeen.set(name, mtime);

  // Always include the mtime in the specifier so a file edit produces
  // a new cache key. The first load primes the cache; subsequent loads
  // re-use it until mtime changes.
  const url = `${pathToFileURL(fullPath).href}?t=${mtime}`;
  return import(url);
}
