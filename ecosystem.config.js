// PM2 config for EC2: keeps the API running, restarts it on crash and after reboot.
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup
//   pm2 logs p14-api
module.exports = {
  apps: [
    {
      name: 'p14-api',
      script: 'src/server.js',
      instances: 1, // single instance: the rate limiter keeps its counters in memory
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
