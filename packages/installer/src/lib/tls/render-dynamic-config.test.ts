import { describe, it, expect } from "vitest";
import { load as parseYaml } from "js-yaml";
import { renderTraefikDynamicConfig } from "./render-dynamic-config.js";

describe("renderTraefikDynamicConfig", () => {
  it("emits redirect router + middleware + stub service", () => {
    const yaml = renderTraefikDynamicConfig();
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    const http = parsed["http"] as Record<string, unknown>;

    const middlewares = http["middlewares"] as Record<string, unknown>;
    expect(middlewares["redirect-to-https"]).toEqual({
      redirectScheme: { scheme: "https", permanent: true },
    });

    const routers = http["routers"] as Record<string, unknown>;
    const router = routers["redirect-all-to-https"] as Record<string, unknown>;
    expect(router["rule"]).toBe("HostRegexp(`{any:.+}`)");
    expect(router["entryPoints"]).toEqual(["web"]);
    expect(router["middlewares"]).toEqual(["redirect-to-https"]);
    expect(router["priority"]).toBe(1);
    expect(router["service"]).toBe("redirect-stub");

    const services = http["services"] as Record<string, unknown>;
    const stub = services["redirect-stub"] as { loadBalancer: { servers: { url: string }[] } };
    expect(stub.loadBalancer.servers[0]?.url).toMatch(/127\.0\.0\.1:65535/);
  });
});
