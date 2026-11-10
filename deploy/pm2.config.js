# Monitour PM2 Ecosystem Configuration
# Usage: pm2 start deploy/pm2.config.js

module.exports = {
  apps: [
    {
      name: 'monitour-server',
      cwd: './server',
      script: 'dist/index.js',
      instances: 1, // Socket.IO requires sticky sessions for multi-instance
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 4430,
        HOST: '127.0.0.1',
        MONGO_URI: 'mongodb://127.0.0.1:27017/monitour',
        JWT_SECRET: 'CHANGE_ME_TO_A_RANDOM_64_CHAR_STRING',
        JWT_EXPIRES_IN: '24h',
        DEVICE_JWT_EXPIRES_IN: '365d',
        DATA_DIR: './data',
        CORS_ORIGIN: 'https://monitour.yourdomain.com',
        LOG_LEVEL: 'info',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      restart_delay: 5000,
    },
  ],
};
