const path = require('path');
const projectRoot = path.resolve(__dirname);
const dotenvPath = path.join(projectRoot, '.env');
const envVars = {};
try {
  require('fs')
    .readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (!match) return;
      const key = match[1].trim();
      const value = match[2].trim();
      if (!key || value.length === 0) return;
      envVars[key] = value;
    });
} catch (e) {}

module.exports = {
  apps: [
    {
      name: 'xena2p0-server',
      script: './dist/server/index.js',
      cwd: projectRoot,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        XENA_ROOT: projectRoot,
        ...envVars,
      },
    },
    {
      name: 'xena2p0-worker',
      script: './dist/temporal/worker.js',
      cwd: projectRoot,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        XENA_ROOT: projectRoot,
        ...envVars,
      },
    },
    {
      name: 'xena2p0-ingress',
      script: './dist/ingress/index.js',
      cwd: projectRoot,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        XENA_ROOT: projectRoot,
        ...envVars,
      },
    },
  ],
};
