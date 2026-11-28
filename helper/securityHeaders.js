import helmet from 'helmet';

// CSP: 'unsafe-inline' script-src for the SvelteKit static bootstrap script; Cloudflare's Web Analytics beacon; https: img-src for admin-supplied option images.
export const CLOUDFLARE_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", "'unsafe-inline'", CLOUDFLARE_BEACON_SRC],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}
