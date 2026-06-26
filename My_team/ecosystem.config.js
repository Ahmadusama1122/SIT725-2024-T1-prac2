module.exports = {
  apps: [
    {
      name: 'my-team',
      script: 'index.js',
      max_memory_restart: '800M',
      instances: 1,
      exec_mode: 'fork',
      error_file: 'logs/error.log',
      out_file: 'logs/output.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
