#!/bin/sh
set -eu
umask 077
alembic upgrade head
python seed.py
exec python -m uvicorn juntia.app:app --host 0.0.0.0 --port 7778 --no-access-log \
    --proxy-headers --forwarded-allow-ips "${TRUSTED_PROXY_IPS:-127.0.0.1}"
