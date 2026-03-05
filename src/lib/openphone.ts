import crypto from "crypto";
import { config, requireConfigValue } from "../config";
import { IncomingMessageEvent, MissedCallEvent, OutboundMessage } from "../types";

interface OpenPhoneEventEnvelope {
  id?: string;
  type?: string;
  createdAt?: string;
  data?: Record<string, unknown>;
  object?: Record<string, unknown>;
  [key: string]: unknown;
}

function normalizePhone(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value && typeof value === "object") {
    const phoneFromObject = (value as Record<string, unknown>).phoneNumber;
    if (typeof phoneFromObject === "string") {
      return phoneFromObject.trim();
    }
  }

  return "";
}

function getObject(payload: OpenPhoneEventEnvelope): Record<string, unknown> {
  if (payload.data && typeof payload.data === "object") {
    const nestedObject = (payload.data as Record<string, unknown>).object;
    if (nestedObject && typeof nestedObject === "object") {
      return nestedObject as Record<string, unknown>;
    }
    return payload.data as Record<string, unknown>;
  }

  if (payload.object && typeof payload.object === "object") {
    return payload.object as Record<string, unknown>;
  }

  return payload as Record<string, unknown>;
}

export function extractMissedCallEvent(payload: OpenPhoneEventEnvelope): MissedCallEvent | null {
  const eventType = String(payload.type ?? "");
  if (eventType !== "call.completed") {
    return null;
  }

  const object = getObject(payload);
  const answeredAt = object.answeredAt;
  const direction = String(object.direction ?? "").toLowerCase();

  const isIncoming = direction === "incoming" || direction === "inbound" || direction === "";
  const isMissed = answeredAt === null || answeredAt === undefined;

  if (!isIncoming || !isMissed) {
    return null;
  }

  const phone = normalizePhone(object.from);
  const businessNumber = normalizePhone(object.to) || config.openPhoneDefaultFromNumber || "";

  if (!phone || !businessNumber) {
    return null;
  }

  return {
    eventId: String(payload.id ?? `${eventType}:${phone}:${payload.createdAt ?? Date.now()}`),
    eventType,
    phone,
    businessNumber,
    timestampIso: String(payload.createdAt ?? new Date().toISOString())
  };
}

export function extractIncomingMessageEvent(payload: OpenPhoneEventEnvelope): IncomingMessageEvent | null {
  const eventType = String(payload.type ?? "");
  if (eventType !== "message.received") {
    return null;
  }

  const object = getObject(payload);
  const direction = String(object.direction ?? "").toLowerCase();

  if (direction && direction !== "incoming" && direction !== "inbound") {
    return null;
  }

  const phone = normalizePhone(object.from);
  const businessNumber = normalizePhone(object.to) || config.openPhoneDefaultFromNumber || "";
  const text = typeof object.body === "string" ? object.body.trim() : "";

  if (!phone || !businessNumber || !text) {
    return null;
  }

  return {
    eventId: String(payload.id ?? `${eventType}:${phone}:${payload.createdAt ?? Date.now()}`),
    eventType,
    phone,
    businessNumber,
    text,
    timestampIso: String(payload.createdAt ?? new Date().toISOString())
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function normalizeRawPayload(rawBody: string): string {
  try {
    return JSON.stringify(JSON.parse(rawBody));
  } catch {
    return rawBody.trim();
  }
}

function parseOpenPhoneSignatureHeader(signatureHeader: string): Array<{ timestamp: string; signature: string }> {
  const pieces = signatureHeader.split(",").map((piece) => piece.trim());
  const parsed: Array<{ timestamp: string; signature: string }> = [];

  for (const piece of pieces) {
    const segments = piece.split(";");
    if (segments.length === 4 && segments[0] === "hmac") {
      parsed.push({
        timestamp: segments[2],
        signature: segments[3]
      });
    }
  }

  return parsed;
}

export function verifyWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  signingSecretBase64: string | undefined;
  toleranceSeconds: number;
  allowUnsigned: boolean;
}): boolean {
  if (!input.signingSecretBase64) {
    return input.allowUnsigned;
  }

  if (!input.signatureHeader) {
    return false;
  }

  const candidates = parseOpenPhoneSignatureHeader(input.signatureHeader);
  if (candidates.length === 0) {
    return false;
  }

  const payload = normalizeRawPayload(input.rawBody);
  const key = decodeSigningSecret(input.signingSecretBase64);
  const nowSeconds = Math.floor(Date.now() / 1000);

  for (const candidate of candidates) {
    const timestamp = Number(candidate.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (Math.abs(nowSeconds - timestamp) > input.toleranceSeconds) {
      continue;
    }

    const toSign = `${candidate.timestamp}.${payload}`;
    const digest = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("base64");

    if (safeEqual(digest, candidate.signature)) {
      return true;
    }
  }

  return false;
}

function decodeSigningSecret(secret: string): Buffer {
  const normalized = secret.trim();
  const isBase64Like = /^[A-Za-z0-9+/]+={0,2}$/.test(normalized) && normalized.length % 4 === 0;

  if (isBase64Like) {
    try {
      const decoded = Buffer.from(normalized, "base64");
      const roundTrip = decoded.toString("base64").replace(/=+$/, "");
      if (roundTrip === normalized.replace(/=+$/, "")) {
        return decoded;
      }
    } catch {
      // Fall through to utf8
    }
  }

  return Buffer.from(secret, "utf8");
}

export class OpenPhoneClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = requireConfigValue(config.openPhoneApiKey, "OPENPHONE_API_KEY");
    this.baseUrl = config.openPhoneApiBaseUrl.replace(/\/+$/, "");
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        content: message.content
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenPhone sendMessage failed (${response.status}): ${body}`);
    }
  }
}

let singleton: OpenPhoneClient | null = null;

export function getOpenPhoneClient(): OpenPhoneClient {
  if (!singleton) {
    singleton = new OpenPhoneClient();
  }
  return singleton;
}
