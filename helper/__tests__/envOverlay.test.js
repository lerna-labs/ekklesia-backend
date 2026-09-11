// Regression coverage for issue #139.
//
// `loadLocalOverrides` used to load .env.local with `override: true`
// unconditionally, so a checked-out .env.local could clobber a real
// environment variable the runtime (container, CI) supplied. The fix
// snapshots the real process environment at module-evaluation time and
// restores it after the local file loads, so a real env var always wins,
// while .env.local still fills gaps and still overrides values that only
// came from the base dotenv file.
//
// `loadLocalOverrides` snapshots process.env once, when the module is first
// evaluated, so each test below imports a fresh copy of the module (via a
// cache-busting query string) after arranging process.env to look like the
// scenario under test.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let moduleCounter = 0;
async function freshLoadLocalOverrides() {
  moduleCounter += 1;
  const mod = await import(`../envOverlay.js?test=${moduleCounter}`);
  return mod.loadLocalOverrides;
}

describe('loadLocalOverrides (issue #139)', () => {
  let dir;
  const managedKeys = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'env-overlay-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    while (managedKeys.length) {
      delete process.env[managedKeys.pop()];
    }
  });

  function trackKey(key) {
    managedKeys.push(key);
  }

  test('a real runtime-supplied variable is not clobbered by .env.local', async () => {
    trackKey('MONGO_URI');
    process.env.MONGO_URI = 'mongodb://runtime-supplied-host/db';
    writeFileSync(path.join(dir, '.env.local'), 'MONGO_URI=mongodb://checkout-local-host/db\n');

    const loadLocalOverrides = await freshLoadLocalOverrides();
    const result = loadLocalOverrides(dir);

    expect(result.loaded).toBe(true);
    expect(process.env.MONGO_URI).toBe('mongodb://runtime-supplied-host/db');
  });

  test('.env.local still fills a variable the runtime did not set', async () => {
    trackKey('LOCAL_ONLY_VAR');
    delete process.env.LOCAL_ONLY_VAR;
    writeFileSync(path.join(dir, '.env.local'), 'LOCAL_ONLY_VAR=from-local-file\n');

    const loadLocalOverrides = await freshLoadLocalOverrides();
    loadLocalOverrides(dir);

    expect(process.env.LOCAL_ONLY_VAR).toBe('from-local-file');
  });

  test('.env.local still overrides a value that only came from the base dotenv file', async () => {
    trackKey('BASE_FILE_VAR');
    delete process.env.BASE_FILE_VAR;

    // Import first so the module's snapshot is taken before the base file
    // "loads" (simulated below), matching the real load order in server.js
    // and the __scripts/ entry points: base file, then .env.local overlay.
    const loadLocalOverrides = await freshLoadLocalOverrides();

    // Simulate loadEnvironmentVariables() populating this from
    // .env.${NODE_ENV} - not a real runtime-supplied value.
    process.env.BASE_FILE_VAR = 'from-base-file';

    writeFileSync(path.join(dir, '.env.local'), 'BASE_FILE_VAR=from-local-file\n');
    loadLocalOverrides(dir);

    expect(process.env.BASE_FILE_VAR).toBe('from-local-file');
  });

  test('returns loaded: false when no .env.local is present', async () => {
    const loadLocalOverrides = await freshLoadLocalOverrides();
    const result = loadLocalOverrides(dir);

    expect(result.loaded).toBe(false);
    expect(existsSync(path.join(dir, '.env.local'))).toBe(false);
  });
});
