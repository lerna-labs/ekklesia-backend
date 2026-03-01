const path = require("path");

module.exports = {
  apps: [
    {
      name: "ekklesia-backend-development",
      script: path.resolve(__dirname, "server.js"),
      watch: true,
      ignore_watch: ["node_modules", "logs", "backup", "scripts", "public", ".git", ".DS_Store"],
      watch_options: {
        followSymlinks: false,
        usePolling: true,
      },
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.resolve(__dirname, "logs/ekklesia-backend-development-error.log"),
      out_file: path.resolve(__dirname, "logs/ekklesia-backend-development-output.log"),
      combine_logs: true,
      merge_logs: true,
      time: true,
      max_logs: "30d",
      log_size: "50M",
    },
    // Backup job - runs in both environments
    // {
    //   name: "mainnet-backup",
    //   script: path.resolve(__dirname, "backup/backup.js"),
    //   watch: false,
    //   autorestart: false,
    //   cron_restart: "0 */1 * * *",
    //   env: {
    //     NODE_ENV: "production",
    //   },
    //   log_date_format: "YYYY-MM-DD HH:mm:ss",
    //   error_file: path.resolve(__dirname, "logs/backup-error.log"),
    //   out_file: path.resolve(__dirname, "logs/backup-output.log"),
    //   combine_logs: true,
    //   merge_logs: true,
    //   time: true,
    //   max_logs: "30d",
    //   log_size: "10M",
    // },
    // Ten-minute job
    {
      name: "ekklesia-backend-development-cron10min",
      script: path.resolve(__dirname, "crons/10min.js"),
      watch: false,
      autorestart: false,
      cron_restart: "*/10 * * * *",
      env: {
        NODE_ENV: "development",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.resolve(__dirname, "logs/ekklesia-backend-development-cron10min-error.log"),
      out_file: path.resolve(__dirname, "logs/ekklesia-backend-development-cron10min-output.log"),
      combine_logs: true,
      merge_logs: true,
      time: true,
      max_logs: "30d",
      log_size: "10M",
    },
    // Minute job
    {
      name: "ekklesia-backend-development-cron1min",
      script: path.resolve(__dirname, "crons/1min.js"),
      watch: false,
      autorestart: false,
      cron_restart: "*/1 * * * *",
      env: {
        NODE_ENV: "development",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.resolve(__dirname, "logs/ekklesia-backend-development-cron1min-error.log"),
      out_file: path.resolve(__dirname, "logs/ekklesia-backend-development-cron1min-output.log"),
      combine_logs: true,
      merge_logs: true,
      time: true,
      max_logs: "30d",
      log_size: "10M",
    },
  ],
};
