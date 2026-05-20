// E2E for workspace backup/restore round-trip (server-side sidecar engine).
//
// Runs INSIDE the agenthub-server container. It exercises the compiled engine
// directly (no HTTP layer): seed a per-user volume → backup → wipe → restore →
// assert the restored content is byte-correct AND that node_modules was
// excluded from the bundle.
//
// Run on a Docker host with a live AgentHub stack:
//   docker cp scripts/e2e-workspace-backup.js agenthub-agenthub-server-1:/tmp/e2e-ws.js
//   docker exec agenthub-agenthub-server-1 node /tmp/e2e-ws.js
// Expected: prints "E2E OK". Asserts app.txt restored AND node_modules excluded.
//
// Exit 0 on success, 1 on any failure. Self-cleaning: the throwaway volume and
// the local bundle directory are removed in a finally block even if an
// assertion throws.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import {
  runWorkspaceBackup,
  runWorkspaceRestore,
} from "/app/packages/server/dist/services/workspace-backup/runner.js";
import {
  volumeNameForUser,
  dockerVolumeExists,
  dockerVolumeCreate,
  dockerVolumeRemove,
} from "/app/packages/server/dist/services/workspace-backup/volume.js";

const USER_ID = "e2e-ws-test";
const MARKER = "hello-e2e";

function assert(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  throw new Error(`assertion failed: ${name}${detail ? ` — ${detail}` : ""}`);
}

// One-shot alpine container that mounts the volume at /home/coder. --network
// none so the seed/read steps never touch the network.
function dockerRunOnVolume(vol, mode, shellBody) {
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${vol}:/home/coder${mode === "ro" ? ":ro" : ""}`,
      "--network",
      "none",
      "alpine:3.21",
      "sh",
      "-c",
      shellBody,
    ],
    { encoding: "utf8" },
  );
}

async function ensureCleanVolume(vol) {
  if (await dockerVolumeExists(vol)) {
    console.log(`  removing pre-existing volume ${vol}`);
    await dockerVolumeRemove(vol);
  }
  await dockerVolumeCreate(vol);
}

async function main(vol) {
  console.log("\n=== 1. Clean volume ===");
  await ensureCleanVolume(vol);
  assert("test volume created", await dockerVolumeExists(vol));

  console.log("\n=== 2. Seed volume (app.txt + node_modules/dep.txt) ===");
  const SEED = [
    "set -eu",
    "mkdir -p /home/coder/project/node_modules",
    `printf '%s' '${MARKER}' > /home/coder/project/app.txt`,
    "printf '%s' 'should-be-excluded' > /home/coder/project/node_modules/dep.txt",
  ].join(" && ");
  dockerRunOnVolume(vol, "rw", SEED);
  console.log("  seeded /home/coder/project/{app.txt,node_modules/dep.txt}");

  console.log("\n=== 3. Backup (local-only) ===");
  const backup = await runWorkspaceBackup({
    userId: USER_ID,
    userEmail: null,
    workspaceImageSha: null,
    trigger: "manual",
    b2: null,
    onLog: (l) => console.log(`    ${l}`),
  });
  const { bundlePath } = backup;
  console.log(`  bundle: ${bundlePath} (${backup.bytes} bytes)`);

  console.log("\n=== 4. Assert bundle exists ===");
  assert("bundle file written to disk", existsSync(bundlePath), bundlePath);

  console.log("\n=== 5. Wipe volume ===");
  await dockerVolumeRemove(vol);
  assert("volume removed", !(await dockerVolumeExists(vol)));

  console.log("\n=== 6. Restore from local bundle ===");
  await runWorkspaceRestore({
    userId: USER_ID,
    localBundlePath: bundlePath,
    b2: null,
    force: true,
    onLog: (l) => console.log(`    ${l}`),
  });

  console.log("\n=== 7. Assert restored content + node_modules excluded ===");
  // Print the restored file, then a sentinel reporting whether node_modules
  // survived. Both are parsed from stdout below.
  const READ = [
    "set -eu",
    'printf "APP="; cat /home/coder/project/app.txt',
    'printf "\\n"',
    'if [ -e /home/coder/project/node_modules/dep.txt ]; then printf "NM=present"; else printf "NM=absent"; fi',
  ].join(" && ");
  const out = dockerRunOnVolume(vol, "ro", READ);

  const appLine = out.split("\n").find((l) => l.startsWith("APP="));
  const appValue = appLine ? appLine.slice("APP=".length) : null;
  assert(
    `app.txt restored to "${MARKER}"`,
    appValue === MARKER,
    `got ${JSON.stringify(appValue)}`,
  );

  assert(
    "node_modules excluded from bundle (dep.txt absent after restore)",
    out.includes("NM=absent"),
    `reader output: ${JSON.stringify(out)}`,
  );

  return bundlePath;
}

const vol = volumeNameForUser(USER_ID);
let bundlePath = null;
let failed = false;

try {
  bundlePath = await main(vol);
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${e.stack || e.message}`);
} finally {
  console.log("\n=== Teardown ===");
  try {
    if (await dockerVolumeExists(vol)) {
      await dockerVolumeRemove(vol);
      console.log(`  removed volume ${vol}`);
    }
  } catch (e) {
    console.error(`  volume teardown error: ${e.message}`);
  }
  if (bundlePath) {
    try {
      rmSync(dirname(bundlePath), { recursive: true, force: true });
      console.log(`  removed local bundle dir ${dirname(bundlePath)}`);
    } catch (e) {
      console.error(`  bundle teardown error: ${e.message}`);
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("\nE2E OK");
