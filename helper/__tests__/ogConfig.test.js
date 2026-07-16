import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _internals as imageInternals, _resetPaletteCache, loadPalette } from '../og/ogImage.js';
import { _internals as metaInternals } from '../og/ogMeta.js';

const { brandHost, brandName, hexToRgba, resolvePalette, fadeTransparent, DEFAULT_PALETTE } =
  imageInternals;
const { publicUrl } = metaInternals;

const ENV_KEYS = [
  'OG_BRAND_HOST',
  'OG_BRAND_NAME',
  'PUBLIC_URL',
  'FRONTEND_URL',
  'OG_PALETTE_FILE',
];

let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('brandHost()', () => {
  test('explicit OG_BRAND_HOST wins', () => {
    process.env.OG_BRAND_HOST = 'vote.daoX.org';
    process.env.PUBLIC_URL = 'https://app.ekklesia.vote';
    expect(brandHost()).toBe('vote.daoX.org');
  });

  test('derives host from PUBLIC_URL when scheme is present', () => {
    process.env.PUBLIC_URL = 'https://app.ekklesia.vote';
    expect(brandHost()).toBe('app.ekklesia.vote');
  });

  test('accepts bare hostname (no scheme) — was the regression', () => {
    process.env.PUBLIC_URL = 'hydra-voting.intersectmbo.org';
    expect(brandHost()).toBe('hydra-voting.intersectmbo.org');
  });

  test('strips path if user pasted a path-shaped value', () => {
    process.env.PUBLIC_URL = 'vote.example.org/app';
    expect(brandHost()).toBe('vote.example.org');
  });

  test('falls back to FRONTEND_URL when PUBLIC_URL unset', () => {
    process.env.FRONTEND_URL = 'https://localhost:5173';
    expect(brandHost()).toBe('localhost:5173');
  });

  test('returns empty string when nothing is set', () => {
    expect(brandHost()).toBe('');
  });
});

describe('brandName()', () => {
  test('defaults to EKKLESIA', () => {
    expect(brandName()).toBe('EKKLESIA');
  });

  test('OG_BRAND_NAME overrides', () => {
    process.env.OG_BRAND_NAME = 'INTERSECT';
    expect(brandName()).toBe('INTERSECT');
  });
});

describe('hexToRgba()', () => {
  test('expands 6-char hex', () => {
    expect(hexToRgba('#F97316', 0.45)).toBe('rgba(249, 115, 22, 0.45)');
  });
  test('expands 3-char hex', () => {
    expect(hexToRgba('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
  });
  test('returns null for non-hex input (rgba pre-resolved by caller)', () => {
    expect(hexToRgba('rgba(0,0,0,0.5)', 0.5)).toBeNull();
    expect(hexToRgba(null, 0.5)).toBeNull();
  });
});

describe('fadeTransparent()', () => {
  test('forces alpha to 0 on an rgba string', () => {
    expect(fadeTransparent('rgba(249, 115, 22, 0.45)')).toBe('rgba(249, 115, 22, 0)');
  });
});

describe('resolvePalette()', () => {
  test('null/undefined returns the defaults with derived glows + accents', () => {
    const p = resolvePalette(null);
    expect(p.bgFrom).toBe(DEFAULT_PALETTE.bgFrom);
    expect(p.brandPrimary).toBe(DEFAULT_PALETTE.brandPrimary);
    expect(p.glowPrimary).toBe('rgba(249, 115, 22, 0.45)');
    expect(p.glowSecondary).toBe('rgba(99, 102, 241, 0.55)');
    expect(p.accentTop).toBe(DEFAULT_PALETTE.brandPrimary);
    expect(p.accentBottom).toBe(DEFAULT_PALETTE.brandSecondary);
  });

  test('partial override merges over defaults — only set what you change', () => {
    const p = resolvePalette({ brandPrimary: '#3B82F6' });
    expect(p.brandPrimary).toBe('#3B82F6');
    expect(p.brandSecondary).toBe(DEFAULT_PALETTE.brandSecondary);
    // Glow + accent re-derive from the overridden brand color
    expect(p.glowPrimary).toBe('rgba(59, 130, 246, 0.45)');
    expect(p.accentTop).toBe('#3B82F6');
  });

  test('explicit glow override wins over derivation', () => {
    const p = resolvePalette({
      brandPrimary: '#3B82F6',
      glowPrimary: 'rgba(255, 0, 0, 0.5)',
    });
    expect(p.glowPrimary).toBe('rgba(255, 0, 0, 0.5)');
  });
});

describe('loadPalette()', () => {
  let tmpDir;
  beforeEach(async () => {
    _resetPaletteCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'og-palette-'));
  });
  afterEach(async () => {
    _resetPaletteCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns defaults when OG_PALETTE_FILE is unset', async () => {
    const p = await loadPalette();
    expect(p.brandPrimary).toBe(DEFAULT_PALETTE.brandPrimary);
  });

  test('merges JSON file contents over defaults', async () => {
    const file = path.join(tmpDir, 'palette.json');
    await fs.writeFile(file, JSON.stringify({ brandPrimary: '#22D3EE', bgFrom: '#0B1220' }));
    process.env.OG_PALETTE_FILE = file;
    const p = await loadPalette();
    expect(p.brandPrimary).toBe('#22D3EE');
    expect(p.bgFrom).toBe('#0B1220');
    expect(p.brandSecondary).toBe(DEFAULT_PALETTE.brandSecondary);
    expect(p.glowPrimary).toBe('rgba(34, 211, 238, 0.45)');
  });

  test('missing palette file falls back to defaults (does not throw)', async () => {
    process.env.OG_PALETTE_FILE = path.join(tmpDir, 'does-not-exist.json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await loadPalette();
    expect(p.brandPrimary).toBe(DEFAULT_PALETTE.brandPrimary);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('malformed JSON falls back to defaults (does not throw)', async () => {
    const file = path.join(tmpDir, 'bad.json');
    await fs.writeFile(file, '{ not: valid json }');
    process.env.OG_PALETTE_FILE = file;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await loadPalette();
    expect(p.brandPrimary).toBe(DEFAULT_PALETTE.brandPrimary);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('publicUrl()', () => {
  test('auto-prepends https:// for bare hostname', () => {
    process.env.PUBLIC_URL = 'hydra-voting.intersectmbo.org';
    expect(publicUrl()).toBe('https://hydra-voting.intersectmbo.org');
  });

  test('preserves http://', () => {
    process.env.PUBLIC_URL = 'http://localhost:3000';
    expect(publicUrl()).toBe('http://localhost:3000');
  });

  test("strips trailing slash so og:image doesn't get a double slash", () => {
    process.env.PUBLIC_URL = 'https://vote.example.org/';
    expect(publicUrl()).toBe('https://vote.example.org');
  });

  test('returns empty when neither PUBLIC_URL nor FRONTEND_URL set', () => {
    expect(publicUrl()).toBe('');
  });
});
