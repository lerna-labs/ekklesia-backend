import mongoose from 'mongoose';

/**
 * Database connection manager for MongoDB using Mongoose
 * Configures and manages the connection based on environment variables
 * with support for automatic reconnection
 */

let connection = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL = 5000; // 5 seconds

// Flag to track intentional disconnections
let isIntentionalDisconnect = false;

/**
 * Build MongoDB connection string from separate environment variables
 * @returns {string} The complete MongoDB connection URI
 */
function buildConnectionString() {
  const host = process.env.MONGODB_HOST || 'localhost';
  const port = process.env.MONGODB_PORT || '27017';
  const database = process.env.MONGODB_DATABASE;
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  const authSource = process.env.MONGODB_AUTH_SOURCE || 'admin';

  // Check required fields
  if (!database) {
    throw new Error('MONGODB_DATABASE environment variable is not defined');
  }

  // Build connection string
  let mongoUri = 'mongodb://';

  // Add authentication if credentials are provided
  if (username && password) {
    // URI encode the username and password to handle special characters
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    mongoUri += `${encodedUsername}:${encodedPassword}@`;
  }

  // Add host, port, database name, and options
  mongoUri += `${host}:${port}/${database}`;

  // Add auth source if authentication is used
  if (username && password) {
    mongoUri += `?authSource=${authSource}`;
  }

  return mongoUri;
}

/**
 * Connect to MongoDB using environment variables
 * @param {boolean} isReconnectAttempt - Whether this is a reconnection attempt
 * @returns {Promise<mongoose.Connection|null>} The Mongoose connection object or null if connection failed
 */
export async function connectToDatabase(isReconnectAttempt = false) {
  try {
    // Don't create a new connection if one already exists
    if (connection && connection.readyState === 1) {
      console.info('Using existing database connection');
      return connection;
    }

    // Build connection string from environment variables
    const mongoUri = buildConnectionString();

    // Configure Mongoose
    mongoose.set('strictQuery', true);

    // Connect to MongoDB
    if (isReconnectAttempt) {
      console.info(`Reconnection attempt ${reconnectAttempts} to MongoDB...`);
    } else {
      console.info('Connecting to MongoDB...');
      // Reset reconnect attempts counter on fresh connection
      reconnectAttempts = 0;
    }

    await mongoose.connect(mongoUri);
    connection = mongoose.connection;

    // Set up event listeners for the connection
    connection.on('error', (err) => {
      console.error(`MongoDB connection error: ${err}`);
    });

    connection.on('disconnected', () => {
      // Only attempt reconnection if it wasn't an intentional disconnect
      // and we haven't reached max attempts
      if (!isIntentionalDisconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        console.warn('MongoDB disconnected');

        reconnectAttempts++;
        console.info(`Scheduling reconnection attempt in ${RECONNECT_INTERVAL / 1000} seconds...`);

        // Schedule reconnection attempt
        setTimeout(() => {
          connectToDatabase(true).catch((err) => {
            console.error(`Reconnection attempt failed: ${err.message}`);
          });
        }, RECONNECT_INTERVAL);
      } else if (isIntentionalDisconnect) {
        // console.info("Intentional disconnect - not attempting to reconnect");
      } else {
        console.error(
          `Maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
        );
        connection = null;
      }
    });

    // Register cleanup handler for graceful shutdown
    process.on('SIGINT', async () => {
      if (connection) {
        console.info('Closing MongoDB connection due to application termination');
        await connection.close();
        process.exit(0);
      }
    });

    // Log success but mask password
    const dbInfo = `${process.env.MONGODB_HOST}:${process.env.MONGODB_PORT}/${process.env.MONGODB_DATABASE}`;
    console.info(`Successfully connected to MongoDB at ${dbInfo}`);

    // Reset reconnect counter on successful connection
    reconnectAttempts = 0;

    return connection;
  } catch (error) {
    console.error(`Database connection error: ${error.message}`);

    // If this was not already a reconnection attempt, try to reconnect
    if (!isReconnectAttempt && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.info(`Scheduling reconnection attempt in ${RECONNECT_INTERVAL / 1000} seconds...`);

      // Schedule reconnection
      setTimeout(() => {
        connectToDatabase(true).catch((err) => {
          console.error(`Reconnection attempt failed: ${err.message}`);
        });
      }, RECONNECT_INTERVAL);
    }

    // Return null instead of throwing to allow the application to continue
    return null;
  }
}

/**
 * Disconnect from MongoDB
 * @returns {Promise<void>}
 */
export async function disconnectFromDatabase() {
  if (connection) {
    // Set flag before disconnecting to prevent automatic reconnection
    isIntentionalDisconnect = true;

    await mongoose.disconnect();
    connection = null;
    console.info('Disconnected from MongoDB');

    // Reset the flag after a short delay to allow the disconnected event to fire
    setTimeout(() => {
      isIntentionalDisconnect = false;
    }, 1000);
  }
}

/**
 * Check if the database connection is healthy
 * @returns {Promise<boolean>} Connection status
 */
export async function checkDatabaseConnection() {
  try {
    if (connection && connection.readyState === 1) {
      // Previously ran admin().ping() on every request, which hangs
      // indefinitely when the connected user lacks admin-db access
      // (common with devuser + authSource=admin on the docs compose
      // image). readyState === 1 already means the socket is healthy;
      // the mongoose driver itself will surface per-query errors.
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Database health check failed: ${error.message}`);
    return false;
  }
}

/**
 * Get the current database connection status
 * @returns {boolean} Whether the database is connected
 */
export function isDatabaseConnected() {
  return connection !== null && connection.readyState === 1;
}

/**
 * Middleware to check if the database is connected
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const checkDatabaseConnectionMW = async (req, res, next) => {
  const isConnected = await checkDatabaseConnection();
  if (!isConnected) {
    return res.status(503).json({
      status: 'error',
      message: 'Database connection is unavailable',
    });
  }
  next();
};
