import { spawn } from "node:child_process";
import { randomPassword } from "./secrets.js";

/**
 * First-run bootstrap for the bundled Infisical.
 *
 * Uses the official `infisical bootstrap` CLI via `npx @infisical/cli` so
 * we don't need to reimplement Infisical's client-side SRP key derivation.
 * The CLI creates: admin user + organization + instance-admin machine
 * identity with a pre-configured universal-auth client ID + secret.
 *
 * Output we care about (from the CLI's --output json mode):
 *   { identity: { id, name, credentials: { clientId, clientSecret } },
 *     organization: { id, name, slug },
 *     user: { id, email, firstName, lastName } }
 *
 * Idempotent via `--ignore-if-bootstrapped`: re-running an install against
 * an already-initialized Infisical is a no-op + the CLI exits 0 with an
 * empty-ish response. In that case we emit a helpful warning and leave
 * existing INFISICAL_CLIENT_ID/SECRET in .env alone.
 *
 * Remaining gap: the bootstrap identity is organization-scoped; it needs
 * to be attached to a project before the AgentHub server can write secrets.
 * We still need to create a project + attach the identity, but those two
 * REST calls are simple (just need a valid bearer) and don't need crypto.
 */

const INFISICAL_CLI_VERSION = "latest";

export interface BootstrapInput {
  baseUrl: string;
  adminEmail: string;
  orgName: string;
  projectName: string;
  /** Directory holding docker-compose.yml — used for the post-bootstrap
   * psql grant that makes the admin user a project member. */
  composeDir: string;
  /** Path to the rendered compose .env, fed to `docker compose --env-file`. */
  envFile: string;
}

export interface BootstrapResult {
  adminEmail: string;
  adminPassword: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
}

interface CliBootstrapOutput {
  identity?: {
    id?: string;
    name?: string;
    credentials?: {
      // Empirically: `infisical bootstrap --output json` returns a single
      // long-lived bearer token here — not a clientId/clientSecret pair.
      // We use it as a bearer for subsequent API calls, then attach
      // universal-auth ourselves and generate proper client creds.
      token?: string;
    };
  };
  organization?: {
    id?: string;
    name?: string;
    slug?: string;
  };
  user?: {
    id?: string;
    email?: string;
  };
}

async function waitForHealthy(baseUrl: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/status`);
      if (r.ok) return;
      lastErr = `status=${String(r.status)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(3_000);
  }
  throw new Error(
    `Infisical did not become ready within ${String(timeoutMs)}ms (last: ${String(lastErr)})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `npx -y @infisical/cli@<ver> bootstrap ...` and parse its JSON output. */
async function runInfisicalBootstrap(
  baseUrl: string,
  email: string,
  password: string,
  orgName: string,
  log: (line: string) => void,
): Promise<CliBootstrapOutput> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      `@infisical/cli@${INFISICAL_CLI_VERSION}`,
      "bootstrap",
      "--domain", baseUrl,
      "--email", email,
      "--password", password,
      "--organization", orgName,
      "--output", "json",
      "--ignore-if-bootstrapped",
    ];
    log(`[infisical] invoking: npx ${args.slice(0, 3).join(" ")} bootstrap …`);
    const proc = spawn("npx", args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // Surface progress lines so the install doesn't look hung while npx
      // downloads the CLI (~20 MB).
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) log(`[npx] ${line.trim()}`);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(
          `infisical bootstrap exited ${String(code)}\nstdout: ${stdout.slice(-1000)}\nstderr: ${stderr.slice(-1000)}`,
        ));
        return;
      }
      // The CLI prints JSON on stdout; strip anything before the first "{".
      const start = stdout.indexOf("{");
      if (start === -1) {
        reject(new Error(`infisical bootstrap returned no JSON: ${stdout.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.slice(start)) as CliBootstrapOutput);
      } catch (err) {
        reject(new Error(
          `infisical bootstrap JSON parse failed: ${(err as Error).message}\nraw: ${stdout.slice(0, 500)}`,
        ));
      }
    });
  });
}

async function authFetch<T>(
  url: string,
  bearer: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const r = await fetch(url, { ...init, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${url} → ${String(r.status)}: ${body.slice(0, 400)}`);
  }
  return (await r.json()) as T;
}

/**
 * Attach universal-auth to the bootstrap identity + generate a client secret.
 * Returns { clientId, clientSecret } the server can use to authenticate.
 */
async function attachUniversalAuth(
  baseUrl: string,
  bearer: string,
  identityId: string,
): Promise<{ clientId: string; clientSecret: string }> {
  // 1. Attach universal-auth method. TTL 0 = no expiry; use limits 0 = unlimited.
  await authFetch(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
    bearer,
    {
      method: "POST",
      body: JSON.stringify({
        clientSecretTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
        accessTokenTrustedIps: [{ ipAddress: "0.0.0.0/0" }],
        accessTokenTTL: 2592000,
        accessTokenMaxTTL: 2592000,
        accessTokenNumUsesLimit: 0,
      }),
    },
  );

  // 2. Generate a client secret.
  const csResp = await authFetch<{
    clientSecret?: string;
    clientSecretData?: { clientSecret?: string };
  }>(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`,
    bearer,
    {
      method: "POST",
      body: JSON.stringify({
        description: "agenthub-server universal-auth",
        numUsesLimit: 0,
        ttl: 0,
      }),
    },
  );
  const clientSecret = csResp.clientSecret ?? csResp.clientSecretData?.clientSecret;
  if (!clientSecret) throw new Error("client-secrets returned no secret");

  // 3. Read the clientId from the universal-auth config.
  const uaResp = await authFetch<{
    identityUniversalAuth?: { clientId: string };
  }>(
    `${baseUrl}/api/v1/auth/universal-auth/identities/${identityId}`,
    bearer,
    { method: "GET" },
  );
  const clientId = uaResp.identityUniversalAuth?.clientId;
  if (!clientId) throw new Error("universal-auth GET returned no clientId");

  return { clientId, clientSecret };
}

/** Create a project + attach the identity with admin role. */
async function createProjectAndAttach(
  baseUrl: string,
  bearerToken: string,
  orgId: string,
  identityId: string,
  projectName: string,
): Promise<string> {
  const proj = await authFetch<{
    project?: { id: string };
    workspace?: { id: string };
  }>(`${baseUrl}/api/v2/workspace`, bearerToken, {
    method: "POST",
    body: JSON.stringify({
      projectName,
      slug: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      organizationId: orgId,
    }),
  });
  const projectId = proj.project?.id ?? proj.workspace?.id;
  if (!projectId) throw new Error("workspace create returned no id");

  // The project creator's identity is auto-added as a member when the
  // workspace is created, so this attach is typically a no-op. We still
  // issue it to handle edge cases where project creation was handed off
  // or the API stops auto-adding — 400 "already exists" is fine.
  try {
    await authFetch(
      `${baseUrl}/api/v2/workspace/${projectId}/identity-memberships/${identityId}`,
      bearerToken,
      {
        method: "POST",
        body: JSON.stringify({ role: "admin" }),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/already exists/i.test(msg)) throw err;
  }

  return projectId;
}

/**
 * Add the admin user as an admin member of the AgentHub project so the UI
 * actually shows the project + its secrets.
 *
 * The Infisical REST API for adding project members requires
 * workspace-encryption keys (legacy E2E crypto fields) that neither the
 * identity bearer nor the admin user can supply post-bootstrap — the admin
 * user is also created with a legacy encryption scheme and can't even log
 * into the modern v3 password endpoint. The current DB schema no longer
 * stores those fields for new members, so a plain two-row insert lines up
 * with how the UI would have recorded membership had it been able to.
 *
 * We execute via `docker compose exec` against the Infisical Postgres
 * service. The installer runs on the same host as the compose stack, so
 * this is transport-local; we're not widening the network surface.
 */
async function grantAdminUserProjectMembership(input: {
  composeDir: string;
  envFile: string;
  adminEmail: string;
  projectId: string;
  log: (line: string) => void;
}): Promise<void> {
  // Infisical's schema mixes uuid and character-varying types:
  //   users.id                               uuid
  //   project_memberships.userId             uuid
  //   project_memberships.id                 uuid
  //   projects.id                            character varying
  //   project_memberships.projectId          character varying
  //   project_user_membership_roles.id       uuid
  //   project_user_membership_roles.projectMembershipId  uuid
  // PL/pgSQL is strict about type matches, so declare locals accordingly
  // and pass the project-id as a plain string literal (no ::uuid cast).
  const pid = `'${input.projectId}'`;
  const sql = `
DO $$
DECLARE
  v_user_id        uuid;
  v_project_exists int;
  v_membership_id  uuid;
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = '${input.adminEmail.replace(/'/g, "''")}';
  SELECT COUNT(*) INTO v_project_exists FROM projects WHERE id = ${pid};
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'admin user not found';
  END IF;
  IF v_project_exists = 0 THEN
    RAISE EXCEPTION 'project not found';
  END IF;
  IF EXISTS (SELECT 1 FROM project_memberships WHERE "userId" = v_user_id AND "projectId" = ${pid}) THEN
    RETURN;
  END IF;
  v_membership_id := gen_random_uuid();
  INSERT INTO project_memberships (id, "userId", "projectId", "createdAt", "updatedAt")
    VALUES (v_membership_id, v_user_id, ${pid}, now(), now());
  INSERT INTO project_user_membership_roles
    (id, role, "projectMembershipId", "createdAt", "updatedAt", "isTemporary")
    VALUES (gen_random_uuid(), 'admin', v_membership_id, now(), now(), false);
END $$;
`.trim();

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "docker",
      [
        "compose",
        "--env-file",
        input.envFile,
        "-f",
        `${input.composeDir}/docker-compose.yml`,
        "exec",
        "-T",
        "infisical-postgres",
        "sh",
        "-c",
        // DB password is available as env inside the container via
        // POSTGRES_PASSWORD set by compose. psql respects PGPASSWORD.
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U infisical -d infisical',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) input.log(`[psql] ${line.trim()}`);
      }
    });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql grant admin membership failed (exit ${String(code)}): ${stderr.slice(-500)}`));
    });
    proc.stdin.end(sql);
  });
}

export async function bootstrapInfisical(
  input: BootstrapInput,
  log: (line: string) => void,
): Promise<BootstrapResult> {
  log(`[infisical] waiting for ${input.baseUrl}/api/status…`);
  await waitForHealthy(input.baseUrl);
  log("[infisical] instance is up");

  const adminPassword = randomPassword(24);

  log("[infisical] running `infisical bootstrap` (may download CLI on first run)…");
  const out = await runInfisicalBootstrap(
    input.baseUrl,
    input.adminEmail,
    adminPassword,
    input.orgName,
    log,
  );

  const bearer = out.identity?.credentials?.token;
  const orgId = out.organization?.id;
  const identityId = out.identity?.id;

  if (!bearer) {
    throw new Error(
      "Infisical bootstrap succeeded but returned no identity.credentials.token. " +
        "The CLI output shape may have changed — check the raw JSON and open an issue.",
    );
  }
  if (!orgId || !identityId) {
    throw new Error(
      "Infisical bootstrap response missing organization.id or identity.id — unexpected shape",
    );
  }

  log(`[infisical] bootstrap done: org ${orgId}, identity ${identityId}`);

  // The bootstrap identity only carries a raw JWT. AgentHub's secret store
  // (InfisicalStore) uses universal-auth login, which needs a clientId +
  // clientSecret pair. Attach universal-auth to the bootstrap identity and
  // generate those creds.
  log("[infisical] attaching universal-auth + generating client secret…");
  const { clientId, clientSecret } = await attachUniversalAuth(
    input.baseUrl,
    bearer,
    identityId,
  );

  log(`[infisical] creating project "${input.projectName}" + attaching identity…`);
  const projectId = await createProjectAndAttach(
    input.baseUrl,
    bearer,
    orgId,
    identityId,
    input.projectName,
  );

  // The bootstrap CLI creates the admin user with Infisical's legacy
  // encryption scheme, which the modern v3 password-login endpoint
  // refuses. Without this step the user can log into the UI but sees no
  // projects, while AgentHub silently reads/writes secrets through the
  // machine identity. Grant admin-level membership directly via the
  // Infisical Postgres to bring the UI in line with reality.
  log("[infisical] granting admin user project membership…");
  await grantAdminUserProjectMembership({
    composeDir: input.composeDir,
    envFile: input.envFile,
    adminEmail: input.adminEmail,
    projectId,
    log,
  });

  log(`[infisical] project ${projectId} ready`);
  return {
    adminEmail: input.adminEmail,
    adminPassword,
    projectId,
    clientId,
    clientSecret,
  };
}
