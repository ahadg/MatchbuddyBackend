module.exports = {
  apps: [
    {
      name: 'matchbuddy-backend',
      script: './src/server.js',
      instances: 1, // Must be 1 (fork mode) because WebSockets use in-memory state for subscribers
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
