module.exports = {
  apps: [
    {
      name: 'my-team',
      script: 'index.js',
      cron_restart: '0 */6 * * *',
      max_memory_restart: '800M',
      error_file: 'logs/error.log',
      out_file: 'logs/output.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
