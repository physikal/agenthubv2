#!/bin/sh
# Daily-cron loop that regenerates the self-CA leaf cert when < 30 days
# remaining. CA root is not touched. Runs forever inside a sidecar container.
#
# Inputs (env):
#   DOMAIN   — same as init
#   LAN_IP   — same as init
#
# Triggers /init.sh (mounted alongside) with REGEN=1 when renewal needed.
set -eu

: "${DOMAIN:?DOMAIN is required}"
OUT="/out"
THRESHOLD_DAYS=30

apk add --no-cache openssl coreutils >/dev/null

while true; do
  if [ ! -f "$OUT/leaf.crt" ]; then
    echo "[self-ca-renew] no leaf cert yet — sleeping 1h"
    sleep 3600
    continue
  fi

  NOT_AFTER=$(openssl x509 -in "$OUT/leaf.crt" -noout -enddate | sed 's/notAfter=//')
  NOT_AFTER_EPOCH=$(date -d "$NOT_AFTER" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  if [ "$NOT_AFTER_EPOCH" -eq 0 ]; then
    echo "[self-ca-renew] couldn't parse cert end date — sleeping 1h"
    sleep 3600
    continue
  fi
  DAYS_LEFT=$(( (NOT_AFTER_EPOCH - NOW_EPOCH) / 86400 ))

  if [ "$DAYS_LEFT" -lt "$THRESHOLD_DAYS" ]; then
    echo "[self-ca-renew] leaf has $DAYS_LEFT days left (< $THRESHOLD_DAYS) — regenerating"
    REGEN=1 sh /init.sh
  else
    echo "[self-ca-renew] leaf has $DAYS_LEFT days left — no action"
  fi

  # 24h with small jitter (avoid thundering-herd if multiple installs share host)
  # shellcheck disable=SC3028  # ash supports $RANDOM despite being non-POSIX
  sleep $(( 86400 + RANDOM % 600 ))
done
