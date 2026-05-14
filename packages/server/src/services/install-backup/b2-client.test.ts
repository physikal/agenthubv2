import { describe, it, expect } from "vitest";
import { buildRcloneConfig, b2RemotePath } from "./b2-client.js";

describe("buildRcloneConfig", () => {
  it("emits a Backblaze B2 rclone config by default", () => {
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

  it("emits an S3-compatible rclone config when backend=s3", () => {
    const config = buildRcloneConfig({
      backend: "s3",
      keyId: "AKIAEXAMPLE",
      appKey: "secret",
      bucket: "my-bucket",
      pathPrefix: "installs/",
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
    });
    expect(config).toContain("type = s3");
    expect(config).toContain("provider = Other");
    expect(config).toContain("access_key_id = AKIAEXAMPLE");
    expect(config).toContain("secret_access_key = secret");
    expect(config).toContain("region = auto");
    expect(config).toContain("endpoint = https://account.r2.cloudflarestorage.com");
    // Remote section name is still [b2] so b2Push/b2Pull/etc don't need
    // to know which backend is configured.
    expect(config).toContain("[b2]");
  });

  it("defaults S3 region to auto when omitted", () => {
    const config = buildRcloneConfig({
      backend: "s3",
      keyId: "k",
      appKey: "s",
      bucket: "b",
      pathPrefix: "",
    });
    expect(config).toContain("region = auto");
  });

  it("omits endpoint line when not set (AWS S3 path)", () => {
    const config = buildRcloneConfig({
      backend: "s3",
      keyId: "k",
      appKey: "s",
      bucket: "b",
      pathPrefix: "",
      region: "us-east-1",
    });
    expect(config).not.toContain("endpoint =");
    expect(config).toContain("region = us-east-1");
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
