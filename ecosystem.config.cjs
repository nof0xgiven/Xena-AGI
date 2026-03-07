module.exports = {
  apps: [
    {
      name: "xena-api",
      script: "./scripts/start-xena-api.sh",
      cwd: "/Users/ava/main/projects/openSource/xena",
      env: {
        NODE_OPTIONS:
          "--max-old-space-size=6144 --localstorage-file=.trigger/localstorage.json",
        XENA_API_PORT: "18791"
      },
      interpreter: "bash",
      watch: false
    },
    {
      name: "xena-trigger",
      script: "./scripts/start-xena-trigger.sh",
      cwd: "/Users/ava/main/projects/openSource/xena",
      interpreter: "bash",
      watch: false
    },
    {
      name: "xena-ngrok",
      script: "/opt/homebrew/bin/ngrok",
      args: "http 18791 --url https://xena.ngrok.app --inspect=false --log=stdout --log-format=logfmt",
      cwd: "/Users/ava/main/projects/openSource/xena",
      interpreter: "none",
      watch: false
    }
  ]
};
