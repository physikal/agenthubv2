#!/bin/sh
# Generates a self-signed CA + leaf cert for AgentHub's self-CA TLS mode.
# Idempotent: re-running on a directory that already has ca.crt + leaf.crt
# is a no-op unless REGEN=1.
#
# Inputs (env):
#   DOMAIN   — the install's primary domain (e.g. agenthub.physhlab.com)
#   LAN_IP   — comma-separated list of IPs to include in SAN
#   REGEN    — non-empty forces leaf regeneration (CA stays the same)
#
# Output: writes to /out (mounted from the traefik-self-ca docker volume):
#   ca.crt + ca.key + leaf.crt + leaf.key + self-ca.yml + last-renewed
set -eu

: "${DOMAIN:?DOMAIN is required}"
LAN_IP="${LAN_IP:-127.0.0.1}"
OUT="/out"
DAYS_CA=3650         # 10y CA — set-and-forget
DAYS_LEAF=825        # 27mo — within Apple's 825-day max + headroom

apk add --no-cache openssl >/dev/null

if [ -f "$OUT/ca.crt" ] && [ -f "$OUT/leaf.crt" ] && [ -z "${REGEN:-}" ]; then
  echo "[self-ca-init] cert + CA already present; skipping (set REGEN=1 to force)"
  exit 0
fi

# CA root — only generate if missing. The root persists across leaf renewals
# so devices that already trust it never need to re-import.
if [ ! -f "$OUT/ca.crt" ]; then
  echo "[self-ca-init] generating CA root for $DOMAIN"
  openssl genrsa -out "$OUT/ca.key" 4096 2>/dev/null
  openssl req -x509 -new -nodes -key "$OUT/ca.key" -sha256 -days "$DAYS_CA" \
    -out "$OUT/ca.crt" -subj "/CN=AgentHub Self-CA ($DOMAIN)"
fi

# Build the SAN list: domain, *.domain, every comma-separated IP
SAN="DNS:${DOMAIN},DNS:*.${DOMAIN}"
echo "$LAN_IP" | tr ',' '\n' | while IFS= read -r ip; do
  ip=$(echo "$ip" | tr -d ' ')
  if [ -n "$ip" ]; then
    printf ",IP:%s" "$ip"
  fi
done > "$OUT/.san-suffix"
SAN="${SAN}$(cat "$OUT/.san-suffix")"
rm -f "$OUT/.san-suffix"

echo "[self-ca-init] generating leaf cert with SAN: $SAN"
openssl req -new -newkey rsa:2048 -nodes -keyout "$OUT/leaf.key" \
  -out "$OUT/leaf.csr" -subj "/CN=$DOMAIN" 2>/dev/null

# extfile via process substitution — shell uses /dev/fd/N
EXTFILE=$(mktemp)
printf "subjectAltName=%s\n" "$SAN" > "$EXTFILE"
openssl x509 -req -in "$OUT/leaf.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -out "$OUT/leaf.crt" -days "$DAYS_LEAF" -sha256 \
  -extfile "$EXTFILE" 2>/dev/null
rm -f "$EXTFILE" "$OUT/leaf.csr"

chmod 0600 "$OUT/ca.key" "$OUT/leaf.key"
chmod 0644 "$OUT/ca.crt" "$OUT/leaf.crt"

# Traefik dynamic-config file pointing at the leaf
cat > "$OUT/self-ca.yml" <<EOF
tls:
  certificates:
    - certFile: /etc/traefik/dynamic/leaf.crt
      keyFile: /etc/traefik/dynamic/leaf.key
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/dynamic/leaf.crt
        keyFile: /etc/traefik/dynamic/leaf.key
EOF

date -Iseconds > "$OUT/last-renewed"
echo "[self-ca-init] done"
