import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/lib/openphone";

describe("verifyWebhookSignature", () => {
  it("accepts a valid OpenPhone signature", () => {
    const secret = Buffer.from("test-signing-secret").toString("base64");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({ id: "evt_1", type: "call.completed" });

    const digest = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(`${timestamp}.${payload}`, "utf8").digest("base64");

    const signatureHeader = `hmac;1;${timestamp};${digest}`;

    const valid = verifyWebhookSignature({
      rawBody: payload,
      signatureHeader,
      signingSecretBase64: secret,
      toleranceSeconds: 300,
      allowUnsigned: false
    });

    expect(valid).toBe(true);
  });
});
