import { proxmoxFetch } from "../lib/insecure-fetch.js";
import { isInLxcSubnet } from "../lib/subnet.js";

interface ProxmoxConfig {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  allowedNodes: string[];
  templateVmid: number;
  storage: string;
}

interface NodeResource {
  node: string;
  maxmem: number;
  mem: number;
  maxcpu: number;
  cpu: number;
  status: string;
}

interface LxcInfo {
  vmid: number;
  name: string;
  node: string;
  status: string;
  mem: number;
  maxmem: number;
  cpus: number;
  netin: number;
  netout: number;
}

interface LxcInterface {
  name: string;
  inet?: string;
}

export class ProxmoxClient {
  private readonly config: ProxmoxConfig;
  private readonly headers: Record<string, string>;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    this.headers = {
      Authorization: `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.headers["Authorization"]!,
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

  getAllowedNodes(): string[] {
    return this.config.allowedNodes;
  }

  async getNextId(): Promise<number> {
    const id = await this.request<string>("GET", "/cluster/nextid");
    return parseInt(id, 10);
  }

  async selectNode(): Promise<string> {
    const resources = await this.request<NodeResource[]>(
      "GET",
      "/cluster/resources?type=node",
    );

    const available = resources
      .filter(
        (n) =>
          this.config.allowedNodes.includes(n.node) &&
          n.status === "online",
      )
      .sort((a, b) => (b.maxmem - b.mem) - (a.maxmem - a.mem));

    const selected = available[0];
    if (!selected) {
      throw new Error("No available Proxmox nodes");
    }
    return selected.node;
  }

  async cloneTemplate(
    node: string,
    newVmid: number,
    hostname: string,
  ): Promise<string> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/lxc/${String(this.config.templateVmid)}/clone`,
      {
        newid: newVmid,
        hostname,
        full: 1,
        storage: this.config.storage,
      },
    );
  }

  async startLxc(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/lxc/${String(vmid)}/status/start`,
    );
  }

  async stopLxc(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "POST",
      `/nodes/${node}/lxc/${String(vmid)}/status/stop`,
    );
  }

  async destroyLxc(node: string, vmid: number): Promise<string> {
    return this.request<string>(
      "DELETE",
      `/nodes/${node}/lxc/${String(vmid)}?purge=1&force=1`,
    );
  }

  async getLxcStatus(node: string, vmid: number): Promise<LxcInfo> {
    return this.request<LxcInfo>(
      "GET",
      `/nodes/${node}/lxc/${String(vmid)}/status/current`,
    );
  }

  /**
   * Return the LXC's current in-subnet IPv4 address, or null if none.
   *
   * Queries the live `/interfaces` endpoint (DHCP-aware), strips the CIDR
   * suffix, and rejects anything outside the LXC subnet — loopback,
   * link-local, or a rogue bridge IP can never be returned. Falls back
   * to the static `net0` config for the rare case where /interfaces is
   * empty.
   */
  async getLxcIp(node: string, vmid: number): Promise<string | null> {
    try {
      const ifaces = await this.request<LxcInterface[]>(
        "GET",
        `/nodes/${node}/lxc/${String(vmid)}/interfaces`,
      );

      for (const iface of ifaces) {
        if (iface.name === "lo" || !iface.inet) continue;
        const ip = iface.inet.split("/")[0];
        if (ip && isInLxcSubnet(ip)) return ip;
      }
    } catch {
      // /interfaces can fail on just-started containers — try config
    }

    try {
      const config = await this.request<Record<string, string>>(
        "GET",
        `/nodes/${node}/lxc/${String(vmid)}/config`,
      );
      const net0 = config["net0"];
      if (net0) {
        const ipMatch = /ip=(\d+\.\d+\.\d+\.\d+)/.exec(net0);
        const ip = ipMatch?.[1];
        if (ip && isInLxcSubnet(ip)) return ip;
      }
    } catch {
      // ignore
    }

    return null;
  }

  async setStaticIp(
    node: string,
    vmid: number,
    ip: string,
    gateway: string,
    cidr = 23,
  ): Promise<void> {
    const config = await this.request<Record<string, string>>(
      "GET",
      `/nodes/${node}/lxc/${String(vmid)}/config`,
    );
    const net0 = config["net0"];
    if (!net0) throw new Error("No net0 configured");

    const updated = net0.replace(/ip=dhcp|ip=[^,]+/, `ip=${ip}/${String(cidr)},gw=${gateway}`);
    await this.request<null>("PUT", `/nodes/${node}/lxc/${String(vmid)}/config`, {
      net0: updated,
    });
  }

  async setLxcConfig(
    node: string,
    vmid: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.request<null>(
      "PUT",
      `/nodes/${node}/lxc/${String(vmid)}/config`,
      config,
    );
  }

  async waitForStop(
    node: string,
    vmid: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const info = await this.getLxcStatus(node, vmid);
        if (info.status === "stopped") return;
      } catch {
        // Transient errors during shutdown (e.g. "connection reset by peer") — retry
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`Container ${String(vmid)} did not stop within ${String(timeoutMs)}ms`);
  }

  async waitForTask(
    node: string,
    upid: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.request<{ status: string }>(
        "GET",
        `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (status.status === "stopped") return;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`Task ${upid} timed out after ${String(timeoutMs)}ms`);
  }

  async listLxc(node: string): Promise<LxcInfo[]> {
    return this.request<LxcInfo[]>("GET", `/nodes/${node}/lxc`);
  }
}
