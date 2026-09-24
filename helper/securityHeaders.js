import helmet from 'helmet';

// Security-header middleware. Factored out of server.js so the exact
// config under test is the one actually mounted in production, not a
// duplicated copy that can silently drift.
//
// Built on top of helmet's secure defaults (default-src/base-uri/
// form-action/frame-ancestors 'self', object-src 'none', script-src-attr
// 'none', style-src 'self' https: 'unsafe-inline', font-src 'self' https:
// data:) with two additions the served SPA build actually needs:
//
//  - script-src 'unsafe-inline': the SvelteKit static-adapter build emits
//    a small inline bootstrap <script> that dynamically imports the
//    hashed entry chunks; its content changes per build, so a static
//    hash/nonce isn't viable here without deeper build coupling.
//  - img-src https:: proposal option images (`option.imageUrl`) are
//    admin-supplied and can point at any host, not just this origin.
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}
