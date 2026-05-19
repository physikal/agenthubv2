import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateName,
  validateValue,
  listWorkspaceEnvNames,
  setWorkspaceEnv,
  deleteWorkspaceEnv,
  resolveWorkspaceEnv,
} from "./workspace-env.js";

interface FakeStore {
  configured: boolean;
  getAllSecrets: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  deleteSecret: ReturnType<typeof vi.fn>;
}

let fakeStore: FakeStore;

vi.mock("./index.js", () => ({
  getSecretStore: () => fakeStore,
}));

beforeEach(() => {
  fakeStore = {
    configured: true,
    getAllSecrets: vi.fn(async () => ({})),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
});

describe("validateName", () => {
  it("accepts POSIX-style names", () => {
    for (const ok of ["CLOUDFLARE_API_TOKEN", "MY_VAR", "_LEADING_UNDERSCORE", "X", "K8S_NAMESPACE_2"]) {
      expect(validateName(ok)).toBeNull();
    }
  });

  it("rejects lowercase, digits-leading, and special chars", () => {
    for (const bad of ["lowercase", "1STARTS_WITH_DIGIT", "WITH-DASH", "WITH SPACE", "", "WITH.DOT"]) {
      expect(validateName(bad)?.reason).toBe("format");
    }
  });

  it("rejects reserved AgentHub names", () => {
    for (const reserved of ["AGENT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MINIMAX_API_KEY", "PORT", "HOME"]) {
      expect(validateName(reserved)?.reason).toBe("reserved");
    }
  });
});

describe("validateValue", () => {
  it("accepts values up to 32KB", () => {
    expect(validateValue("a".repeat(32 * 1024))).toBeNull();
    expect(validateValue("")).toBeNull();
  });

  it("rejects values over 32KB", () => {
    expect(validateValue("a".repeat(32 * 1024 + 1))?.reason).toBe("too-long");
  });
});

describe("listWorkspaceEnvNames", () => {
  it("returns names sorted, never values", async () => {
    fakeStore.getAllSecrets.mockResolvedValueOnce({ ZULU: "z", ALPHA: "a", MIKE: "m" });
    const names = await listWorkspaceEnvNames("user-1");
    expect(names).toEqual(["ALPHA", "MIKE", "ZULU"]);
    expect(fakeStore.getAllSecrets).toHaveBeenCalledWith("/users/user-1/workspace-env");
  });

  it("returns [] when store unconfigured", async () => {
    fakeStore.configured = false;
    expect(await listWorkspaceEnvNames("user-1")).toEqual([]);
    expect(fakeStore.getAllSecrets).not.toHaveBeenCalled();
  });
});

describe("setWorkspaceEnv", () => {
  it("writes to /users/{userId}/workspace-env/{name}", async () => {
    await setWorkspaceEnv("user-1", "MY_TOKEN", "secret-value");
    expect(fakeStore.setSecret).toHaveBeenCalledWith(
      "/users/user-1/workspace-env",
      "MY_TOKEN",
      "secret-value",
    );
  });

  it("rejects bad names before touching the store", async () => {
    await expect(setWorkspaceEnv("user-1", "lowercase", "v")).rejects.toThrow(/Name must match/);
    await expect(setWorkspaceEnv("user-1", "ANTHROPIC_API_KEY", "v")).rejects.toThrow(/reserved/i);
    expect(fakeStore.setSecret).not.toHaveBeenCalled();
  });

  it("rejects values over the size cap", async () => {
    await expect(setWorkspaceEnv("user-1", "BIG", "a".repeat(32 * 1024 + 1))).rejects.toThrow(/32768/);
    expect(fakeStore.setSecret).not.toHaveBeenCalled();
  });
});

describe("deleteWorkspaceEnv", () => {
  it("delegates to store.deleteSecret", async () => {
    await deleteWorkspaceEnv("user-1", "MY_TOKEN");
    expect(fakeStore.deleteSecret).toHaveBeenCalledWith(
      "/users/user-1/workspace-env",
      "MY_TOKEN",
    );
  });

  it("no-ops when store unconfigured", async () => {
    fakeStore.configured = false;
    await deleteWorkspaceEnv("user-1", "MY_TOKEN");
    expect(fakeStore.deleteSecret).not.toHaveBeenCalled();
  });

  it("rejects path-traversal-ish names", async () => {
    await expect(deleteWorkspaceEnv("user-1", "../escape")).rejects.toThrow(/Name must match/);
    expect(fakeStore.deleteSecret).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspaceEnv", () => {
  it("returns the user's secrets as a plain object", async () => {
    fakeStore.getAllSecrets.mockResolvedValueOnce({
      CLOUDFLARE_API_TOKEN: "cf_x",
      STRIPE_KEY: "sk_test",
    });
    expect(await resolveWorkspaceEnv("user-1")).toEqual({
      CLOUDFLARE_API_TOKEN: "cf_x",
      STRIPE_KEY: "sk_test",
    });
  });

  it("filters reserved names defensively (belt-and-suspenders)", async () => {
    // Should never happen since setWorkspaceEnv rejects reserved names,
    // but if some other path put one there we don't let it override.
    fakeStore.getAllSecrets.mockResolvedValueOnce({
      CLOUDFLARE_API_TOKEN: "cf_x",
      ANTHROPIC_API_KEY: "user-override-attempt",
    });
    const out = await resolveWorkspaceEnv("user-1");
    expect(out).toEqual({ CLOUDFLARE_API_TOKEN: "cf_x" });
    expect(out["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("returns {} when unconfigured", async () => {
    fakeStore.configured = false;
    expect(await resolveWorkspaceEnv("user-1")).toEqual({});
  });
});
