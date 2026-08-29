#!/usr/bin/env bash
# Recreate the `prospect` container. THE deploy step for a CODE change.
#
# Why this file exists: `docker restart prospect` reuses the OLD image, so it ships data
# changes only — a code deploy needs stop/rm/run, and that needs the exact runtime flags.
# Those flags lived nowhere but the running container's own metadata until 2026-08-29;
# `docker inspect` was the only record, so losing the container lost the deploy recipe.
#
# Captured from the live container (image prospect:pr106) on 2026-08-29:
#   restart=unless-stopped, 127.0.0.1:8080->8080, /root/prospect/data:/app/data
# Every PROSPECT_* env var is baked into the image (Dockerfile ENV block), so there are
# deliberately no -e flags here — adding one would silently diverge from the image default.
#
# Usage:  ./run-prospect.sh [image-tag]      e.g. ./run-prospect.sh prospect:pr108
set -euo pipefail

IMAGE="${1:-${PROSPECT_IMAGE:-}}"
if [ -z "$IMAGE" ]; then
    IMAGE="$(docker inspect prospect --format '{{.Config.Image}}' 2>/dev/null || true)"
    [ -n "$IMAGE" ] || { echo "usage: $0 <image-tag>   (no running container to copy the tag from)" >&2; exit 2; }
    echo "[run] no tag given; reusing the running container's image: $IMAGE"
fi

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "[run] no such image: $IMAGE" >&2; exit 2; }

# The port is bound to 127.0.0.1 only — nginx terminates TLS in front of it. Binding
# 0.0.0.0 here would publish the API straight to the internet, bypassing it.
PREV="$(docker inspect prospect --format '{{.Config.Image}}' 2>/dev/null || echo none)"
echo "[run] replacing container: $PREV -> $IMAGE"

docker stop prospect >/dev/null 2>&1 || true
docker rm   prospect >/dev/null 2>&1 || true

docker run -d \
    --name prospect \
    --restart unless-stopped \
    -p 127.0.0.1:8080:8080 \
    -v /root/prospect/data:/app/data \
    "$IMAGE" >/dev/null

# Readiness, not liveness: /api/health answers 200 with status "degraded" when the mart
# failed to open, so polling it would call a data-less container healthy.
for i in $(seq 1 60); do
    code="$(docker exec prospect python -c 'import urllib.request,sys
try:
    r = urllib.request.urlopen("http://127.0.0.1:8080/api/health/ready", timeout=3)
    print(r.status)
except Exception as e:
    print(getattr(e, "code", 0))' 2>/dev/null || echo 0)"
    if [ "$code" = "200" ]; then
        echo "[run] ready after ${i}s: $(curl -fsS http://127.0.0.1:8080/api/health 2>/dev/null || echo '(health body unavailable)')"
        exit 0
    fi
    sleep 1
done

echo "[run] FAILED: /api/health/ready never returned 200. Container logs:" >&2
docker logs --tail 40 prospect >&2
echo "[run] previous image was $PREV — re-run this script with that tag to go back." >&2
exit 1
