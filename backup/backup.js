import { exec } from "child_process";
import fs from "fs";
import path from "path";
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

// Get NODE_ENV for backup naming
const NODE_ENV = process.env.NODE_ENV || "development";

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
const backupDir = path.join(__dirname, "../backup/data/");

// Create backup directory if it doesn't exist
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Function to delete old backups (older than 30 days)
function deleteOldBackups() {
  console.log("Checking for old backups to delete...");

  const files = fs.readdirSync(backupDir);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));

  let deletedCount = 0;
  let deletedSize = 0;

  files.forEach((file) => {
    const filePath = path.join(backupDir, file);
    const stats = fs.statSync(filePath);

    // Check if the file is older than 30 days
    if (stats.mtime < thirtyDaysAgo) {
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`Deleting old backup: ${file} (${fileSizeMB} MB)`);

      try {
        if (fs.statSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
        deletedCount++;
        deletedSize += stats.size;
      } catch (error) {
        console.error(`Error deleting ${file}: ${error.message}`);
      }
    }
  });

  if (deletedCount > 0) {
    const totalSizeMB = (deletedSize / (1024 * 1024)).toFixed(2);
    console.log(
      `Deleted ${deletedCount} old backups (${totalSizeMB} MB freed)`
    );
  } else {
    console.log("No old backups to delete");
  }
}

// Run the cleanup before creating a new backup
deleteOldBackups();

// Timestamp for backup filename
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `${database}-${NODE_ENV}-${timestamp}`);

// Build the mongodump command
let mongodumpCmd = `mongodump --host ${host} --port ${port}`;

// Add authentication if username and password are provided
if (username && password) {
  mongodumpCmd += ` --username ${username} --password ${password} --authenticationDatabase ${authSource}`;
}

// Add database and output path
mongodumpCmd += ` --db ${database} --out ${backupPath}`;

console.log(`Environment: ${NODE_ENV}`);
console.log(`Starting backup of ${database} database...`);
console.log(`Backup will be stored at: ${backupPath}`);

// Execute the mongodump command
exec(mongodumpCmd, (error, stdout, stderr) => {
  if (error) {
    console.error(`Error during backup: ${error.message}`);
    return;
  }

  if (stderr && !stderr.includes("done")) {
    console.error(`MongoDB stderr: ${stderr}`);
  }

  console.log(`MongoDB stdout: ${stdout}`);
  console.log(`Backup completed successfully at: ${backupPath}`);

  // Create a compressed archive of the backup
  const archivePath = `${backupPath}.tar.gz`;
  const compressCmd = `tar -czf ${archivePath} -C ${path.dirname(
    backupPath
  )} ${path.basename(backupPath)}`;

  console.log(`Compressing backup to: ${archivePath}`);

  exec(compressCmd, (compressError, compressStdout, compressStderr) => {
    if (compressError) {
      console.error(`Error compressing backup: ${compressError.message}`);
      return;
    }

    if (compressStderr) {
      console.error(`Compression stderr: ${compressStderr}`);
    }

    console.log(`Backup compressed to: ${archivePath}`);

    // Remove the uncompressed backup directory to save space
    fs.rmSync(backupPath, { recursive: true, force: true });
    console.log(`Removed uncompressed backup directory: ${backupPath}`);

    // Print final success message with file size
    const stats = fs.statSync(archivePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`Backup completed successfully. File size: ${fileSizeMB} MB`);
    console.log(`Backup file: ${archivePath}`);
  });
});
