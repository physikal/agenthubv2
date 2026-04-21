#!/usr/bin/env bash
set -euo pipefail

# Hosting Node Template Setup
# Creates a persistent LXC with Docker + Traefik for app deployments.
# Run inside a privileged Debian 12 LXC container.
#
# Usage: pct exec <VMID> -- bash < hosting-template.sh

echo "[hosting] Installing Docker CE..."
apt-get update -qq
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "[hosting] Setting up directories..."
mkdir -p /opt/apps /opt/traefik

echo "[hosting] Creating Traefik configuration..."
cat > /opt/traefik/docker-compose.yml << 'EOF'
services:
  traefik:
    image: traefik:v3.3
    restart: unless-stopped
    command:
      - "--api.insecure=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-certs:/letsencrypt

volumes:
  traefik-certs:
EOF

echo "[hosting] Starting Traefik..."
cd /opt/traefik && docker compose up -d

echo "[hosting] Installing SSH server..."
apt-get install -y openssh-server
mkdir -p /root/.ssh
chmod 700 /root/.ssh
systemctl enable ssh

echo "[hosting] Configuring firewall (iptables)..."
apt-get install -y iptables-persistent

iptables -F
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p icmp -j ACCEPT
iptables -A INPUT -j DROP

iptables-save > /etc/iptables/rules.v4

echo "[hosting] Setup complete. Docker + Traefik running."
docker --version
docker compose version
