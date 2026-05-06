/**
 * Dynamic OpenGraph card images for ballots and proposals. Renders a
 * 1200×630 PNG via Satori (JSX-ish tree → SVG) + @resvg/resvg-js
 * (SVG → PNG). Cached in-process with an LRU.
 *
 * Optional dependencies. `satori` and `@resvg/resvg-js` are loaded
 * with dynamic `import()` so a deploy that hasn't installed them yet
 * still boots cleanly when `OG_CARDS_ENABLED` is unset; only the OG
 * image endpoints fail when they're missing, with a clear 503.
 *
 * Fonts. Satori needs at least one font per weight referenced by the
 * card. Defaults are `assets/og/Inter-Regular.ttf` and
 * `assets/og/Inter-Bold.ttf`; override via `OG_FONT_REGULAR` /
 * `OG_FONT_BOLD` env vars.
 *
 * Cache busting. The cache key, ETag, and (via ogMeta) the `?v=`
 * query string mix in `OG_RENDERER_VERSION` (default "1"). Bump that
 * env var to force every cached card to re-render after a design
 * change or a PUBLIC_URL migration — every URL changes, every cache
 * busts naturally.
 */
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { Ballot } from "../../schema/Ballot.js";
import { Proposal } from "../../schema/Proposal.js";

// Tiny LRU with TTL. Map preserves insertion order, so re-inserting on
// hit keeps the most-recently-used entries at the tail. Avoids a
// dependency on lru-cache (the repo currently has only the transitive
// v5 from another package, which has a different API).
const PNG_CACHE_MAX = 256;
const PNG_CACHE_TTL_MS = 60 * 60 * 1000;
const PNG_CACHE = new Map(); // key → { png, expiresAt }

function pngCacheGet(key) {
  const entry = PNG_CACHE.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    PNG_CACHE.delete(key);
    return undefined;
  }
  PNG_CACHE.delete(key);
  PNG_CACHE.set(key, entry);
  return entry.png;
}

function pngCacheSet(key, png) {
  PNG_CACHE.set(key, { png, expiresAt: Date.now() + PNG_CACHE_TTL_MS });
  if (PNG_CACHE.size > PNG_CACHE_MAX) {
    const oldest = PNG_CACHE.keys().next().value;
    if (oldest !== undefined) PNG_CACHE.delete(oldest);
  }
}

export function rendererVersion() {
  const raw = process.env.OG_RENDERER_VERSION;
  return raw && raw.trim() ? raw.trim() : "1";
}

let satoriPromise = null;
let resvgPromise = null;
async function loadSatori() {
  if (!satoriPromise) {
    satoriPromise = import("satori")
      .then((m) => m.default || m)
      .catch((err) => {
        satoriPromise = null;
        throw err;
      });
  }
  return satoriPromise;
}
async function loadResvg() {
  if (!resvgPromise) {
    resvgPromise = import("@resvg/resvg-js")
      .then((m) => m)
      .catch((err) => {
        resvgPromise = null;
        throw err;
      });
  }
  return resvgPromise;
}

let fontCache = null;
async function loadFonts() {
  if (fontCache) return fontCache;
  const cwd = process.cwd();
  const reg = process.env.OG_FONT_REGULAR
    ? path.resolve(process.env.OG_FONT_REGULAR)
    : path.join(cwd, "assets/og/Inter-Regular.ttf");
  const bold = process.env.OG_FONT_BOLD
    ? path.resolve(process.env.OG_FONT_BOLD)
    : path.join(cwd, "assets/og/Inter-Bold.ttf");
  const [regData, boldData] = await Promise.all([
    fs.readFile(reg),
    fs.readFile(bold),
  ]);
  fontCache = [
    { name: "Inter", data: regData, weight: 400, style: "normal" },
    { name: "Inter", data: boldData, weight: 700, style: "normal" },
  ];
  return fontCache;
}

// ---------- design tokens ----------

/**
 * Palette keys consumed by `card()`. Custom deployments override any
 * subset via a JSON file pointed to by `OG_PALETTE_FILE` — see
 * `loadPalette()` below. Keys not present in the override fall back
 * to these defaults.
 *
 * Glow colors and the accent stripe are auto-derived from
 * `brandPrimary` / `brandSecondary` when not set explicitly, so a
 * custom deployment usually only needs to set the two brand colors
 * (and maybe the background gradient) to get a coherent card.
 */
const DEFAULT_PALETTE = {
  bgFrom: "#0F0F1A",
  bgVia: "#1E1E2F",
  bgTo: "#2A1B45",
  brandPrimary: "#F97316",
  brandSecondary: "#6366F1",
  textPrimary: "#FFFFFF",
  textSecondary: "#A0A0B8",
  chipBg: "rgba(255, 255, 255, 0.08)",
  chipBorder: "rgba(255, 255, 255, 0.18)",
  decorativeOverlay: "#FFFFFF",
  // The next four default to derived values (see `resolvePalette`):
  //   glowPrimary    ← rgba(brandPrimary, 0.45)
  //   glowSecondary  ← rgba(brandSecondary, 0.55)
  //   accentTop      ← brandPrimary
  //   accentBottom   ← brandSecondary
  glowPrimary: null,
  glowSecondary: null,
  accentTop: null,
  accentBottom: null,
};

function hexToRgba(hex, alpha) {
  const m = String(hex || "").match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolvePalette(input) {
  const p = { ...DEFAULT_PALETTE, ...(input || {}) };
  if (!p.glowPrimary) {
    p.glowPrimary =
      hexToRgba(p.brandPrimary, 0.45) || "rgba(249, 115, 22, 0.45)";
  }
  if (!p.glowSecondary) {
    p.glowSecondary =
      hexToRgba(p.brandSecondary, 0.55) || "rgba(99, 102, 241, 0.55)";
  }
  if (!p.accentTop) p.accentTop = p.brandPrimary;
  if (!p.accentBottom) p.accentBottom = p.brandSecondary;
  return p;
}

let paletteCache = null;
/**
 * Load the per-deployment palette. When `OG_PALETTE_FILE` is set, its
 * JSON contents are merged over `DEFAULT_PALETTE`. Failures (missing
 * file, malformed JSON) are logged once and the default palette is
 * used so the card endpoint never breaks just because a theme file is
 * misconfigured.
 *
 * Cached per-process. Bump `OG_RENDERER_VERSION` after editing the
 * palette file to invalidate downstream caches.
 */
export async function loadPalette() {
  if (paletteCache) return paletteCache;
  const file = (process.env.OG_PALETTE_FILE || "").trim();
  if (!file) {
    paletteCache = resolvePalette(null);
    return paletteCache;
  }
  try {
    const resolved = path.resolve(process.cwd(), file);
    const raw = await fs.readFile(resolved, "utf8");
    const json = JSON.parse(raw);
    paletteCache = resolvePalette(json);
  } catch (err) {
    console.warn(
      `og palette: failed to load ${file} — falling back to defaults (${err?.message || err})`
    );
    paletteCache = resolvePalette(null);
  }
  return paletteCache;
}

export function _resetPaletteCache() {
  paletteCache = null;
}

/**
 * Per-deployment branding for the bottom-row host label. Order:
 *   1. `OG_BRAND_HOST` env var (explicit override, e.g. "vote.example.org")
 *   2. host extracted from `PUBLIC_URL` (or `FRONTEND_URL` as a fallback)
 *   3. empty string — the host label is omitted from the card
 *
 * `OG_BRAND_NAME` controls the wordmark text (default "EKKLESIA").
 */
function brandHost() {
  const explicit = process.env.OG_BRAND_HOST;
  if (explicit && explicit.trim()) return explicit.trim();
  const base = (process.env.PUBLIC_URL || process.env.FRONTEND_URL || "").trim();
  if (!base) return "";
  // Try as URL first. If the user dropped a bare hostname like
  // `vote.example.org` (no scheme) `new URL()` throws — fall back to
  // treating the string as host-only and strip any path the user may
  // have included.
  try {
    return new URL(base).host || "";
  } catch {
    return base.replace(/^\/+/, "").split("/")[0] || "";
  }
}

function brandName() {
  const explicit = process.env.OG_BRAND_NAME;
  return explicit && explicit.trim() ? explicit.trim() : "EKKLESIA";
}

function titleSizeFor(text) {
  const len = String(text || "").length;
  if (len > 110) return "44px";
  if (len > 80) return "54px";
  if (len > 50) return "64px";
  return "76px";
}

function formatDate(d) {
  if (!d) return null;
  try {
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

function periodLabel(ballot) {
  const start = formatDate(ballot?.votePeriodStart);
  const end = formatDate(ballot?.votePeriodEnd);
  if (start && end) return `${start} — ${end}`;
  if (end) return `Closes ${end}`;
  if (start) return `Opens ${start}`;
  return null;
}

// ---------- decorative layers ----------

function fadeTransparent(rgba) {
  // "rgba(r, g, b, a)" → "rgba(r, g, b, 0)" for the gradient outer stop.
  return String(rgba || "").replace(/,\s*[\d.]+\s*\)$/, ", 0)");
}

function decorativeLayer(palette) {
  const glowPrimaryFade = fadeTransparent(palette.glowPrimary);
  const glowSecondaryFade = fadeTransparent(palette.glowSecondary);
  return [
    // Primary brand glow in the top-right
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          top: "-220px",
          right: "-180px",
          width: "620px",
          height: "620px",
          borderRadius: "310px",
          background: `radial-gradient(circle, ${palette.glowPrimary} 0%, ${glowPrimaryFade} 70%)`,
          display: "flex",
        },
      },
    },
    // Secondary brand glow in the bottom-left
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          bottom: "-260px",
          left: "-180px",
          width: "560px",
          height: "560px",
          borderRadius: "280px",
          background: `radial-gradient(circle, ${palette.glowSecondary} 0%, ${glowSecondaryFade} 70%)`,
          display: "flex",
        },
      },
    },
    // Vertical accent stripe along the left edge
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          width: "10px",
          height: "630px",
          background: `linear-gradient(180deg, ${palette.accentTop} 0%, ${palette.accentBottom} 100%)`,
          display: "flex",
        },
      },
    },
    // Subtle diagonal hairline overlay (decorative SVG passthrough)
    {
      type: "svg",
      props: {
        width: "1200",
        height: "630",
        viewBox: "0 0 1200 630",
        xmlns: "http://www.w3.org/2000/svg",
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          opacity: 0.08,
        },
        children: [
          {
            type: "path",
            props: {
              d:
                "M -100 700 L 1300 -100 M -100 800 L 1300 0 M -100 900 L 1300 100",
              stroke: palette.decorativeOverlay,
              strokeWidth: "1",
              fill: "none",
            },
          },
        ],
      },
    },
  ];
}

// ---------- card composition ----------

function chip({ label, accentColor, palette }) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        padding: "8px 18px",
        borderRadius: "100px",
        backgroundColor: palette.chipBg,
        border: `1px solid ${palette.chipBorder}`,
        color: accentColor || palette.textPrimary,
        fontSize: "22px",
        fontWeight: 700,
        letterSpacing: "0.12em",
      },
      children: label,
    },
  };
}

function topRow({ kindLabel, palette }) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        width: "100%",
      },
      children: [chip({ label: kindLabel, palette })],
    },
  };
}

function bottomRow({ period, host, name, palette }) {
  const wordmarkChildren = [
    {
      type: "div",
      props: {
        style: {
          width: "10px",
          height: "10px",
          borderRadius: "5px",
          backgroundColor: palette.brandPrimary,
          marginRight: "12px",
          display: "flex",
        },
      },
    },
    name,
  ];
  if (host) {
    wordmarkChildren.push({
      type: "div",
      props: {
        style: {
          color: palette.textSecondary,
          fontWeight: 400,
          marginLeft: "12px",
          display: "flex",
        },
        children: host,
      },
    });
  }

  const right = period
    ? {
        type: "div",
        props: {
          style: {
            display: "flex",
            fontSize: "22px",
            color: palette.textSecondary,
            fontWeight: 600,
            letterSpacing: "0.02em",
          },
          children: period,
        },
      }
    : { type: "div", props: { style: { display: "flex" }, children: "" } };

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              fontSize: "26px",
              fontWeight: 700,
              color: palette.textPrimary,
              letterSpacing: "0.04em",
            },
            children: wordmarkChildren,
          },
        },
        right,
      ],
    },
  };
}

function card({ kindLabel, eyebrow, title, period, palette }) {
  const host = brandHost();
  const name = brandName();
  const children = [
    ...decorativeLayer(palette),
    {
      // Foreground content column
      type: "div",
      props: {
        style: {
          position: "relative",
          width: "1100px",
          height: "486px",
          marginLeft: "60px",
          marginRight: "40px",
          marginTop: "72px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          color: palette.textPrimary,
        },
        children: [
          topRow({ kindLabel, palette }),
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
                maxWidth: "1056px",
              },
              children: [
                eyebrow
                  ? {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          fontSize: "26px",
                          fontWeight: 600,
                          color: palette.brandPrimary,
                          letterSpacing: "0.06em",
                          marginBottom: "18px",
                        },
                        children: eyebrow,
                      },
                    }
                  : { type: "div", props: { style: { display: "flex" }, children: "" } },
                {
                  type: "div",
                  props: {
                    style: {
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 4,
                      overflow: "hidden",
                      fontSize: titleSizeFor(title),
                      fontWeight: 700,
                      lineHeight: 1.12,
                      letterSpacing: "-0.015em",
                      color: palette.textPrimary,
                    },
                    children: title,
                  },
                },
              ],
            },
          },
          bottomRow({ period, host, name, palette }),
        ],
      },
    },
  ];

  return {
    type: "div",
    props: {
      style: {
        position: "relative",
        width: "1200px",
        height: "630px",
        background: `linear-gradient(135deg, ${palette.bgFrom} 0%, ${palette.bgVia} 50%, ${palette.bgTo} 100%)`,
        fontFamily: "Inter",
        display: "flex",
        overflow: "hidden",
      },
      children,
    },
  };
}

async function renderPng(model) {
  const [satori, resvg, fonts, palette] = await Promise.all([
    loadSatori(),
    loadResvg(),
    loadFonts(),
    loadPalette(),
  ]);
  const svg = await satori(card({ ...model, palette }), {
    width: 1200,
    height: 630,
    fonts,
  });
  return new resvg.Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
    .render()
    .asPng();
}

function isObjectId(s) {
  return typeof s === "string" && mongoose.isValidObjectId(s);
}

function authorityEyebrow(ballot) {
  // No `votingAuthority` field on the schema today; default to the
  // brand label until the field lands. See TRD §9 open-question 1.
  const explicit =
    ballot?.hydra?.ballot?.ekklesia?.votingAuthority ||
    ballot?.votingAuthority;
  const label = explicit ? String(explicit) : "EKKLESIA VOTE";
  return label.toUpperCase();
}

function send503(res, err) {
  console.warn(`og image: setup error — ${err?.message || err}`);
  res.status(503).json({
    error: "OG image rendering not available",
    detail:
      "OG_CARDS_ENABLED is set but the renderer or its fonts could not be loaded. " +
      "Install `satori` and `@resvg/resvg-js`, and place Inter-Regular.ttf / Inter-Bold.ttf " +
      "under assets/og/ (or set OG_FONT_REGULAR / OG_FONT_BOLD).",
  });
}

export async function ogBallotImage(req, res, next) {
  try {
    const { ballotId } = req.params;
    if (!isObjectId(ballotId)) return next();
    const ballot = await Ballot.findById(ballotId).lean();
    if (!ballot) return next();

    const ts = ballot.updatedAt ? new Date(ballot.updatedAt).getTime() : 0;
    const v = rendererVersion();
    const cacheKey = `b-v${v}-${ballotId}-${ts}`;
    let png = pngCacheGet(cacheKey);
    if (!png) {
      try {
        png = await renderPng({
          kindLabel: "BALLOT",
          eyebrow: authorityEyebrow(ballot),
          title: String(ballot.title || "Untitled ballot"),
          period: periodLabel(ballot),
        });
      } catch (err) {
        return send503(res, err);
      }
      pngCacheSet(cacheKey, png);
    }

    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: `"${cacheKey}"`,
    });
    res.send(png);
  } catch (err) {
    next(err);
  }
}

export async function ogProposalImage(req, res, next) {
  try {
    const { proposalId } = req.params;
    if (!isObjectId(proposalId)) return next();
    const proposal = await Proposal.findById(proposalId).lean();
    if (!proposal) return next();
    const ballot = proposal.ballotId
      ? await Ballot.findById(proposal.ballotId).lean()
      : null;

    const ts = proposal.updatedAt
      ? new Date(proposal.updatedAt).getTime()
      : 0;
    const v = rendererVersion();
    const cacheKey = `p-v${v}-${proposalId}-${ts}`;
    let png = pngCacheGet(cacheKey);
    if (!png) {
      try {
        png = await renderPng({
          kindLabel: "PROPOSAL",
          eyebrow: ballot?.title
            ? `PART OF — ${String(ballot.title).toUpperCase()}`
            : authorityEyebrow(ballot),
          title: String(proposal.title || "Untitled proposal"),
          period: periodLabel(ballot),
        });
      } catch (err) {
        return send503(res, err);
      }
      pngCacheSet(cacheKey, png);
    }

    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, immutable",
      ETag: `"${cacheKey}"`,
    });
    res.send(png);
  } catch (err) {
    next(err);
  }
}

// Test exports
export const _internals = {
  titleSizeFor,
  authorityEyebrow,
  rendererVersion,
  formatDate,
  periodLabel,
  brandHost,
  brandName,
  hexToRgba,
  resolvePalette,
  fadeTransparent,
  DEFAULT_PALETTE,
};
