/**
 * Middleware to set Cache-Control headers based on request type and authentication
 *
 * @param {number} maxAge - Maximum age in seconds for caching GET requests (default: 0)
 * @returns {Function} Express middleware function that sets Cache-Control headers
 *
 * @description
 * For authenticated requests or non-GET requests:
 * - Sets "Cache-Control: no-store" to prevent caching
 *
 * For public GET requests without authentication:
 * - Sets "Cache-Control: public, max-age=X" where X is the provided maxAge
 */
export const cacheControl = (maxAge = 0) => {
  return (req, res, next) => {
    // For user-specific routes or POST/PUT requests, disable cache
    if (req.method !== 'GET' || req.headers.authorization) {
      res.set('Cache-Control', 'no-store');
    } else {
      // For GET requests without auth, set cache as specified
      res.set('Cache-Control', `public, max-age=${maxAge}`);
    }
    next();
  };
};
