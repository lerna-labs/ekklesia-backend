import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetFrontendVersionCache, loadFrontendVersion } from '../frontendVersion.js';

let tmpDir;
let versionFile;

beforeEach(async () => {
  _resetFrontendVersionCache();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-version-test-'));
  versionFile = path.join(tmpDir, 'version.json');
});

afterEach(async () => {
  _resetFrontendVersionCache();
  await fs.rm(tmpDir, { force: true, recursive: true });
  jest.restoreAllMocks();
});

describe('loadFrontendVersion()', () => {
  test('reports "unknown" without logging an error when version.json is absent', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadFrontendVersion(versionFile);

    expect(result).toBe('unknown');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('returns the parsed contents when version.json is present and valid', async () => {
    await fs.writeFile(versionFile, JSON.stringify({ version: '1.2.3' }));

    const result = await loadFrontendVersion(versionFile);

    expect(result).toEqual({ version: '1.2.3' });
  });

  test('reports "unknown" and logs an error when version.json is present but malformed', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(versionFile, '{ not valid json');

    const result = await loadFrontendVersion(versionFile);

    expect(result).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('reads the file only once per process, caching the result', async () => {
    await fs.writeFile(versionFile, JSON.stringify({ version: '1.2.3' }));
    const readSpy = jest.spyOn(fs, 'readFile');

    await loadFrontendVersion(versionFile);
    await loadFrontendVersion(versionFile);
    await loadFrontendVersion(versionFile);

    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});
