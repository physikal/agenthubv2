import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { PoolContainerRow, PoolContainerState } from "../db/schema.js";
import type { ProxmoxClient } from "./proxmox.js";
import { SSH_OPTS, pctWriteFile } from "./shell-safety.js";

const SSH_ARGS = SSH_OPTS;
const execFileAsync = promisify(execFile);

async function runSsh(nodeIp: string, command: string, timeoutMs: number): Promise<void> {
  await execFileAsync("ssh", [...SSH_ARGS, `root@${nodeIp}`, command], { timeout: timeoutMs });
}

interface PoolContainer {
  vmid: number;
  node: string;
  ip: string | null;
  agentToken: string;
  createdAt: number;
}

interface PoolConfig {
  targetSize: number;
  ttlMs: number;
  checkIntervalMs: number;
}

/**
 * Warm pool of LXC containers.
 *
 * State durability: every transition (provisioning → pending → ready → claim)
 * is mirrored to the `pool_containers` table. On startup, `hydrateFromDb()`
 * rebuilds in-memory state from the DB and reconciles with Proxmox reality —
 * containers that no longer exist (or have stopped) are discarded; DB rows
 * referencing missing containers are deleted. This closes the "pod restart
 * mid-provision leaks containers against the hard cap" hole.
 *
 * Once claimed, the row is deleted — from that point the `sessions` row
 * (lxcVmid/Node/Ip) is authoritative and the pool no longer tracks it.
 */
export class ContainerPool {
  private readonly proxmox: ProxmoxClient;
  private readonly templateVmid: number;
  private readonly storage: string;
  private readonly config: PoolConfig;
  private readonly ready: PoolContainer[] = [];
  private readonly pending = new Map<
    number,
    { node: string; agentToken: string; createdAt: number }
  >();
  private readonly provisioning = new Set<number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly nodeIps: Record<string, string>;
  private readonly portalUrl: string;
  private readonly agentAuthToken: string;
  /** Max time to wait for agent registration before destroying. */
  private static readonly PENDING_TIMEOUT_MS = 8 * 60_000;
  /** Hard cap on lxc-pool-* containers across all nodes. */
  private static readonly MAX_POOL_CONTAINERS = 10;
  /** Stop provisioning after this many consecutive failures. */
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  /** Auto-reset circuit breaker after this duration. */
  private static readonly CIRCUIT_BREAKER_RESET_MS = 10 * 60_000;
  /** Cache the Proxmox listLxc result for the hard-cap check. */
  private static readonly LIST_CACHE_MS = 15_000;
  /** Bound on parallel destroys kicked off by expirePending. */
  private static readonly DESTROY_CONCURRENCY = 2;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitOpenedAt = 0;
  private maintaining = false;
  private readonly listCache = new Map<
    string,
    { at: number; containers: Array<{ vmid: number; name: string; status: string }> }
  >();

  constructor(
    proxmox: ProxmoxClient,
    templateVmid: number,
    storage: string,
    config?: Partial<PoolConfig>,
    nodeIps?: Record<string, string>,
    portalUrl?: string,
    agentAuthToken?: string,
  ) {
    this.proxmox = proxmox;
    this.templateVmid = templateVmid;
    this.storage = storage;
    this.config = {
      targetSize: config?.targetSize ?? 1,
      ttlMs: config?.ttlMs ?? 30 * 60_000,
      checkIntervalMs: config?.checkIntervalMs ?? 60_000,
    };
    this.nodeIps = nodeIps ?? {};
    this.portalUrl = portalUrl ?? "";
    this.agentAuthToken = agentAuthToken ?? "";
  }

  private readonly ipCallbacks = new Map<number, (ip: string) => void>();

  /**
   * Rebuild in-memory state from `pool_containers` and reconcile with Proxmox.
   * Must be called ONCE at startup, after Proxmox client is initialized and
   * before `start()`. Rows whose containers no longer exist or aren't running
   * are removed — preventing the hard-cap leak when a pod crashed mid-claim.
   */
  async hydrateFromDb(): Promise<void> {
    const rows = db.select().from(schema.poolContainers).all();
    if (rows.length === 0) return;

    console.log(`[pool] hydrating ${String(rows.length)} row(s) from db`);

    // Guard against a known-observed inconsistency: a pool_containers row
    // surviving a session claim. If the row says VMID 101 is ready AND
    // sessions.lxcVmid=101 is already bound to a live session, the next
    // claim would hand out the same VMID twice (two sessions → one LXC,
    // whichever agent WS connects first wins and kicks the other).
    //
    // Any session that isn't completed/failed still considers the container
    // its own, so it takes precedence over the pool row.
    const liveSessionVmids = new Set(
      db
        .select({ vmid: schema.sessions.lxcVmid, status: schema.sessions.status })
        .from(schema.sessions)
        .all()
        .filter((r) => r.vmid != null && r.status !== "completed" && r.status !== "failed")
        .map((r) => r.vmid as number),
    );

    // Group live containers by node so we only hit Proxmox once per node.
    const liveByNode = new Map<string, Map<number, string>>();
    for (const node of this.proxmox.getAllowedNodes()) {
      try {
        const containers = await this.listLxcCached(node);
        const byVmid = new Map<number, string>();
        for (const ct of containers) byVmid.set(ct.vmid, ct.status);
        liveByNode.set(node, byVmid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`[pool] hydrate: can't list ${node}: ${msg} — keeping rows for that node`);
      }
    }

    for (const row of rows) {
      // Session claim always wins over pool row — drop the row without
      // destroying the container (the session is still using it).
      if (liveSessionVmids.has(row.vmid)) {
        console.warn(
          `[pool] hydrate: dropping row vmid=${String(row.vmid)} — already claimed by an active session`,
        );
        db.delete(schema.poolContainers).where(eq(schema.poolContainers.vmid, row.vmid)).run();
        continue;
      }

      const nodeMap = liveByNode.get(row.node);
      const status = nodeMap?.get(row.vmid);

      // Discard if Proxmox query succeeded and the container is gone or stopped.
      if (nodeMap && (status === undefined || status !== "running")) {
        console.log(
          `[pool] hydrate: dropping row vmid=${String(row.vmid)} (proxmox status: ${status ?? "missing"})`,
        );
        db.delete(schema.poolContainers).where(eq(schema.poolContainers.vmid, row.vmid)).run();
        // Best-effort destroy — if it exists but stopped, remove it.
        if (status !== undefined) {
          this.scheduleDestroy(row.node, row.vmid);
        }
        continue;
      }

      // Restore to the appropriate in-memory bucket.
      this.restoreRow(row);
    }

    console.log(
      `[pool] hydrated: ready=${String(this.ready.length)} pending=${String(this.pending.size)} provisioning=${String(this.provisioning.size)}`,
    );
  }

  private restoreRow(row: PoolContainerRow): void {
    const createdAt = row.createdAt.getTime();
    if (row.state === "ready" && row.ip) {
      this.ready.push({
        vmid: row.vmid,
        node: row.node,
        ip: row.ip,
        agentToken: row.agentToken,
        createdAt,
      });
    } else if (row.state === "pending") {
      this.pending.set(row.vmid, {
        node: row.node,
        agentToken: row.agentToken,
        createdAt,
      });
    } else if (row.state === "provisioning") {
      // Provisioning without an active process behind it — probably a pod
      // crash mid-clone. Treat as pending so `expirePending` destroys it
      // if it never registers, and don't count it toward `provisioning` which
      // only tracks live in-flight work.
      this.pending.set(row.vmid, {
        node: row.node,
        agentToken: row.agentToken,
        createdAt,
      });
      this.updateRowState(row.vmid, "pending");
    }
  }

  registerAgent(vmid: number, ip: string): boolean {
    // Check if a session is waiting for this VMID's IP (post-restart registration)
    const callback = this.ipCallbacks.get(vmid);
    if (callback) {
      this.ipCallbacks.delete(vmid);
      console.log(`[pool] VMID ${String(vmid)} re-registered after restart (ip: ${ip})`);
      callback(ip);
      return true;
    }

    const entry = this.pending.get(vmid);
    if (!entry) return false;

    this.pending.delete(vmid);
    this.ready.push({
      vmid,
      node: entry.node,
      ip,
      agentToken: entry.agentToken,
      createdAt: Date.now(),
    });

    db.update(schema.poolContainers)
      .set({ state: "ready", ip })
      .where(eq(schema.poolContainers.vmid, vmid))
      .run();

    this.consecutiveFailures = 0;
    if (this.circuitOpen) {
      console.log("[pool] circuit breaker reset — provisioning resumed");
      this.circuitOpen = false;
    }
    console.log(`[pool] VMID ${String(vmid)} registered (ip: ${ip}, pool: ${String(this.ready.length)})`);
    return true;
  }

  /** Wait for a specific VMID to re-register (after container restart). */
  waitForRegistration(vmid: number, timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ipCallbacks.delete(vmid);
        reject(new Error(`VMID ${String(vmid)} did not re-register within ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.ipCallbacks.set(vmid, (ip: string) => {
        clearTimeout(timer);
        resolve(ip);
      });
    });
  }

  /**
   * Destroy orphaned lxc-pool-* containers from previous server runs.
   *
   * "Orphaned" means: running lxc-pool-* on Proxmox, but not referenced by an
   * active session AND not present in our pool_containers DB table. Pool rows
   * are what `hydrateFromDb()` restored — deleting those would destroy the
   * warm pool we just recovered.
   */
  async cleanupOrphans(activeVmids: Set<number>): Promise<void> {
    const pooledVmids = new Set(
      db.select({ vmid: schema.poolContainers.vmid }).from(schema.poolContainers).all().map((r) => r.vmid),
    );

    for (const node of this.proxmox.getAllowedNodes()) {
      try {
        const containers = await this.listLxcCached(node);
        for (const ct of containers) {
          if (!ct.name.startsWith("lxc-pool-")) continue;
          if (activeVmids.has(ct.vmid)) continue;
          if (pooledVmids.has(ct.vmid)) continue;

          console.log(`[pool] destroying orphaned VMID ${String(ct.vmid)} on ${node}`);
          try {
            if (ct.status === "running") {
              await this.proxmox.stopLxc(node, ct.vmid);
              await new Promise((r) => setTimeout(r, 2_000));
            }
            await this.proxmox.destroyLxc(node, ct.vmid);
            console.log(`[pool] destroyed orphaned VMID ${String(ct.vmid)}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            console.error(`[pool] failed to destroy orphaned VMID ${String(ct.vmid)}: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`[pool] failed to list containers on ${node}: ${msg}`);
      }
    }
  }

  start(): void {
    console.log(
      `[pool] starting warm pool (target: ${String(this.config.targetSize)})`,
    );
    this.interval = setInterval(() => {
      void this.maintain();
    }, this.config.checkIntervalMs);
    void this.maintain();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  claim(): PoolContainer | null {
    const container = this.ready.shift() ?? null;
    if (container) {
      // Row is now owned by the claiming session — the sessions row carries
      // lxcVmid/Node/Ip from here on.
      db.delete(schema.poolContainers)
        .where(eq(schema.poolContainers.vmid, container.vmid))
        .run();
      console.log(
        `[pool] claimed VMID ${String(container.vmid)} (${String(this.ready.length)} remaining)`,
      );
      void this.maintain();
    }
    return container;
  }

  getStatus(): { ready: number; provisioning: number } {
    return {
      ready: this.ready.length,
      provisioning: this.provisioning.size,
    };
  }

  private async maintain(): Promise<void> {
    // Reentrancy guard — a slow Proxmox listLxc used to allow two concurrent
    // maintain() runs to both observe `needed > 0` and provision in parallel.
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      this.expireStale();
      await this.expirePending();

      if (this.circuitOpen) {
        const elapsed = Date.now() - this.circuitOpenedAt;
        if (elapsed < ContainerPool.CIRCUIT_BREAKER_RESET_MS) return;
        console.log(
          `[pool] circuit breaker auto-reset after ${String(Math.round(elapsed / 60_000))}m — retrying provisioning`,
        );
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
      }

      const total =
        this.ready.length + this.provisioning.size + this.pending.size;
      const needed = this.config.targetSize - total;
      if (needed <= 0) return;

      // Hard cap check only runs when we would actually provision — saves
      // 3× Proxmox API calls every 60s when the pool is at target.
      if (await this.exceedsHardCap()) return;

      for (let i = 0; i < needed; i++) {
        void this.provision();
      }
    } finally {
      this.maintaining = false;
    }
  }

  /** Destroy containers that never registered within the timeout. */
  private async expirePending(): Promise<void> {
    const now = Date.now();
    // Also expire DB rows in `pending` state that the in-memory Map doesn't
    // know about (e.g. hydrated from an old pod restart and the timeout has
    // now elapsed).
    const cutoff = new Date(now - ContainerPool.PENDING_TIMEOUT_MS);
    db.delete(schema.poolContainers)
      .where(
        and(
          eq(schema.poolContainers.state, "pending"),
          lt(schema.poolContainers.createdAt, cutoff),
        ),
      )
      .run();

    const expired: Array<{ vmid: number; node: string; ageMs: number }> = [];
    for (const [vmid, entry] of this.pending) {
      if (now - entry.createdAt > ContainerPool.PENDING_TIMEOUT_MS) {
        this.pending.delete(vmid);
        expired.push({ vmid, node: entry.node, ageMs: now - entry.createdAt });
      }
    }
    if (expired.length === 0) return;

    this.consecutiveFailures += expired.length;
    for (const e of expired) {
      console.error(
        `[pool] VMID ${String(e.vmid)} never registered (${String(Math.round(e.ageMs / 60_000))}m), destroying (failures: ${String(this.consecutiveFailures)})`,
      );
    }
    if (this.consecutiveFailures >= ContainerPool.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      console.error(
        `[pool] CIRCUIT BREAKER OPEN — ${String(this.consecutiveFailures)} consecutive failures, provisioning halted (auto-reset in ${String(ContainerPool.CIRCUIT_BREAKER_RESET_MS / 60_000)}m)`,
      );
    }

    // Bounded-concurrency destroys — previously this fire-and-forget loop
    // could kick off dozens of parallel Proxmox destroys with no limit.
    await runWithConcurrency(ContainerPool.DESTROY_CONCURRENCY, expired, async (e) => {
      try {
        await this.proxmox.stopLxc(e.node, e.vmid);
        await new Promise((r) => setTimeout(r, 2_000));
        await this.proxmox.destroyLxc(e.node, e.vmid);
      } catch {
        // best-effort cleanup
      }
    });
  }

  /**
   * Cached per-node listLxc — avoids 3 Proxmox API round-trips on every
   * 60s tick for the hard-cap check + orphan cleanup + hydrate.
   */
  private async listLxcCached(
    node: string,
  ): Promise<Array<{ vmid: number; name: string; status: string }>> {
    const now = Date.now();
    const cached = this.listCache.get(node);
    if (cached && now - cached.at < ContainerPool.LIST_CACHE_MS) {
      return cached.containers;
    }
    const containers = await this.proxmox.listLxc(node);
    this.listCache.set(node, { at: now, containers });
    return containers;
  }

  /** Check if lxc-pool-* containers across all nodes exceed the hard cap. */
  private async exceedsHardCap(): Promise<boolean> {
    let count = 0;
    for (const node of this.proxmox.getAllowedNodes()) {
      try {
        const containers = await this.listLxcCached(node);
        count += containers.filter((c) => c.name.startsWith("lxc-pool-")).length;
      } catch {
        // If we can't list, assume the worst and block provisioning
        console.error(`[pool] can't list containers on ${node}, blocking provisioning`);
        return true;
      }
    }
    if (count >= ContainerPool.MAX_POOL_CONTAINERS) {
      console.error(
        `[pool] HARD CAP — ${String(count)} lxc-pool-* containers exist (max ${String(ContainerPool.MAX_POOL_CONTAINERS)}), blocking provisioning`,
      );
      return true;
    }
    return false;
  }

  private expireStale(): void {
    const now = Date.now();
    const expired = this.ready.filter(
      (c) => now - c.createdAt > this.config.ttlMs,
    );

    for (const container of expired) {
      const idx = this.ready.indexOf(container);
      if (idx !== -1) this.ready.splice(idx, 1);
      db.delete(schema.poolContainers)
        .where(eq(schema.poolContainers.vmid, container.vmid))
        .run();
      console.log(
        `[pool] expiring stale VMID ${String(container.vmid)} (age: ${String(Math.round((now - container.createdAt) / 60_000))}m)`,
      );
      void this.destroyContainer(container);
    }
  }

  private async provision(): Promise<void> {
    let vmid: number;
    try {
      vmid = await this.proxmox.getNextId();
    } catch {
      console.error("[pool] failed to get next VMID");
      return;
    }

    this.provisioning.add(vmid);
    const agentToken = randomUUID();

    let node: string | null = null;
    let rowWritten = false;
    try {
      node = await this.proxmox.selectNode();
      const hostname = `lxc-pool-${String(vmid)}`;

      console.log(`[pool] provisioning VMID ${String(vmid)} on ${node}`);

      // Persist BEFORE the clone so a pod crash mid-clone still leaves a
      // reconcile trail. hydrateFromDb will re-check Proxmox status and
      // destroy-if-missing on next startup.
      db.insert(schema.poolContainers)
        .values({
          vmid,
          node,
          ip: null,
          agentToken,
          state: "provisioning",
          createdAt: new Date(),
        })
        .run();
      rowWritten = true;

      const cloneTask = await this.proxmox.cloneTemplate(node, vmid, hostname);
      await this.proxmox.waitForTask(node, cloneTask);

      const startTask = await this.proxmox.startLxc(node, vmid);
      await this.proxmox.waitForTask(node, startTask);

      // Wait for container to fully boot before deploying agent + .env
      await new Promise((r) => setTimeout(r, 10_000));

      // Deploy agent bundle so the daemon can start. Await so we catch tar
      // or ssh failures here rather than after marking pending.
      await this.deployAgentBundle(node, vmid);

      // Deploy agent .env so the daemon can register
      await this.deployAgentEnv(node, vmid, agentToken);

      this.pending.set(vmid, {
        node,
        agentToken,
        createdAt: Date.now(),
      });
      this.updateRowState(vmid, "pending");
      console.log(`[pool] VMID ${String(vmid)} started, waiting for agent registration`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      console.error(`[pool] failed to provision VMID ${String(vmid)}: ${msg}`);
      if (rowWritten) {
        db.delete(schema.poolContainers).where(eq(schema.poolContainers.vmid, vmid)).run();
      }
      if (node) {
        try {
          await this.proxmox.stopLxc(node, vmid);
          await this.proxmox.destroyLxc(node, vmid);
          console.log(`[pool] cleaned up failed VMID ${String(vmid)}`);
        } catch (cleanupErr) {
          const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : "unknown";
          console.error(`[pool] failed to clean up VMID ${String(vmid)}: ${cleanupMsg}`);
        }
      }
    } finally {
      this.provisioning.delete(vmid);
    }
  }

  private updateRowState(vmid: number, state: PoolContainerState): void {
    db.update(schema.poolContainers)
      .set({ state })
      .where(eq(schema.poolContainers.vmid, vmid))
      .run();
  }

  private scheduleDestroy(node: string, vmid: number): void {
    void (async () => {
      try {
        await this.proxmox.stopLxc(node, vmid);
        await new Promise((r) => setTimeout(r, 2_000));
        await this.proxmox.destroyLxc(node, vmid);
        console.log(`[pool] destroyed ${String(vmid)} during hydrate reconcile`);
      } catch {
        // best-effort — orphan cleanup will catch it later
      }
    })();
  }

  /**
   * Write agent .env into container. Content is piped via ssh stdin — no
   * shell interpolation, so even if portalUrl/agentAuthToken ever contain
   * shell metacharacters the file is written verbatim.
   */
  private async deployAgentEnv(
    node: string,
    vmid: number,
    agentToken: string,
  ): Promise<void> {
    const nodeIp = this.nodeIps[node];
    if (!nodeIp) {
      console.error(`[pool] no IP for node ${node}, skipping .env deploy`);
      return;
    }

    const envContent = [
      `PORTAL_URL=${this.portalUrl}`,
      `AGENT_AUTH_TOKEN=${this.agentAuthToken}`,
      `AGENT_TOKEN=${agentToken}`,
      "",
    ].join("\n");

    try {
      await pctWriteFile(nodeIp, vmid, "/opt/agenthub-agent/.env", envContent, {
        timeoutMs: 30_000,
        mode: 0o600,
      });
      // systemctl restart is a fixed command — vmid is integer-validated by pctWriteFile.
      await runSsh(nodeIp, `pct exec ${String(vmid)} -- systemctl restart agenthub-agent`, 30_000);
      console.log(`[pool] deployed agent .env to VMID ${String(vmid)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[pool] failed to deploy agent .env to VMID ${String(vmid)}: ${msg}`,
      );
    }
  }

  /**
   * Copy agent JS bundle into container so the daemon can run.
   *
   * Uses spawn-based pipeline (tar stdout → ssh stdin) rather than
   * `execFileSync("bash", ["-c", ...])` — that old form concatenated server
   * paths into a shell string and would have become RCE if any path ever
   * contained shell metacharacters.
   */
  private async deployAgentBundle(node: string, vmid: number): Promise<void> {
    const nodeIp = this.nodeIps[node];
    if (!nodeIp) {
      console.error(`[pool] no IP for node ${node}, skipping agent deploy`);
      return;
    }

    // Agent dist lives alongside the server in the Docker image
    const agentDir = join(process.cwd(), "packages/agent");
    const distDir = join(agentDir, "dist");
    const nmDir = join(agentDir, "node_modules");

    if (!existsSync(distDir)) {
      console.error("[pool] agent dist not found, skipping bundle deploy");
      return;
    }

    const hasNodeModules = existsSync(nmDir);
    // Extract dist/ contents flat (not as subdirectory) so index.js lands
    // at /opt/agenthub-agent/index.js matching the systemd ExecStart path.
    // Then add package.json + node_modules from the parent directory.
    // --dereference (-h) follows pnpm symlinks so actual files are copied.
    const tarArgs = [
      "czfh", "-",
      "-C", distDir, ".",
      "-C", agentDir, "package.json",
      ...(hasNodeModules ? ["node_modules"] : []),
    ];

    const remoteExtract = `pct exec ${String(vmid)} -- tar xzf - -C /opt/agenthub-agent`;
    const sshArgs = [...SSH_ARGS, `root@${nodeIp}`, remoteExtract];

    try {
      await new Promise<void>((resolve, reject) => {
        const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
        const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });

        let tarStderr = "";
        let sshStderr = "";
        tar.stderr.on("data", (d: Buffer) => { tarStderr += d.toString(); });
        ssh.stderr.on("data", (d: Buffer) => { sshStderr += d.toString(); });

        tar.stdout.pipe(ssh.stdin);
        tar.on("error", reject);
        ssh.on("error", reject);

        let tarExit: number | null = null;
        let sshExit: number | null = null;
        const done = (): void => {
          if (tarExit === null || sshExit === null) return;
          if (tarExit !== 0) {
            reject(new Error(`tar exited ${String(tarExit)}: ${tarStderr.trim()}`));
          } else if (sshExit !== 0) {
            reject(new Error(`ssh exited ${String(sshExit)}: ${sshStderr.trim()}`));
          } else {
            resolve();
          }
        };
        tar.on("close", (code) => { tarExit = code ?? 0; done(); });
        ssh.on("close", (code) => { sshExit = code ?? 0; done(); });

        setTimeout(() => {
          tar.kill("SIGKILL");
          ssh.kill("SIGKILL");
          reject(new Error("deployAgentBundle timeout (30s)"));
        }, 30_000).unref();
      });
      console.log(`[pool] deployed agent bundle to VMID ${String(vmid)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[pool] failed to deploy agent bundle to VMID ${String(vmid)}: ${msg}`);
    }
  }

  private async destroyContainer(container: PoolContainer): Promise<void> {
    try {
      await this.proxmox.stopLxc(container.node, container.vmid);
      await new Promise((r) => setTimeout(r, 2_000));
      await this.proxmox.destroyLxc(container.node, container.vmid);
      console.log(`[pool] destroyed VMID ${String(container.vmid)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[pool] failed to destroy VMID ${String(container.vmid)}: ${msg}`);
    }
  }
}

/** Run async work across items with a bounded concurrency limit. */
async function runWithConcurrency<T>(
  limit: number,
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const item = items[idx++];
        if (item === undefined) continue;
        await worker(item);
      }
    })());
  }
  await Promise.all(runners);
}
