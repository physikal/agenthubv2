# AgentHub Code Review — 2026-04-16

Full-codebase review by 5 specialized agents (security, architecture, performance, TypeScript, simplicity). This document is the source of truth for follow-up work. Every commit addressing a finding must reference its ID in the commit message (e.g. `fix(P1-SEC-01): …`).

## Workflow

Findings are grouped into batches. Each batch becomes one PR.

- `- [ ]` = pending
- `- [x]` = landed (reference commit SHA)
- `- [~]` = wontfix / deferred (must explain why)

Status summary appears at the bottom. Update counts when ticking a box.

---

## Batch A — Shell injection hardening (P1)

Branch: `security/batch-a-shell-injection`

- [x] **P1-SEC-01** — `packages/server/src/services/providers/proxmox-hosting.ts:117-222`: `config.node` and `config.storage` interpolated into SSH `pct create … --storage ${…}` as root. Exploit: `POST /api/infra/:id/provision` with crafted config → RCE on hypervisor.
  **Fix landed:** `assertSafeNode` + `assertSafeStorage` validators in `services/shell-safety.ts`; every interpolated value passes through `shQuote()` in `pct create`. Traefik compose now written via `pctWriteFile` (stdin pipe).
- [x] **P1-SEC-02** — `packages/server/src/services/deployer.ts:270-280`: user-supplied `composeConfig` embedded in bash heredoc `<< 'COMPOSE_EOF'`. Content containing `COMPOSE_EOF` on its own line escapes.
  **Fix landed:** Both compose and Dockerfile writes now go through `sshWriteFile()` which pipes content via ssh stdin — no heredoc, no terminator escape. `appDir` shell-quoted throughout.
- [x] **P1-SEC-03** — `packages/server/src/routes/user.ts:133,154,185,214`: `b2Bucket` (user-editable, no validation) concatenated into `execSync("rclone … size \"${bucket}\"")`.
  **Fix landed:** `validateBackupConfig` checks b2KeyId/b2AppKey/b2Bucket on PUT and at every use site. All 4 rclone call sites migrated to `execFileSync("rclone", [argv])`. `chown -R` replaced with `execFileSync("chown", [argv])`.
- [x] **P1-SEC-04** — `packages/server/src/services/pool.ts:404-410`: `tarCmd` is a string executed via `execFileSync("bash", ["-c", tarCmd])`. Server-controlled today, but one env-var typo introduces injection.
  **Fix landed:** `deployAgentBundle` rewritten as spawn-based pipeline (tar stdout → ssh stdin) with per-process error capture, exit-code check, and a 30s hard timeout that SIGKILLs both children.
- [x] **P1-SEC-05** — `packages/server/src/services/pool.ts:354-365`: `deployAgentEnv` `echo -e "…"` interpolates `agentToken`/`portalUrl`/`agentAuthToken` from env.
  **Fix landed:** `deployAgentEnv` now writes via `pctWriteFile` (ssh stdin → pct exec stdin) with mode 0600. Service restart is a fixed argv command.

## Batch B — Agent / MCP auth rework (P1)

Branch: `security/batch-b-agent-auth`

- [ ] **P1-SEC-06** — `packages/server/src/index.ts:111-123`, `services/pool.ts:79-108`: `POST /api/agent/register` accepts arbitrary `{vmid, ip}` with shared `AGENT_AUTH_TOKEN` (readable from any pool container). Attacker registers victim's VMID → server proxies victim's terminal/previews to attacker IP.
  **Fix:** Constrain reported IP to PVE subnet (`192.168.5.0/24` or dedicated LXC range). Verify source IP matches reported IP. Reject registrations for VMIDs already fully registered.
- [ ] **P1-SEC-07** — `packages/server/src/middleware/auth.ts:64-108`: `agentAuthMiddleware` uses server-wide shared token + client-supplied `X-Vmid`. Rogue container can set `X-Vmid: <other-user>` and impersonate their MCP calls.
  **Fix:** Use per-session `agentToken` (already in schema at `db/schema.ts:60`, currently unused). Replace `X-Vmid` lookup with token → session lookup. Bind agent registrations so each VMID has exactly one active session.

## Batch C — TLS + CSRF + rate-limit boundaries (P1)

Branch: `security/batch-c-tls-csrf`

- [ ] **P1-SEC-08** — `packages/server/src/index.ts:27-29`: `process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"` disables TLS verification for ALL outbound HTTPS (Cloudflare API, DigitalOcean API, etc.).
  **Fix:** Remove the global. Create a per-request `https.Agent({rejectUnauthorized: false})` and pass it only on Proxmox fetch calls. All other fetch calls should use full verification.
- [ ] **P1-SEC-09** — `packages/server/src/ws/terminal-proxy.ts:15-56`, `ws/preview-proxy.ts:15-45`: WebSocket upgrade handlers bypass Hono's Origin check. Cross-origin page can open WS with victim's cookie.
  **Fix:** Add Origin allowlist check in the upgrade handler; reject `Origin` not in `ALLOWED_ORIGINS`.
- [ ] **P2-SEC-10** — `packages/server/src/routes/auth.ts:44`: rate limiter trusts client-sent `X-Forwarded-For`.
  **Fix:** Configure trusted-proxy header from ingress (or use socket IP). Document in deployment notes.
- [ ] **P2-SEC-11** — `packages/server/src/index.ts:96-106`: Origin CSRF guard rejects only when Origin is present and not in set — missing Origin passes. Tighten to require Origin on mutating verbs.

## Batch D — Event-loop unblock (P1)

Branch: `security/batch-d-event-loop`

- [x] **P1-PERF-12** — `packages/server/src/routes/user.ts:136,157,188,217,222`: `execSync(rclone …)` with 30-300s timeouts on HTTP request path. One user freezes the entire server for up to 5 min.
  **Fix landed:** `rcloneExec` now uses `promisify(execFile)`; all 4 backup endpoints + the post-restore `chown` are awaited. `/backup/status` and `/backup/files` handlers are now `async`. Requests never block the event loop regardless of how long a sync/copy takes. 202-Accepted background job deferred until we see real need.
- [x] **P1-PERF-13** — `packages/server/src/services/session-manager.ts:44-46,243`: `execFileSync("ssh", …)` during provisioning — up to 45s of blocked event loop per session create.
  **Fix landed:** Renamed `sshExecSync` → `sshExec`; now awaits `promisify(execFile)`. Bind-mount retry loop awaits each attempt; the 3s inter-attempt sleep was already async.

## Batch E — WebSocket proxy hardening (P2)

Branch: `security/batch-e-ws-proxy`

- [ ] **P2-SEC-14** — `packages/server/src/routes/preview.ts:76-127`, `ws/preview-proxy.ts:46-47`: SSRF. `session.lxcIp` not constrained to PVE subnet; proxy forwards `Authorization` header upstream.
  **Fix:** Validate `session.lxcIp` is in the LXC subnet before proxying. Strip `Authorization` on outbound. Block 127.0.0.0/8, 169.254.0.0/16. Restrict ports via allowlist.
- [ ] **P2-PERF-15** — `packages/server/src/ws/terminal-proxy.ts:85-104`, `preview-proxy.ts:49-92`: no backpressure, no heartbeat. Slow browser + burst output buffers tens of MB in Node; half-open sockets live 2h.
  **Fix:** Drop or pause when `bufferedAmount > 1_000_000`. 30s ping/pong heartbeat; terminate after 2 missed pongs on both sides.
- [ ] **P3-SEC-16** — `packages/server/src/routes/preview.ts:138-154`: Location header only rewritten when hostname matches `session.lxcIp` — cross-origin redirects forwarded unmodified.
  **Fix:** Strip any Location pointing outside `session.lxcIp`, or rewrite to a safe default.

## Batch F — Pool state durability (P2)

Branch: `security/batch-f-pool-durability`

- [ ] **P2-ARCH-17** — `packages/server/src/services/pool.ts:33-77`: `ready[]`, `pending`, `provisioning`, `ipCallbacks` live in process memory only. Pod restart mid-provision leaks pool containers forever (counts against `MAX_POOL_CONTAINERS=10`).
  **Fix:** Add `pool_containers` table (vmid, node, state, created_at, agent_token). Make `claim`, `registerAgent`, `expirePending` DB-transactional. Reconcile on startup: destroy pool-rows with no claimed session and no live agent; mark sessions in `starting`/`waiting_login` without matching pool row as failed.
- [ ] **P2-PERF-18** — `packages/server/src/services/pool.ts:189-214`: `maintain()` has no reentrancy guard. Slow `listLxc` causes concurrent runs to both see `needed>0` and provision.
  **Fix:** `private maintaining = false` guard.
- [ ] **P2-PERF-19** — `packages/server/src/services/pool.ts:247-266`: `exceedsHardCap()` hits Proxmox API every 60s even when pool is at target.
  **Fix:** Cache `listLxc` result for 15s; only call hard-cap API when `needed>0`.
- [ ] **P2-PERF-20** — `packages/server/src/services/pool.ts:217-244`: `expirePending` fires unbounded parallel destroys in a fire-and-forget IIFE.
  **Fix:** Collect VMIDs, `Promise.all` with `p-limit(2)`.

## Batch G — Architecture refactor (P2)

Branch: `refactor/session-manager-split`

- [ ] **P2-ARCH-21** — `packages/server/src/services/session-manager.ts` (709 lines, 17 methods, god object): owns DB CRUD, pool orchestration, SSH bind-mounts, NFS chown, 5× `writeXxxConfig` helpers, MCP JSON merging, agent WS lifecycle.
  **Fix:** Extract `HomeProvisioner` (config writers, NFS chown), `BindMountManager` (stop/unlock/retry/start), `AgentClient` (WS lifecycle). Target <250 lines.
- [ ] **P2-ARCH-22** — PVE node IP table + SSH args duplicated in `index.ts:61`, `session-manager.ts:22-26,42`, `providers/proxmox-hosting.ts:28-32`, `pool.ts:40,60-62,7-12`, `deployer.ts:17-22`.
  **Fix:** Single `packages/server/src/infra/hosts.ts` exporting `NODE_IPS`, `resolveNodeIp(node)`, `sshExec(nodeIp, args)`.
- [ ] **P2-ARCH-23** — `packages/server/src/routes/infra.ts:181-228`: `PUT /api/infra/:id` merges config without shape validation — mass assignment of arbitrary keys (e.g. `apiUrl` override).
  **Fix:** Validate update body with same schema as create; reject unexpected keys.
- [ ] **P2-ARCH-24** — `packages/server/src/services/deployer.ts:226-411`: single 185-line `deploy()` function mixes DB insert, SSH file copy, Dockerfile gen, port alloc, compose gen, Docker build/up, Cloudflare DNS, status updates.
  **Fix:** Extract `ComposeRenderer`, `DnsManager`, `DeploymentRunner`. Parse published port from YAML AST (not regex). Validate `composeConfig` as parseable YAML with whitelisted top-level keys.

## Batch H — TypeScript runtime validation (P2)

Branch: `refactor/zod-boundaries`

- [ ] **P2-TS-25** — No runtime validation at HTTP boundaries. Every `c.req.json<X>()` and `res.json() as X` is a type lie.
  **Fix:** Add `zod`. Introduce shared schemas module (used by server routes + web clients via `z.infer<>`). Replace casts with `Schema.parse(…)`. Closes `msg.state as SessionStatus` (`session-manager.ts:366`) too.
- [ ] **P2-TS-26** — Non-null assertions on load-bearing values: `this.pool!.waitForRegistration` (`session-manager.ts:266`), `session.lxcIp!` (`:422`), `this.headers["Authorization"]!` (`proxmox.ts:53`).
  **Fix:** Explicit guards with descriptive errors or restructure so non-null by construction.
- [ ] **P2-TS-27** — `packages/server/src/services/deployer.ts:370,559`: `{ config: … } as typeof cfConfigs[0]` fabricates a DB row. Field access returns `undefined` despite TS saying `string`.
  **Fix:** Narrow type `type CfCreds = { apiToken: string; zoneId: string }` passed through explicitly.
- [ ] **P2-TS-28** — `packages/web/tsconfig.json` doesn't extend `tsconfig.base.json`; missing `noPropertyAccessFromIndexSignature`.
  **Fix:** `"extends": "../../tsconfig.base.json"` + override only the web-specific flags.

## Batch I — React / frontend quality (P2)

Branch: `refactor/frontend-cleanup`

- [ ] **P2-REACT-29** — `packages/web/src/hooks/useTerminal.ts:18-231`: listeners never explicitly removed; `mountedRef` prevents re-attach after sessionId change.
  **Fix:** Single `useEffect` keyed on `sessionId`; cleanup closes WS, disposes term, disconnects observer, removes listeners. Drop `mountedRef`.
- [ ] **P2-REACT-30** — `packages/web/src/pages/Deployments.tsx:86-92`: `deployments` in effect deps → interval torn down/recreated every 5s.
  **Fix:** Derive `anyDeploying` via `useMemo`; depend only on the boolean.
- [ ] **P2-REACT-31** — `packages/web/src/pages/Infrastructure.tsx:74`: `useEffect(() => setCurrent(infra), [infra])` — reset-prop-to-state anti-pattern.
  **Fix:** Derive directly or use `key={infra.id}` to remount.
- [ ] **P2-PERF-32** — `packages/web/src/pages/Sessions.tsx:27`: 5s poll runs even when tab hidden; `routes/sessions.ts:42-62` does three full-table scans per request.
  **Fix:** Pause on `document.visibilityState === 'hidden'`. Add `LIMIT 200`. Add `idx_sessions_user_created(user_id, created_at DESC)`.
- [ ] **P3-PERF-33** — frontend bundle 569 KB single chunk; xterm loaded on Login.
  **Fix:** Vite `manualChunks` for xterm; `lazy()` route components; lazy-load `Terminal.tsx`.

## Batch J — Dead code + simplification (P3)

Branch: `chore/cleanup`

- [ ] **P3-CLEAN-34** — Delete `packages/server/src/services/providers/digitalocean-hosting.ts` (241 lines) + DO branches in `routes/infra.ts` + DO UI in `pages/Infrastructure.tsx`. Speculative, unused. Collapse `providers/` folder.
- [ ] **P3-CLEAN-35** — Delete Cloudflare legacy-credential fallback in `services/deployer.ts:367-372,554-561`. Format was never shipped.
- [ ] **P3-CLEAN-36** — Delete `session-manager.ts:310-322` (`waitForIp`, no callers), `:158-160` (`_agentToken` unused param), `middleware/auth.ts:3` (unused `gt` import).
- [ ] **P3-CLEAN-37** — Extract single `writeUserFile(path, content, {chown})` helper; collapse 5 `writeXxxConfig` methods in `session-manager.ts:460-627` to 3-5 lines each.
- [ ] **P3-CLEAN-38** — `routes/auth.ts` admin registration has no password minimum; `change-password` requires 8+. Align both on same policy.
- [ ] **P3-CLEAN-39** — ~60 empty `catch {}` blocks — worst in `pages/Admin.tsx`, `pages/Backups.tsx`, `pool.ts:253`. At minimum `console.error(err)`; surface to toast in UI.
- [ ] **P3-CLEAN-40** — `services/deployer.ts:145-162`: try/catch-as-file-test for Dockerfile detection catches SSH network errors too, silently falls back to nginx. Capture exit code explicitly.
- [ ] **P3-CLEAN-41** — `routes/deploy.ts` mounted at `/api` with bare `/` path → `POST /api/` URL. Rename internal to `/deploy`.

## Batch K — Smaller perf wins (P3)

Branch: `perf/small-wins`

- [ ] **P3-PERF-42** — `middleware/auth.ts:20-46` does 2-table JOIN on every request. Add in-memory `Map<token,{user,expires}>` with 60s TTL; invalidate on password/role change.
- [ ] **P3-PERF-43** — `session-manager.ts:332-351`: `connectToAgent` retry loop doesn't `clearTimeout` on open/error nor `ws.close()` before retry. Small timer/handle leak.
- [ ] **P3-PERF-44** — `infra/lxc-template.sh`: `sleep 8` + `sleep 3` + three separate `npm install -g` + repeated `apt-get update`. Combine + poll instead of fixed sleeps.

---

## Status

| Batch | Count | Done | Status |
|-------|------:|-----:|--------|
| A — Shell injection | 5 | 5 | **complete** |
| B — Agent/MCP auth | 2 | 0 | pending |
| C — TLS + CSRF | 4 | 0 | pending |
| D — Event-loop | 2 | 2 | **complete** |
| E — WS proxy | 3 | 0 | pending |
| F — Pool durability | 4 | 0 | pending |
| G — Architecture | 4 | 0 | pending |
| H — Zod boundaries | 4 | 0 | pending |
| I — Frontend | 5 | 0 | pending |
| J — Cleanup | 8 | 0 | pending |
| K — Small perf | 3 | 0 | pending |
| **Total** | **44** | **0** | |

---

## Non-findings (positive observations)

Keep doing these:

- SQL is safe — Drizzle ORM + prepared statements, zero string concatenation.
- Bcrypt cost 12 + timing-safe dummy hash on failed lookup.
- Cookies: `httpOnly`, `Secure` (prod), `SameSite=Lax`.
- Session-ownership check on every session route.
- Agent file server uses `realpathSync` + allowlist.
- Circuit breaker + auto-reset on pool provisioning failures.
- `endSession` guards against double-destroy on VMID reuse.
- Comments explain WHY (ttyd bytes-0x30, SIGWINCH bounce) not WHAT.
- Package boundaries clean — zero cross-package imports.
- Multi-stage Dockerfile with separate build/production stages.
- Normalized 7-table schema with FK cascades.
- Strict root `tsconfig.base.json` enables all flags we'd want.

---

## References

- Review agents: security-sentinel, architecture-strategist, performance-oracle, kieran-typescript-reviewer, code-simplicity-reviewer
- Reviewer: Claude (compound-engineering review workflow)
- Primary codebase: `/Users/joshowen/Documents/ClaudeCode/agenthub`
