import { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../../src/config";
import {
  extractIncomingMessageEvent,
  extractMissedCallEvent,
  verifyWebhookSignature
} from "../../src/lib/openphone";
import { readRawBody } from "../../src/lib/http";
import { getConversationEngine } from "../../src/lib/conversation-engine";
import { getSheetStore } from "../../src/lib/sheets";

function json(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).json(body);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const engine = getConversationEngine();
  const store = getSheetStore();

  await engine.initialize();

  const rawBody = await readRawBody(req);
  const signatureHeader =
    typeof req.headers["openphone-signature"] === "string"
      ? req.headers["openphone-signature"]
      : undefined;

  const signatureValid = verifyWebhookSignature({
    rawBody,
    signatureHeader,
    signingSecretBase64: config.openPhoneWebhookSigningSecret,
    toleranceSeconds: config.webhookTimestampToleranceSeconds,
    allowUnsigned: config.allowUnsignedWebhooks
  });

  if (!signatureValid) {
    json(res, 401, { ok: false, error: "Invalid webhook signature" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    json(res, 400, { ok: false, error: "Invalid JSON payload" });
    return;
  }

  const eventId = String(payload.id ?? payload.event_id ?? "");
  const eventType = String(payload.type ?? payload.event_type ?? "unknown");

  if (eventId && (await store.hasProcessedEvent(eventId))) {
    json(res, 200, { ok: true, deduped: true });
    return;
  }

  const missedCall = extractMissedCallEvent(payload);
  const incomingMessage = extractIncomingMessageEvent(payload);

  try {
    if (missedCall) {
      await engine.handleMissedCall(missedCall);
    } else if (incomingMessage) {
      await engine.handleIncomingMessage(incomingMessage);
    }

    if (eventId) {
      await store.markEventProcessed(eventId, eventType);
    }

    json(res, 200, {
      ok: true,
      handled: Boolean(missedCall || incomingMessage),
      eventType
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown processing error";

    const failurePhone = incomingMessage?.phone ?? missedCall?.phone;
    const failureBusiness = incomingMessage?.businessNumber ?? missedCall?.businessNumber ?? "";

    if (failurePhone && failureBusiness) {
      await engine.handleProcessingFailure({
        phone: failurePhone,
        businessNumber: failureBusiness,
        reason: errorMessage,
        eventType
      });
    }

    json(res, 500, {
      ok: false,
      error: errorMessage,
      eventType
    });
  }
}
