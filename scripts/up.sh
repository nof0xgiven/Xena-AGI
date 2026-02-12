#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "[xena2p0] Starting Temporal (docker compose)..."
docker compose -f infra/docker-compose.temporal.yml up -d

echo "[xena2p0] Waiting for Temporal port..."
for i in {1..60}; do
  if nc -z 127.0.0.1 7233 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[xena2p0] Checking Temporal health..."
temporal operator cluster health --address 127.0.0.1:7233 >/dev/null

echo "[xena2p0] Ensuring namespace xena exists..."
if ! temporal operator namespace describe --address 127.0.0.1:7233 --namespace xena >/dev/null 2>&1; then
  temporal operator namespace create --address 127.0.0.1:7233 --namespace xena --retention 72h >/dev/null
fi

echo "[xena2p0] Building..."
npm run build >/dev/null

echo "[xena2p0] Starting processes (pm2)..."
# Ensure no other local service is occupying the public webhook port.
pm2 stop sandbox-webhook >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs --update-env >/dev/null

echo "[xena2p0] Health checks..."
for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:3001/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:9876/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:3001/healthz" >/dev/null
curl -fsS "http://127.0.0.1:9876/healthz" >/dev/null

echo "[xena2p0] OK"
