import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthUser } from "../middleware/auth.js";
import { workspaceEnvRoutes } from "./workspace-env.js";

// Mock the underlying secret store so we don't hit Infisical from tests.
interface FakeStore {
  configured: boolean;
  getAllSecrets: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  deleteSecret: ReturnType<typeof vi.fn>;
}
let fakeStore: FakeStore;

vi.mock("../services/secrets/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/secrets/index.js")>();
  return {
    ...original,
    getSecretStore: () => fakeStore,
  };
});

beforeEach(() => {
  fakeStore = {
    configured: true,
    getAllSecrets: vi.fn(async () => ({})),
    setSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
});

function makeApp(): Hono<{ Variables: { user: AuthUser } }> {
  const wrapper = new Hono<{ Variables: { user: AuthUser } }>();
  wrapper.use("*", async (c, next) => {
    c.set("user", { id: "user-1", username: "tester", role: "user" });
    return next();
  });
  wrapper.route("/", workspaceEnvRoutes());
  return wrapper;
}

describe("workspace-env routes", () => {
  it("GET / returns sorted names, never values", async () => {
    fakeStore.getAllSecrets.mockResolvedValueOnce({
      ZULU: "z",
      ALPHA: "a",
      MIKE: "m",
    });
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { names: string[] };
    expect(body.names).toEqual(["ALPHA", "MIKE", "ZULU"]);
  });

  it("POST / upserts a valid secret", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MY_TOKEN", value: "secret-value" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fakeStore.setSecret).toHaveBeenCalledWith(
      "/users/user-1/workspace-env",
      "MY_TOKEN",
      "secret-value",
    );
  });

  it("POST / rejects bad body shape", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MY_TOKEN" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST / rejects bad name as 400", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "lowercase", value: "v" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Name must match/);
    expect(fakeStore.setSecret).not.toHaveBeenCalled();
  });

  it("POST / rejects reserved name as 400", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "v" }),
    });
    expect(res.status).toBe(400);
    expect(fakeStore.setSecret).not.toHaveBeenCalled();
  });

  it("DELETE /:name removes one secret", async () => {
    const res = await makeApp().request("/MY_TOKEN", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(fakeStore.deleteSecret).toHaveBeenCalledWith(
      "/users/user-1/workspace-env",
      "MY_TOKEN",
    );
  });

  it("DELETE /:name rejects bad name as 400 without touching store", async () => {
    const res = await makeApp().request("/lowercase", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(fakeStore.deleteSecret).not.toHaveBeenCalled();
  });
});
