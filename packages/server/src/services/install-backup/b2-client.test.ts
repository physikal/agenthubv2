import { describe, it, expect } from "vitest";
import { buildRcloneConfig, b2RemotePath } from "./b2-client.js";

describe("buildRcloneConfig", () => {
  it("emits an rclone-compatible config string", () => {
    const config = buildRcloneConfig({
      keyId: "k001abc",
      appKey: "secret",
      bucket: "agenthub-installs",
      pathPrefix: "installs/",
    });
    expect(config).toContain("[b2]");
    expect(config).toContain("type = b2");
    expect(config).toContain("account = k001abc");
    expect(config).toContain("key = secret");
  });
});

describe("b2RemotePath", () => {
  it("joins prefix + filename without double slash", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "installs/",
      }, "install-foo.tar.gz"),
    ).toBe("b2:b/installs/install-foo.tar.gz");
  });

  it("handles missing prefix", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "",
      }, "x.tar.gz"),
    ).toBe("b2:b/x.tar.gz");
  });

  it("normalizes prefix without trailing slash", () => {
    expect(
      b2RemotePath({
        keyId: "",
        appKey: "",
        bucket: "b",
        pathPrefix: "installs",
      }, "x.tar.gz"),
    ).toBe("b2:b/installs/x.tar.gz");
  });
});
