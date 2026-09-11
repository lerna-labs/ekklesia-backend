import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetFrontendVersionCache, loadFrontendVersion } from '../frontendVersion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');
const versionFile = path.join(publicDir, 'version.json');

async function removeVersionFile() {
  await fs.rm(versionFile, { force: true });
  await fs.rm(publicDir, { force: true, recursive: true }).catch(() => {});
}

beforeEach(async () => {
  _resetFrontendVersionCache();
  await removeVersionFile();
});

afterEach(async () => {
  _resetFrontendVersionCache();
  await removeVersionFile();
  jest.restoreAllMocks();
});

describe('loadFrontendVersion()', () => {
  test('reports "unknown" without logging an error when version.json is absent', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadFrontendVersion();

    expect(result).toBe('unknown');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('returns the parsed contents when version.json is present and valid', async () => {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(versionFile, JSON.stringify({ version: '1.2.3' }));

    const result = await loadFrontendVersion();

    expect(result).toEqual({ version: '1.2.3' });
  });

  test('reports "unknown" and logs an error when version.json is present but malformed', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(versionFile, '{ not valid json');

    const result = await loadFrontendVersion();

    expect(result).toBe('unknown');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('reads the file only once per process, caching the result', async () => {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(versionFile, JSON.stringify({ version: '1.2.3' }));
    const readSpy = jest.spyOn(fs, 'readFile');

    await loadFrontendVersion();
    await loadFrontendVersion();
    await loadFrontendVersion();

    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});
