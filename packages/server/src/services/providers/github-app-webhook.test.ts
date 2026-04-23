import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyWebhookSignature } from "./github-app-webhook.js";

const secret = "whs_test_secret";
const body = JSON.stringify({ action: "created", installation: { id: 42 } });
const sign = (b: string): string =>
  "sha256=" + createHmac("sha256", secret).update(b).digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature on the exact body bytes", () => {
    expect(verifyWebhookSignature(body, sign(body), secret)).toEqual({ ok: true });
  });

  it("rejects when header is missing", () => {
    expect(verifyWebhookSignature(body, null, secret)).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(verifyWebhookSignature(body, undefined, secret)).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("rejects when header lacks the sha256= prefix", () => {
    expect(verifyWebhookSignature(body, "md5=abc", secret)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
    expect(verifyWebhookSignature(body, "deadbeef", secret)).toEqual({
      ok: false,
      reason: "malformed_header",
    });
  });

  it("rejects a tampered body", () => {
    const signed = sign(body);
    const tampered = body.replace('"id":42', '"id":99');
    expect(verifyWebhookSignature(tampered, signed, secret)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a wrong-secret signature", () => {
    const otherSig =
      "sha256=" + createHmac("sha256", "wrong").update(body).digest("hex");
    expect(verifyWebhookSignature(body, otherSig, secret)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects when the provided hex has a different length (pre-timingSafeEqual guard)", () => {
    expect(verifyWebhookSignature(body, "sha256=short", secret)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("is whitespace-sensitive — reparsed bodies can invalidate the signature", () => {
    const signed = sign(body);
    const reserialized = JSON.stringify(JSON.parse(body));
    // For this particular input the round-trip happens to be byte-identical,
    // but the test exists to document the constraint. A body with extra
    // whitespace would fail:
    expect(verifyWebhookSignature(reserialized, signed, secret).ok).toBe(true);
    expect(verifyWebhookSignature(body + "\n", signed, secret).ok).toBe(false);
  });
});
