# Ekklesia Voting Backend

## OpenGraph cards (per-ballot / per-proposal social previews)

The backend can inject route-specific `<title>` / `og:*` / `twitter:*`
meta tags into the SPA's `index.html` for ballot and proposal URLs and
serve a dynamic 1200×630 PNG card per ballot/proposal. Both surfaces
are gated on a single feature flag and are pure additions — when the
flag is off, the backend behaves exactly as before.

### Enabling

```env
OG_CARDS_ENABLED=true
PUBLIC_URL=https://app.ekklesia.vote   # absolute base for og:url + og:image
# Optional — all default to sensible values:
# OG_BRAND_HOST=app.ekklesia.vote      # bottom-row host label; falls back to host parsed from PUBLIC_URL
# OG_BRAND_NAME=EKKLESIA               # bottom-row wordmark text
# OG_PALETTE_FILE=assets/og/palette.json   # per-deployment palette overrides
```

### Custom palettes (white-label deployments)

Point `OG_PALETTE_FILE` at a JSON file whose keys override the defaults
in `helper/og/ogImage.js`. Any subset is fine — anything you don't set
inherits from the default palette. Example:

```json
{
  "bgFrom": "#0B1220",
  "bgVia": "#0E1B2E",
  "bgTo": "#0A2F4A",
  "brandPrimary": "#3B82F6",
  "brandSecondary": "#22D3EE",
  "textSecondary": "#94A3B8"
}
```

Recognized keys (all optional):

| Key | Purpose |
|---|---|
| `bgFrom`, `bgVia`, `bgTo` | 3-stop background gradient |
| `brandPrimary` | Eyebrow text, wordmark dot, top accent stripe, top-right glow |
| `brandSecondary` | Bottom accent stripe, bottom-left glow |
| `textPrimary` | Title + wordmark text |
| `textSecondary` | Host label + vote-period text |
| `chipBg`, `chipBorder` | TYPE chip background + border |
| `decorativeOverlay` | Diagonal hairline color (8% opacity) |
| `glowPrimary`, `glowSecondary` | Override the auto-derived rgba glows (rgba string) |
| `accentTop`, `accentBottom` | Override the accent stripe stops (defaults to brand colors) |

Glow rgba and accent stripe colors auto-derive from `brandPrimary` /
`brandSecondary`, so for most rebrands you only need to set the
backgrounds and the two brand colors. Bump `OG_RENDERER_VERSION` after
editing the JSON file to bust downstream caches.

Both endpoints also need fonts and the renderer dependencies:

1. Install the renderer:
   ```bash
   export GITHUB_TOKEN="$(gh auth token)"   # for @lerna-labs/* private deps
   npm install
   ```
2. Drop `Inter-Regular.ttf` and `Inter-Bold.ttf` (Inter, SIL OFL 1.1)
   into `assets/og/` alongside the bundled `LICENSE.txt`. Override
   paths via `OG_FONT_REGULAR` / `OG_FONT_BOLD` if you ship them
   somewhere else.

When enabled, the backend mounts:

- `/ballots/:ballotId` (and proposal sub-paths) → the SPA `index.html`
  with rewritten OG/Twitter meta tags pointing at the card image.
- `/og/ballot/:ballotId.png` and `/og/proposal/:proposalId.png` → the
  rendered card itself.

Failures are non-fatal: any throw / missing record / malformed id
falls through to the generic SPA fallback. The image endpoint returns
a clean `503` with a setup hint when the renderer or fonts are missing.

### Cache busting

Three layers cache the cards:

| Layer | Keyed on |
|---|---|
| In-process LRU (PNG) | `<id>-<updatedAt>-<rendererVersion>` |
| HTTP `Cache-Control: immutable` (browser/CDN) | URL incl. `?v=<updatedAt>-<rendererVersion>` |
| External scrapers (X, LinkedIn, Slack…) | their own debugger refreshers |

Editing a ballot or proposal updates `updatedAt`, which busts the
first two layers automatically. **Design changes don't touch
`updatedAt`** — bump the renderer version instead:

```env
OG_RENDERER_VERSION=2
```

Increment `OG_RENDERER_VERSION` (any string works — `2`, `2024-05-05`,
a git short-sha) whenever you:

- Change the card layout, palette, or fonts in `helper/og/ogImage.js`.
- Migrate `PUBLIC_URL` and need every emitted URL to differ.
- Want to forcibly invalidate every cached PNG without touching ballot
  data.

The next request rewrites every cache key, every `?v=…` query string,
and every ETag. Restart the backend to also drop the in-memory LRU.
External scraper caches still need a manual nudge:

- X / Twitter: <https://cards-dev.twitter.com/validator>
- LinkedIn: <https://www.linkedin.com/post-inspector/>
- Facebook / Threads: <https://developers.facebook.com/tools/debug/>