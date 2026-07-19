// express router
import { Router } from 'express';
const router = Router();

// helper
import { isDatabaseConnected } from '../helper/dbManager.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// NOTE on Hydra: this endpoint deliberately does NOT report a
// system-wide "hydra: connected" status. Each ballot can be bound to
// its own Hydra instance via Ballot.hydraEndpoint / hydraRegistry, so
// a single boolean would be misleading. Per-ballot Hydra reachability
// lives on the admin endpoints
// (GET /api/v1/admin/ballots/:id/head-info) where the right endpoint
// is known.

// Get application version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageServerPath = join(__dirname, '../package.json');
const versionFrontendPath = join(__dirname, '../public/version.json');

/**
 * @route GET /api/v0/status
 * @description Get comprehensive system status information including server health, database connection status, network information, and runtime metrics
 * @access Public
 *
 * @returns {Object} 200 - System status object containing:
 *   - status: Overall system status (e.g., "operational")
 *   - message: Human-readable status message
 *   - timestamp: ISO 8601 timestamp when status was generated
 *   - environment: Current deployment environment (e.g., "development", "production")
 *   - network: Name of the blockchain network (e.g., "mainnet", "preprod")
 *   - networkId: Numeric identifier for the blockchain network
 *   - server: Object with uptime, version, nodeVersion, and memoryUsage
 *   - frontend: Version of the frontend application (if available)
 *   - database: Object with connection status and message
 * @returns {Object} 500 - Server error
 */
router.get('/', async (req, res) => {
  // Public health endpoint. Intentionally omits anything that helps
  // an attacker target known CVEs or reason about deployment shape:
  //   - nodeVersion          → reveals known-vulnerable runtime versions
  //   - process.memoryUsage  → load / capacity hints
  //   - process.uptime       → recent-restart / deploy timing
  //   - NODE_ENV             → "production" vs "development" leak
  // Keep only what an external monitor or client needs to verify the
  // service is reachable on the right network with a known API version.
  const currentTime = new Date();

  let serverVersion = 'unknown';
  try {
    const packageData = await fs.readFile(packageServerPath, 'utf8');
    const packageJson = JSON.parse(packageData);
    serverVersion = packageJson.version || 'unknown';
  } catch (error) {
    console.error(`Failed to read package.json: ${error.message}`);
  }

  let frontendVersion = 'unknown';
  try {
    const packageData = await fs.readFile(versionFrontendPath, 'utf8');
    const packageJson = JSON.parse(packageData);
    frontendVersion = packageJson || 'unknown';
  } catch (error) {
    console.error(`Failed to read frontend/package.json: ${error.message}`);
  }

  return res.json({
    status: 'operational',
    message: 'System is operational',
    timestamp: currentTime.toISOString(),
    network: process.env.NETWORK_NAME,
    networkId: parseInt(process.env.NETWORK_ID),
    server: { version: serverVersion },
    frontend: frontendVersion,
    database: isDatabaseConnected() ? 'connected' : 'disconnected',
  });
});

/**
 * @route GET /api/v0/status/health
 * @description Simple health check endpoint for load balancers and monitoring tools. Always returns 200 OK unless the server is completely down.
 * @access Public
 *
 * @returns {Object} 200 - Health status object with status: "healthy"
 */
router.get('/health', (req, res) => {
  // This endpoint always returns 200 OK unless the server is completely down
  // Useful for load balancers and basic monitoring tools
  res.status(200).json({ status: 'healthy' });
});

/**
 * @route GET /api/v0/status/db
 * @description Get database connection status and health information
 * @access Public
 *
 * @returns {Object} 200 - Database status object containing:
 *   - status: "connected" or "disconnected"
 *   - message: Human-readable message about database connection status
 */
router.get('/db', (req, res) => {
  res.json({
    status: isDatabaseConnected() ? 'connected' : 'disconnected',
    message: isDatabaseConnected()
      ? 'Database connection is healthy'
      : 'Database connection is down, attempting to reconnect automatically',
  });
});

export default router;
