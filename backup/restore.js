import { exec } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { loadEnvironmentVariables } from "../helper/envLoader.js";

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
try {
  // Load from project root (one directory up from backup folder)
  loadEnvironmentVariables(path.resolve(__dirname, ".."));
} catch (error) {
  console.error(`Error loading environment variables: ${error.message}`);
  process.exit(1);
}

// MongoDB connection details from environment variables
const host = process.env.MONGODB_HOST || "localhost";
const port = process.env.MONGODB_PORT || "27017";
const database = process.env.MONGODB_DATABASE;
const username = process.env.MONGODB_USERNAME;
const password = process.env.MONGODB_PASSWORD;
const authSource = process.env.MONGODB_AUTH_SOURCE || "admin";

// Validate required environment variables
if (!database) {
  console.error("Error: MONGODB_DATABASE environment variable is required");
  process.exit(1);
}

// Backup directory
const backupDir = path.join(__dirname, "data/");

// Check if backup directory exists
if (!fs.existsSync(backupDir)) {
  console.error(`Backup directory not found: ${backupDir}`);
  process.exit(1);
}

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Get list of backup files
function getBackupFiles() {
  const files = fs
    .readdirSync(backupDir)
    .filter((file) => file.endsWith(".tar.gz") && file.includes(database))
    .sort((a, b) => {
      // Sort by modification time (newest first)
      return (
        fs.statSync(path.join(backupDir, b)).mtime.getTime() -
        fs.statSync(path.join(backupDir, a)).mtime.getTime()
      );
    });

  if (files.length === 0) {
    console.error(`No backup files found in ${backupDir}`);
    process.exit(1);
  }

  return files;
}

// Display available backups
function displayBackups(files) {
  console.log("Available backups:");

  files.forEach((file, index) => {
    const stats = fs.statSync(path.join(backupDir, file));
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const modDate = stats.mtime.toLocaleString();

    console.log(`[${index + 1}] ${file} (${fileSizeMB} MB, ${modDate})`);
  });
}

// Restore function
async function restoreBackup(
  backupFile,
  customDatabase = database,
  customHost = host
) {
  return new Promise((resolve, reject) => {
    // Use the customDatabase and customHost variables instead of the global ones
    const backupPath = path.join(backupDir, backupFile);
    const extractDir = path.join(backupDir, "temp_restore");

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    } else {
      // Clean up existing temp directory
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
    }

    console.log(`Extracting backup file: ${backupFile}`);

    // Extract the tar.gz file
    const extractCmd = `tar -xzf ${backupPath} -C ${extractDir}`;

    exec(extractCmd, (extractError, extractStdout, extractStderr) => {
      if (extractError) {
        console.error(`Error extracting backup: ${extractError.message}`);
        reject(extractError);
        return;
      }

      // Find the extracted database directory
      let dbDir = findMongoDbDumpDirectory(extractDir);

      if (!dbDir) {
        console.error(
          "Could not find valid MongoDB dump directory in the backup"
        );
        reject(new Error("No valid MongoDB dump directory found"));
        return;
      }

      console.log(`Found database directory: ${dbDir}`);

      // Detect source database name from path
      const sourceDirParts = dbDir.split("/");
      let sourceDbName = "";
      // Look for the DB name in the path
      for (let i = sourceDirParts.length - 1; i >= 0; i--) {
        if (
          sourceDirParts[i] !== customDatabase &&
          !sourceDirParts[i].includes(".") &&
          sourceDirParts[i] !== "temp_restore"
        ) {
          sourceDbName = sourceDirParts[i];
          break;
        }
      }

      // If source and target databases are different, ask user for confirmation
      if (sourceDbName && sourceDbName !== customDatabase) {
        rl.question(
          `\nThe backup is from database "${sourceDbName}" but your .env file specifies "${customDatabase}". 
Do you want to restore to "${customDatabase}"? (y/n): `,
          (answer) => {
            if (answer.toLowerCase() !== "y") {
              console.log("Restore cancelled");
              fs.rmSync(extractDir, { recursive: true, force: true });
              reject(new Error("Restore cancelled by user"));
              return;
            }

            // User confirmed, proceed with restore
            proceedWithRestore(sourceDbName, customDatabase);
          }
        );
      } else {
        // No database name difference, proceed directly
        proceedWithRestore(sourceDbName, customDatabase);
      }

      function proceedWithRestore(sourceDbName, targetDatabase) {
        // Build the mongorestore command
        let mongorestoreCmd = `mongorestore --host ${customHost} --port ${port}`;

        // Add authentication if username and password are provided
        if (username && password) {
          mongorestoreCmd += ` --username ${username} --password ${password} --authenticationDatabase ${authSource}`;
        }

        // Get the parent directory of where the BSON files are located (MongoDB dump structure)
        const dumpDir = path.dirname(dbDir);

        // If source and target database names are different, use namespace mapping
        if (sourceDbName && sourceDbName !== targetDatabase) {
          console.log(
            `Restoring from source database "${sourceDbName}" to target database "${targetDatabase}"`
          );
          // Use the directory structure to properly map the namespaces
          mongorestoreCmd += ` --nsFrom="${sourceDbName}.*" --nsTo="${targetDatabase}.*" --drop "${dumpDir}"`;
        } else {
          // Use standard approach
          mongorestoreCmd += ` --db=${targetDatabase} --drop "${dbDir}"`;
        }

        console.log(`Restoring database ${targetDatabase}...`);
        console.log(`Using command: ${mongorestoreCmd}`);

        // Execute the mongorestore command
        exec(mongorestoreCmd, (restoreError, restoreStdout, restoreStderr) => {
          // Clean up the temp directory
          fs.rmSync(extractDir, { recursive: true, force: true });

          if (restoreError) {
            console.error(`Error during restore: ${restoreError.message}`);
            reject(restoreError);
            return;
          }

          if (restoreStderr && !restoreStderr.includes("done")) {
            console.error(`MongoDB stderr: ${restoreStderr}`);
          }

          console.log(
            `Restore completed successfully to database: ${targetDatabase}`
          );
          resolve();
        });
      }
    });
  });
}

// Add this helper function to find the directory with MongoDB files
function findMongoDbDumpDirectory(startDir) {
  // Check if this directory contains .bson files (MongoDB data files)
  const hasMongoFiles = fs
    .readdirSync(startDir)
    .some((file) => file.endsWith(".bson"));
  if (hasMongoFiles) {
    return startDir;
  }

  // If not, look in subdirectories (one level deep)
  for (const item of fs.readdirSync(startDir)) {
    const itemPath = path.join(startDir, item);
    if (fs.statSync(itemPath).isDirectory()) {
      // Check this subdirectory for .bson files
      if (fs.readdirSync(itemPath).some((file) => file.endsWith(".bson"))) {
        return itemPath;
      }

      // Check one more level deeper
      for (const subItem of fs.readdirSync(itemPath)) {
        const subItemPath = path.join(itemPath, subItem);
        if (
          fs.statSync(subItemPath).isDirectory() &&
          fs.readdirSync(subItemPath).some((file) => file.endsWith(".bson"))
        ) {
          return subItemPath;
        }
      }
    }
  }

  return null;
}

// Check required commands
function checkRequiredCommands() {
  console.log("Checking required commands...");

  return new Promise((resolve, reject) => {
    exec("which mongorestore", (error) => {
      if (error) {
        console.error("\nError: 'mongorestore' command not found.");
        console.error("Please install MongoDB Database Tools:");
        console.error(
          "  - macOS: brew install mongodb/brew/mongodb-database-tools"
        );
        console.error(
          "  - Linux: apt-get install mongodb-database-tools or equivalent"
        );
        reject(new Error("Required command not found"));
      } else {
        console.log("✅ mongorestore found");
        resolve();
      }
    });
  });
}

// Main function
async function main() {
  try {
    await checkRequiredCommands();
    const backupFiles = getBackupFiles();
    displayBackups(backupFiles);

    // Store original values from environment
    let targetDatabase = database;
    let targetHost = host;

    rl.question(
      "\nEnter the number of the backup to restore (or 'q' to quit): ",
      async (answer) => {
        if (answer.toLowerCase() === "q") {
          console.log("Restore cancelled");
          rl.close();
          return;
        }

        const backupIndex = parseInt(answer) - 1;

        if (
          isNaN(backupIndex) ||
          backupIndex < 0 ||
          backupIndex >= backupFiles.length
        ) {
          console.error("Invalid selection");
          rl.close();
          return;
        }

        const selectedBackup = backupFiles[backupIndex];

        // Ask about target database
        rl.question(
          `\nDo you want to restore to a different database than "${targetDatabase}"? (y/n): `,
          (changeDatabaseAnswer) => {
            if (changeDatabaseAnswer.toLowerCase() === "y") {
              rl.question("\nEnter target database name: ", (dbName) => {
                targetDatabase = dbName.trim();
                confirmHostAndRestore();
              });
            } else {
              confirmHostAndRestore();
            }

            function confirmHostAndRestore() {
              rl.question(
                `\nConfirm database host: ${targetHost}. Is this correct? (y/n): `,
                (confirmHostAnswer) => {
                  if (confirmHostAnswer.toLowerCase() !== "y") {
                    rl.question(
                      "\nEnter the database host IP address: ",
                      (hostInput) => {
                        targetHost = hostInput.trim();
                        proceedWithRestore();
                      }
                    );
                  } else {
                    proceedWithRestore();
                  }
                }
              );
            }

            function proceedWithRestore() {
              // Confirm before proceeding
              rl.question(
                `\nAre you sure you want to restore ${selectedBackup} to database "${targetDatabase}" at ${targetHost}? This will OVERWRITE the current database. (y/n): `,
                async (confirm) => {
                  if (confirm.toLowerCase() !== "y") {
                    console.log("Restore cancelled");
                    rl.close();
                    return;
                  }

                  console.log(
                    `\nRestoring backup: ${selectedBackup} to ${targetDatabase} at ${targetHost}`
                  );

                  try {
                    // Pass the custom database and host to the restore function
                    await restoreBackup(
                      selectedBackup,
                      targetDatabase,
                      targetHost
                    );
                    console.log("Restore process completed");
                  } catch (error) {
                    console.error(`Restore failed: ${error.message}`);
                  }

                  rl.close();
                }
              );
            }
          }
        );
      }
    );
  } catch (error) {
    console.error(`Error: ${error.message}`);
    rl.close();
  }
}

// Start the restore process
main();
