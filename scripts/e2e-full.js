// Comprehensive E2E for AgentHub.
//
// Runs INSIDE the agenthub-server container and talks to localhost:3000
// directly — bypasses Traefik so it validates app logic end-to-end even if
// the front-door proxy is broken. (The installer's headless probe covers
// the Traefik layer separately.)
//
// Invocation:
//   docker cp scripts/e2e-full.js agenthub-agenthub-server-1:/tmp/e2e.js
//   docker exec -e ADMIN_PASSWORD=<pw> agenthub-agenthub-server-1 node /tmp/e2e.js
//
// Exit 0 on success, 1 on any failure. The script is self-cleaning: any
// infra configs, backup credentials, or sessions it creates are removed
// before exit (both on success AND on failure), so re-runs start clean
// and a "fresh install" user never sees test fixtures in their UI.

const ORIGIN = "http://localhost:3000";
const ADMIN_PW = process.env.ADMIN_PASSWORD || "e2e-test-pw-2468";

const FAKE_CF_TOKEN = "fake_cloudflare_token_abcdefgh1234567890";
const FAKE_B2_KEY_ID = "0001234567890abcdef";
const FAKE_B2_APP_KEY = "K001FakeAppKeyForTesting";
const FAKE_B2_BUCKET = "agenthub-e2e-test";

let PASS = 0;
let FAIL = 0;
let cookie = "";

// Resources created during the run — tracked so cleanup can unwind
// everything even if the test fails partway through.
const created = {
  infraIds: [],
  sessionIds: [],
  backupConfigured: false,
};

function check(name, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${name}`); PASS++; }
  else { console.log(`  ✗ ${name} ${detail}`); FAIL++; }
}

async function req(path, opts = {}) {
  const r = await fetch(`http://localhost:3000${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...opts.headers,
    },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: json };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cleanup() {
  console.log("\n=== Cleanup: remove E2E fixtures ===");

  for (const id of created.sessionIds) {
    try {
      const del = await req(`/api/sessions/${id}`, { method: "DELETE" });
      check(`DELETE /api/sessions/${id}`, del.status === 200 || del.status === 204, `got ${del.status}`);
    } catch (e) {
      check(`DELETE session ${id}`, false, e.message);
    }
  }

  for (const id of created.infraIds) {
    try {
      const del = await req(`/api/infra/${id}`, { method: "DELETE" });
      check(`DELETE /api/infra/${id}`, del.status === 200 || del.status === 204, `got ${del.status}`);
    } catch (e) {
      check(`DELETE infra ${id}`, false, e.message);
    }
  }

  if (created.backupConfigured) {
    try {
      const del = await req("/api/user/backup", { method: "DELETE" });
      check("DELETE /api/user/backup", del.status === 200 || del.status === 204, `got ${del.status}`);
    } catch (e) {
      check("DELETE backup config", false, e.message);
    }
  }

  // Sanity: confirm the admin user now sees a clean UI.
  const b2check = await req("/api/user/backup");
  check(
    "post-cleanup: /api/user/backup reports configured: false",
    b2check.body?.configured === false,
    `got ${JSON.stringify(b2check.body)}`,
  );

  const infraCheck = await req("/api/infra");
  check(
    "post-cleanup: /api/infra is empty",
    Array.isArray(infraCheck.body) && infraCheck.body.length === 0,
    `got ${JSON.stringify(infraCheck.body)}`,
  );
}

async function main() {
  console.log("\n=== 1. Health ===");
  const h = await req("/api/health");
  check("GET /api/health → 200", h.status === 200);
  check("body.status === ok", h.body.status === "ok");

  console.log("\n=== 2. Admin login ===");
  const login = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: ADMIN_PW }),
  });
  check("POST /api/auth/login → 200", login.status === 200, `got ${login.status} ${JSON.stringify(login.body)}`);
  check("user.role === admin", login.body.role === "admin");
  check("session cookie issued", cookie.length > 10);

  console.log("\n=== 3. /me round-trip (auth middleware) ===");
  const me = await req("/api/auth/me");
  check("GET /api/auth/me → 200", me.status === 200, `got ${me.status}`);
  check("me.username === admin", me.body.username === "admin");

  console.log("\n=== 4. Infisical: store Cloudflare config (secret write) ===");
  const cf = await req("/api/infra", {
    method: "POST",
    body: JSON.stringify({
      name: "e2e-cloudflare",
      provider: "cloudflare",
      config: { apiToken: FAKE_CF_TOKEN, zoneId: "zone_abc123" },
    }),
  });
  check("POST /api/infra cloudflare → 201", cf.status === 201, `got ${cf.status} ${JSON.stringify(cf.body)}`);
  const infraId = cf.body.id;
  check("infraId returned", typeof infraId === "string");
  if (infraId) created.infraIds.push(infraId);

  console.log("\n=== 5. Infisical: read back masked (secret read) ===");
  const getOne = await req(`/api/infra/${infraId}`);
  check("GET /api/infra/:id → 200", getOne.status === 200);
  check("config.zoneId unchanged", getOne.body.config?.zoneId === "zone_abc123");
  const maskedToken = getOne.body.config?.apiToken;
  check(
    "apiToken masked with last-4 (proves Infisical round-trip)",
    typeof maskedToken === "string" && maskedToken.endsWith(FAKE_CF_TOKEN.slice(-4)) && maskedToken.startsWith("•"),
    `got ${JSON.stringify(maskedToken)}`,
  );

  console.log("\n=== 6. B2 backup config (Infisical /users/*/b2 path) ===");
  const b2put = await req("/api/user/backup", {
    method: "PUT",
    body: JSON.stringify({
      b2KeyId: FAKE_B2_KEY_ID,
      b2AppKey: FAKE_B2_APP_KEY,
      b2Bucket: FAKE_B2_BUCKET,
    }),
  });
  check("PUT /api/user/backup → 200", b2put.status === 200, `got ${b2put.status} ${JSON.stringify(b2put.body)}`);
  if (b2put.status === 200) created.backupConfigured = true;

  const b2get = await req("/api/user/backup");
  check("GET /api/user/backup → configured: true", b2get.body.configured === true);
  check("b2Bucket round-trip exact", b2get.body.b2Bucket === FAKE_B2_BUCKET);
  check("b2AppKey masked", typeof b2get.body.b2AppKey === "string" && b2get.body.b2AppKey.endsWith(FAKE_B2_APP_KEY.slice(-4)) && b2get.body.b2AppKey.startsWith("•"));

  console.log("\n=== 7. Session creation (outer Docker driver) ===");
  const sess = await req("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ name: "e2e-session" }),
  });
  check("POST /api/sessions → 201", sess.status === 201, `got ${sess.status} ${JSON.stringify(sess.body)}`);
  const sessId = sess.body.id;
  if (sessId) created.sessionIds.push(sessId);

  console.log("\n  waiting up to 60s for session to become active…");
  let sessStatus = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const s = await req(`/api/sessions/${sessId}`);
    if (s.body.status === "active") { sessStatus = "active"; break; }
    if (s.body.status === "failed") { sessStatus = `failed: ${s.body.statusDetail}`; break; }
    if (i % 5 === 0) console.log(`    status=${s.body.status} ${s.body.statusDetail || ""}`);
  }
  check(`session status === active`, sessStatus === "active", `final: ${sessStatus}`);

  console.log("\n=== 8. Backup save via agent (plumbing only — fake B2 creds) ===");
  if (sessStatus === "active") {
    const save = await req("/api/user/backup/save", { method: "POST" });
    // With fake creds, rclone will fail to authenticate with B2. But the
    // request reaching the agent and the agent's response flowing back is
    // what we're proving works.
    check(
      "server→agent backup plumbing works (response received)",
      save.status === 200 || save.status === 500,
      `got ${save.status} ${JSON.stringify(save.body)}`,
    );
    const wasAuthFailure = typeof save.body?.error === "string" &&
      /auth|unauthorized|bad_auth_token|account|key|credentials|403|401/i.test(save.body.error);
    check(
      "rclone executed inside workspace (auth-failure signature)",
      wasAuthFailure,
      `error: ${save.body?.error ?? "(none)"}`,
    );
  } else {
    check("session not active, skipping backup plumbing test", false, "session failed to reach active");
  }

  console.log("\n=== 9. Session end ===");
  if (sessId) {
    const end = await req(`/api/sessions/${sessId}/end`, { method: "POST" });
    check("POST /api/sessions/:id/end → 200", end.status === 200);
  }
}

// Run the main checks; always run cleanup even on failure so fixtures
// don't leak into a "fresh install" UI. Exit code reflects the combined
// pass/fail of checks AND cleanup.
main()
  .catch((e) => {
    console.error("RUNTIME:", e.stack || e.message);
    FAIL++;
  })
  .then(() => cleanup().catch((e) => {
    console.error("CLEANUP RUNTIME:", e.stack || e.message);
    FAIL++;
  }))
  .finally(() => {
    console.log(`\n=== Summary: ${PASS} passed, ${FAIL} failed ===`);
    process.exit(FAIL === 0 ? 0 : 1);
  });
