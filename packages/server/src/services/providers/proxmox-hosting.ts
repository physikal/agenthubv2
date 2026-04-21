import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { proxmoxFetch } from "../../lib/insecure-fetch.js";
import {
  SSH_OPTS,
  assertSafeNode,
  assertSafeStorage,
  pctWriteFile,
  shQuote,
} from "../shell-safety.js";

const execFileAsync = promisify(execFile);

interface ProxmoxHostingConfig {
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
  node: string;
  storage: string;
}

interface ProvisionResult {
  vmid: string;
  ip: string;
  node: string;
}

function pveNodeIp(node: string): string {
  const nodeIps: Record<string, string> = {
    pve05: "192.168.5.100",
    pve06: "192.168.5.101",
    pve07: "192.168.5.102",
  };
  const ip = nodeIps[node];
  if (!ip) throw new Error(`Unknown PVE node: ${node}`);
  return ip;
}

async function pveRequest<T>(
  config: ProxmoxHostingConfig,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
  };
  const init: RequestInit = { method, headers };

  if (body && (method === "POST" || method === "PUT")) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const resp = await proxmoxFetch(url, init);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Proxmox API ${method} ${path} failed (${String(resp.status)}): ${text}`,
    );
  }

  const json = (await resp.json()) as { data: T };
  return json.data;
}

async function waitForTask(
  config: ProxmoxHostingConfig,
  node: string,
  upid: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await pveRequest<{ status: string }>(
      config,
      "GET",
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    );
    if (status.status === "stopped") return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Task ${upid} timed out after ${String(timeoutMs)}ms`);
}

async function sshCommand(
  nodeIp: string,
  command: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "ssh",
    [...SSH_OPTS, `root@${nodeIp}`, command],
    { timeout: 120_000 },
  );
  return stdout.trim();
}

export async function provisionHostingNode(
  config: ProxmoxHostingConfig,
): Promise<ProvisionResult> {
  // Validate inputs before anything reaches the shell — these values are
  // user-supplied via POST /api/infra and flow into `pct create ... --storage ${storage}`
  // over SSH as root on the PVE host. Injection here = hypervisor compromise.
  assertSafeNode(config.node);
  assertSafeStorage(config.storage);

  const pveIp = pveNodeIp(config.node);

  // Get next available VMID via SSH (more reliable than API with pool containers)
  const nextIdStr = await sshCommand(pveIp, "pvesh get /cluster/nextid");
  const vmid = parseInt(nextIdStr, 10);
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999) {
    throw new Error(`Invalid VMID from Proxmox: ${nextIdStr}`);
  }
  const hostname = `hosting-${String(vmid)}`;

  // Find the Debian 12 template (version may vary across nodes). The output
  // comes from `pveam list` on the PVE host and is server-side, but we still
  // shell-quote it below to keep the contract explicit.
  const template = await sshCommand(
    pveIp,
    "pveam list local | grep 'debian-12-standard' | awk '{print $1}' | head -1",
  );
  if (!template) {
    throw new Error("No Debian 12 template found on node. Run: pveam download local debian-12-standard_12.12-1_amd64.tar.zst");
  }

  // Create privileged container with features via SSH — API tokens can't set
  // feature flags or privileged mode on containers (Proxmox restricts to root@pam).
  // Every interpolated value is validated above AND shell-quoted below for
  // defense in depth; one typo in a validator must not become RCE.
  await sshCommand(
    pveIp,
    `pct create ${String(vmid)} ${shQuote(template)}`
      + ` --hostname ${shQuote(hostname)}`
      + ` --storage ${shQuote(config.storage)}`
      + ` --rootfs ${shQuote(`${config.storage}:32`)}`
      + ` --memory 2048 --swap 512 --cores 2`
      + ` --net0 name=eth0,bridge=vmbr0,ip=dhcp`
      + ` --unprivileged 0`
      + ` --features nesting=1,keyctl=1`,
  );

  // Start the container
  await sshCommand(pveIp, `pct start ${String(vmid)}`);

  // Wait for network — get IP via pct exec (faster than Proxmox API /interfaces)
  await new Promise((r) => setTimeout(r, 5_000));

  let ip: string | null = null;
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const result = await sshCommand(
        pveIp,
        `pct exec ${String(vmid)} -- ip -4 addr show eth0 2>/dev/null | grep -oP 'inet \\K[0-9.]+'`,
      );
      if (result && /^\d+\.\d+\.\d+\.\d+$/.test(result)) {
        ip = result;
        break;
      }
    } catch {
      // retry — container may still be booting
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  if (!ip) {
    throw new Error(
      `Hosting node ${String(vmid)} did not get an IP within 30s`,
    );
  }

  // Install Docker + Traefik via SSH to the PVE node, then into the container.
  // Setup script is a static string — no interpolation, safe to embed.
  const setupScript = [
    "apt-get update",
    "apt-get install -y ca-certificates curl gnupg",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc",
    "chmod a+r /etc/apt/keyrings/docker.asc",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "systemctl enable docker",
    "systemctl start docker",
    "mkdir -p /opt/apps",
    "mkdir -p /opt/traefik",
  ].join(" && ");

  await sshCommand(pveIp, `pct exec ${String(vmid)} -- bash -c ${shQuote(setupScript)}`);

  // Write Traefik compose via stdin — immune to heredoc-terminator injection.
  const traefikCompose = `
version: "3.8"
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
`.trim();

  await pctWriteFile(pveIp, vmid, "/opt/traefik/docker-compose.yml", traefikCompose);
  await sshCommand(
    pveIp,
    `pct exec ${String(vmid)} -- bash -c 'cd /opt/traefik && docker compose up -d'`,
  );

  // Set up SSH access from the server pod to the hosting node
  await sshCommand(
    pveIp,
    `pct exec ${String(vmid)} -- bash -c 'apt-get install -y openssh-server && mkdir -p /root/.ssh && chmod 700 /root/.ssh'`,
  );

  // Copy the PVE SSH public key into the hosting node for server access
  await sshCommand(
    pveIp,
    `pct push ${String(vmid)} /root/.ssh/authorized_keys /root/.ssh/authorized_keys`,
  );

  return {
    vmid: String(vmid),
    ip,
    node: config.node,
  };
}

export async function verifyHostingNode(ip: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [...SSH_OPTS, `root@${ip}`, "docker info --format '{{.ServerVersion}}' && docker compose version --short"],
      { timeout: 15_000 },
    );
    return stdout.includes(".");
  } catch {
    return false;
  }
}

export async function destroyHostingNode(
  config: ProxmoxHostingConfig,
  vmid: string,
  node: string,
): Promise<void> {
  assertSafeNode(node);
  const vmidNum = parseInt(vmid, 10);
  if (!Number.isInteger(vmidNum) || vmidNum < 100) {
    throw new Error(`Invalid vmid: ${vmid}`);
  }

  // Stop first
  try {
    const stopUpid = await pveRequest<string>(
      config,
      "POST",
      `/nodes/${node}/lxc/${String(vmidNum)}/status/stop`,
    );
    await waitForTask(config, node, stopUpid, 30_000);
  } catch {
    // May already be stopped
  }

  // Destroy
  await pveRequest<string>(
    config,
    "DELETE",
    `/nodes/${node}/lxc/${String(vmidNum)}?purge=1&force=1`,
  );
}
