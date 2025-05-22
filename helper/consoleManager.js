/**
 * Console manager to add log levels to console output
 * This module overrides the default console methods
 */

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleDebug = console.debug;

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/**
 * Initialize console with log levels
 */
export function initializeConsole() {
  // Override console.log
  console.log = (...args) => {
    originalConsoleLog(colors.green + "INFO:" + colors.reset, ...args);
  };

  // Override console.error
  console.error = (...args) => {
    originalConsoleError(
      colors.red + colors.bright + "ERROR:" + colors.reset,
      ...args
    );
  };

  // Override console.warn
  console.warn = (...args) => {
    originalConsoleWarn(colors.yellow + "WARN:" + colors.reset, ...args);
  };

  // Override console.info
  console.info = (...args) => {
    originalConsoleInfo(colors.cyan + "INFO:" + colors.reset, ...args);
  };

  // Override console.debug
  console.debug = (...args) => {
    originalConsoleDebug(colors.magenta + "DEBUG:" + colors.reset, ...args);
  };
}

/**
 * Reset console to original behavior
 */
export function resetConsole() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  console.info = originalConsoleInfo;
  console.debug = originalConsoleDebug;
}
