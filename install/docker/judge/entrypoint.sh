#!/bin/sh

set -eu

BACKEND_WAIT_URL="${HYDRO_BACKEND_WAIT_URL:-http://host.docker.internal:2333/status}"
BACKEND_WAIT_INTERVAL="${HYDRO_BACKEND_WAIT_INTERVAL:-2}"

pm2 start sandbox -- -mount-conf /root/.hydro/mount.yaml

echo "[entrypoint] Waiting for backend at ${BACKEND_WAIT_URL}"
until wget -qO- "$BACKEND_WAIT_URL" >/dev/null 2>&1; do
    echo "[entrypoint] Backend is not ready yet, retrying in ${BACKEND_WAIT_INTERVAL}s"
    sleep "$BACKEND_WAIT_INTERVAL"
done

echo "[entrypoint] Backend is ready, starting hydrojudge"
exec pm2-runtime start hydrojudge
