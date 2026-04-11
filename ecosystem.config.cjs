module.exports = {
  apps: [{
    name: 'bot-portal',
    script: './server/src/index.js',
    instances: 1,
    exec_mode: 'fork',
    node_args: '--experimental-vm-modules',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
