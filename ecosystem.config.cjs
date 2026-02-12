const dotenvPath = '/Users/ava/xena 2p0/.env';
const envVars = {};
try {
  require('fs')
    .readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) envVars[match[1].trim()] = match[2].trim();
    });
} catch (e) {}

module.exports = {
  apps: [
    {
      name: 'xena2p0-server',
      script: './dist/server/index.js',
      cwd: '/Users/ava/xena 2p0',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...envVars,
      },
    },
    {
      name: 'xena2p0-worker',
      script: './dist/temporal/worker.js',
      cwd: '/Users/ava/xena 2p0',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...envVars,
      },
    },
    {
      name: 'xena2p0-ingress',
      script: './dist/ingress/index.js',
      cwd: '/Users/ava/xena 2p0',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...envVars,
      },
    },
  ],
};
