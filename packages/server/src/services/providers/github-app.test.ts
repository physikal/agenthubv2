import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Octokit / auth-app surface before importing the module under test.
// Each test sets up behavior via the returned mock functions. Keeping these
// at module scope (not per-test) works because each describe block resets
// the mock state in beforeEach.
const authMock = vi.fn();
const getInstallationMock = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => authMock,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: { apps: { getInstallation: getInstallationMock } },
  })),
}));

// Secret store stub — also has to be in place before module import because
// the module resolves it lazily per-call but tests want deterministic
// behavior. We mock the exported singleton via a shared state object.
const secretStoreState = {
  configured: true as boolean,
  secrets: {} as Record<string, string>,
};
vi.mock("../secrets/index.js", () => ({
  getSecretStore: () => ({
    get configured() {
      return secretStoreState.configured;
    },
    async getAllSecrets(_path: string) {
      return { ...secretStoreState.secrets };
    },
    async setSecrets(_path: string, values: Record<string, string>) {
      secretStoreState.secrets = { ...secretStoreState.secrets, ...values };
    },
  }),
}));

// DB row the module's SELECTs return. Mutated per-test.
const dbState = { appConfigRow: null as null | {
  appId: number; slug: string; clientId: string; name: string; htmlUrl: string;
  registeredByUserId: string; createdAt: Date; id: string;
} };

vi.mock("../../db/index.js", () => {
  const makeSelectChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      get: () => dbState.appConfigRow ?? undefined,
      all: () => (dbState.appConfigRow ? [dbState.appConfigRow] : []),
    };
    return chain;
  };
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => ({
        values: (v: typeof dbState.appConfigRow) => ({
          run: () => {
            dbState.appConfigRow = v;
          },
        }),
      }),
      update: () => ({
        set: (v: Partial<NonNullable<typeof dbState.appConfigRow>>) => ({
          where: () => ({
            run: () => {
              if (dbState.appConfigRow) {
                dbState.appConfigRow = { ...dbState.appConfigRow, ...v };
              }
            },
          }),
        }),
      }),
    },
    schema: {
      githubAppConfig: { id: { name: "id" } },
    },
  };
});

// drizzle's `eq` isn't used at runtime in our mock, but the real module
// imports it — stub to return a sentinel.
vi.mock("drizzle-orm", () => ({ eq: () => true }));

const { DeployError } = await import("../deploy-error.js");
const {
  installUrlFor,
  isGithubAppRegistered,
  loadGithubAppCreds,
  mintInstallationToken,
  fetchInstallationMetadata,
  upsertGithubAppConfig,
  GITHUB_APP_SECRETS_PATH,
} = await import("./github-app.js");

function resetState(): void {
  secretStoreState.configured = true;
  secretStoreState.secrets = {};
  dbState.appConfigRow = null;
  authMock.mockReset();
  getInstallationMock.mockReset();
}

describe("installUrlFor", () => {
  it("builds an installations/new URL with state param encoded", () => {
    expect(installUrlFor("my-app", "abc123")).toBe(
      "https://github.com/apps/my-app/installations/new?state=abc123",
    );
  });

  it("URL-encodes the slug", () => {
    expect(installUrlFor("slug with spaces", "s")).toContain(
      "/apps/slug%20with%20spaces/",
    );
  });
});

describe("isGithubAppRegistered", () => {
  beforeEach(resetState);

  it("returns false when the config row is missing", () => {
    expect(isGithubAppRegistered()).toBe(false);
  });

  it("returns true once the row is present", () => {
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "test-app",
      clientId: "cid",
      name: "Test",
      htmlUrl: "https://github.com/apps/test-app",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    expect(isGithubAppRegistered()).toBe(true);
  });
});

describe("loadGithubAppCreds", () => {
  beforeEach(resetState);

  it("throws DeployError(404) when no App registered", async () => {
    await expect(loadGithubAppCreds()).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws SecretStoreNotConfiguredError when the secret store is unavailable", async () => {
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "x",
      clientId: "cid",
      name: "X",
      htmlUrl: "u",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    secretStoreState.configured = false;
    await expect(loadGithubAppCreds()).rejects.toThrow(/secret store/i);
  });

  it("throws DeployError(500) when stored secrets are incomplete", async () => {
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "x",
      clientId: "cid",
      name: "X",
      htmlUrl: "u",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    secretStoreState.secrets = { privateKey: "pem" }; // missing webhookSecret
    await expect(loadGithubAppCreds()).rejects.toMatchObject({ status: 500 });
  });

  it("returns a merged creds object on success", async () => {
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "my-app",
      clientId: "Iv1.abc",
      name: "My App",
      htmlUrl: "https://github.com/apps/my-app",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    secretStoreState.secrets = { privateKey: "pem", webhookSecret: "whs" };
    const creds = await loadGithubAppCreds();
    expect(creds).toEqual({
      appId: 42,
      clientId: "Iv1.abc",
      slug: "my-app",
      name: "My App",
      htmlUrl: "https://github.com/apps/my-app",
      privateKey: "pem",
      webhookSecret: "whs",
    });
  });
});

describe("mintInstallationToken", () => {
  beforeEach(() => {
    resetState();
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "my-app",
      clientId: "Iv1.abc",
      name: "My App",
      htmlUrl: "u",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    secretStoreState.secrets = { privateKey: "pem", webhookSecret: "whs" };
  });

  it("returns the token string on happy path", async () => {
    authMock.mockResolvedValueOnce({ token: "ghs_ABC" });
    await expect(mintInstallationToken(12345)).resolves.toBe("ghs_ABC");
  });

  it("wraps underlying errors as DeployError(502)", async () => {
    authMock.mockRejectedValueOnce(new Error("Installation suspended"));
    await expect(mintInstallationToken(12345)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("fetchInstallationMetadata", () => {
  beforeEach(() => {
    resetState();
    dbState.appConfigRow = {
      id: "default",
      appId: 42,
      slug: "my-app",
      clientId: "Iv1.abc",
      name: "My App",
      htmlUrl: "u",
      registeredByUserId: "u1",
      createdAt: new Date(),
    };
    secretStoreState.secrets = { privateKey: "pem", webhookSecret: "whs" };
  });

  it("returns the normalized account shape on success", async () => {
    getInstallationMock.mockResolvedValueOnce({
      data: {
        id: 12345,
        account: { login: "physikal", type: "User" },
        target_type: "User",
        repository_selection: "selected",
        permissions: { contents: "write", metadata: "read" },
      },
    });
    await expect(fetchInstallationMetadata(12345)).resolves.toEqual({
      installationId: 12345,
      login: "physikal",
      accountType: "User",
      targetType: "User",
      repositorySelection: "selected",
      permissions: { contents: "write", metadata: "read" },
    });
  });

  it("defaults repository_selection to 'all' when GitHub omits selected", async () => {
    getInstallationMock.mockResolvedValueOnce({
      data: {
        id: 1,
        account: { login: "org", type: "Organization" },
        target_type: "Organization",
        repository_selection: "all",
      },
    });
    const meta = await fetchInstallationMetadata(1);
    expect(meta.repositorySelection).toBe("all");
    expect(meta.accountType).toBe("Organization");
  });

  it("rejects unsupported account types (e.g. Enterprise)", async () => {
    getInstallationMock.mockResolvedValueOnce({
      data: {
        id: 1,
        account: { login: "entacct", type: "Enterprise" },
        target_type: "Enterprise",
        repository_selection: "all",
      },
    });
    await expect(fetchInstallationMetadata(1)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects installations with a missing account field", async () => {
    getInstallationMock.mockResolvedValueOnce({
      data: { id: 1, account: null, target_type: "User", repository_selection: "all" },
    });
    await expect(fetchInstallationMetadata(1)).rejects.toBeInstanceOf(DeployError);
  });
});

describe("upsertGithubAppConfig", () => {
  beforeEach(resetState);

  it("creates the row + stores secrets on first call", async () => {
    await upsertGithubAppConfig({
      appId: 42,
      slug: "my-app",
      clientId: "Iv1.abc",
      name: "My App",
      htmlUrl: "https://github.com/apps/my-app",
      privateKey: "pem",
      webhookSecret: "whs",
      clientSecret: "sekret",
      registeredByUserId: "u1",
    });
    expect(dbState.appConfigRow).toMatchObject({ appId: 42, slug: "my-app" });
    expect(secretStoreState.secrets).toMatchObject({
      privateKey: "pem",
      webhookSecret: "whs",
      clientSecret: "sekret",
    });
  });

  it("updates the existing row on re-register (no duplicates)", async () => {
    await upsertGithubAppConfig({
      appId: 42,
      slug: "old-app",
      clientId: "cid1",
      name: "Old",
      htmlUrl: "u1",
      privateKey: "pem1",
      webhookSecret: "whs1",
      registeredByUserId: "u1",
    });
    await upsertGithubAppConfig({
      appId: 99,
      slug: "new-app",
      clientId: "cid2",
      name: "New",
      htmlUrl: "u2",
      privateKey: "pem2",
      webhookSecret: "whs2",
      registeredByUserId: "u2",
    });
    expect(dbState.appConfigRow).toMatchObject({ appId: 99, slug: "new-app" });
    expect(secretStoreState.secrets["privateKey"]).toBe("pem2");
  });

  it("throws when the secret store is unconfigured (fail-fast on bootstrap)", async () => {
    secretStoreState.configured = false;
    await expect(
      upsertGithubAppConfig({
        appId: 1, slug: "x", clientId: "c", name: "X", htmlUrl: "u",
        privateKey: "pem", webhookSecret: "whs", registeredByUserId: "u1",
      }),
    ).rejects.toThrow(/secret store/i);
  });
});

describe("GITHUB_APP_SECRETS_PATH", () => {
  it("is stable — changing it would orphan existing secrets", () => {
    expect(GITHUB_APP_SECRETS_PATH).toBe("/system/github-app");
  });
});
