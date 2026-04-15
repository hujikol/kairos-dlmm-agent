/**
 * PM2 process manager configuration for kairos.
 *
 * Setup:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js --name kairos
 *   pm2 save
 *   pm2 startup  # generates init script for your OS
 *
 * Useful commands:
 *   pm2 monit              — live dashboard
 *   pm2 logs kairos       — tail logs
 *   pm2 restart kairos    — restart
 *   pm2 stop kairos       — stop
 *   pm2 delete kairos     — remove from PM2
 */
module.exports = {
  apps: [
    {
      name: "kairos",
      script: "src/index.js",
      interpreter: "node",
      node_args: "--require dotenv/config",
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "warn",
        HEALTH_PORT: "3030",
      },
      // Restart policy
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      // Logging
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Graceful shutdown
      kill_timeout: 5000,
      shutdown_with_message: true,
    },
  ],
};
