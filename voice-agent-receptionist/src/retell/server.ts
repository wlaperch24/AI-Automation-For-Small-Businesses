import http from "node:http";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { loadRuntimeConfig } from "../sim/call_simulator";
import { CreateAppointmentArgs, LocalCalendarTool } from "../tools/calendar";
import { SqliteLogger } from "../tools/logging";
import { QuoteService } from "../services/quote";
import { SimulatedSmsTool } from "../tools/sms";

type JsonObject = Record<string, unknown>;

interface JsonRequestBody {
  raw: string;
  payload: unknown;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data)
  });
  response.end(data);
}

function notFound(response: http.ServerResponse): void {
  sendJson(response, 404, {
    ok: false,
    error: "Not found"
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return { raw, payload: {} };
  }
  return {
    raw,
    payload: JSON.parse(raw)
  };
}

function extractToolArgs(payload: JsonObject): JsonObject {
  const direct = asObject(payload.arguments) ?? asObject(payload.args) ?? asObject(payload.tool_arguments);
  if (direct) {
    return direct;
  }

  const data = asObject(payload.data);
  if (data) {
    const nested = asObject(data.arguments) ?? asObject(data.args) ?? asObject(data.tool_arguments);
    if (nested) {
      return nested;
    }
  }

  return payload;
}

function extractCallId(payload: JsonObject): string | undefined {
  const direct =
    asString(payload.call_id) ??
    asString(payload.callId) ??
    asString(payload.retell_call_id) ??
    asString(payload.callid);
  if (direct) {
    return direct;
  }

  const call = asObject(payload.call);
  if (call) {
    return asString(call.call_id) ?? asString(call.callId) ?? asString(call.id);
  }

  const data = asObject(payload.data);
  if (data) {
    const nestedCall = asObject(data.call);
    if (nestedCall) {
      return asString(nestedCall.call_id) ?? asString(nestedCall.callId) ?? asString(nestedCall.id);
    }
    return asString(data.call_id) ?? asString(data.callId);
  }

  return undefined;
}

function extractCallerPhone(payload: JsonObject): string | undefined {
  const direct =
    asString(payload.from_number) ?? asString(payload.caller_phone) ?? asString(payload.caller_number) ?? asString(payload.phone);
  if (direct) {
    return direct;
  }

  const call = asObject(payload.call);
  if (call) {
    return asString(call.from_number) ?? asString(call.caller_phone) ?? asString(call.caller_number);
  }

  const data = asObject(payload.data);
  if (data) {
    const nestedCall = asObject(data.call);
    if (nestedCall) {
      return asString(nestedCall.from_number) ?? asString(nestedCall.caller_phone) ?? asString(nestedCall.caller_number);
    }
  }

  return undefined;
}

function extractWebhookEventType(payload: JsonObject): string {
  const event = asObject(payload.event);
  return (
    asString(event?.type) ??
    asString(payload.event_type) ??
    asString(payload.type) ??
    "unknown_event"
  );
}

function secureHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const runtimeConfig = loadRuntimeConfig();
const retellApiKey = process.env.RETELL_API_KEY?.trim();
const retellWebhookSecret = process.env.RETELL_WEBHOOK_SECRET?.trim();
const retellAgentId = process.env.RETELL_AGENT_ID?.trim();
const retellPort = Number(process.env.RETELL_PORT ?? "3001");

if (!retellApiKey) {
  console.warn("[WARN] RETELL_API_KEY is not set. Retell API operations will not work.");
}

if (!Number.isFinite(retellPort) || retellPort <= 0) {
  throw new Error("RETELL_PORT must be a positive integer.");
}

const db = new SqliteLogger(runtimeConfig.dbPath, runtimeConfig.schemaPath);
const calendar = new LocalCalendarTool(db, {
  timezone: runtimeConfig.businessTimezone,
  workdayStartHour: runtimeConfig.workdayStartHour,
  workdayEndHour: runtimeConfig.workdayEndHour,
  saturdayStartHour: runtimeConfig.saturdayStartHour,
  saturdayEndHour: runtimeConfig.saturdayEndHour,
  slotDurationHours: runtimeConfig.slotDurationHours
});
const sms = new SimulatedSmsTool(db);
const quoteService = new QuoteService();
const callSessionMap = new Map<string, number>();

function getOrCreateSessionId(callId: string | undefined, callerPhone?: string): number | undefined {
  if (!callId) {
    return undefined;
  }

  const existing = callSessionMap.get(callId);
  if (existing) {
    return existing;
  }

  const sessionId = db.createCallSession({
    mode: "voice",
    callerPhone,
    approvalMode: runtimeConfig.approvalMode
  });
  db.logTurn(sessionId, "system", `Retell call session opened for call_id=${callId}.`);
  callSessionMap.set(callId, sessionId);
  return sessionId;
}

function logToolEvent(
  sessionId: number | undefined,
  toolName: string,
  args: JsonObject,
  result: unknown,
  status: "ok" | "error"
): void {
  db.logToolEvent({
    sessionId,
    toolName,
    argumentsJson: JSON.stringify(args),
    resultJson: JSON.stringify(result),
    status
  });
}

function handleListAvailability(payload: JsonObject, response: http.ServerResponse): void {
  const args = extractToolArgs(payload);
  const callId = extractCallId(payload);
  const sessionId = getOrCreateSessionId(callId, extractCallerPhone(payload));

  const result = calendar.listAvailability({
    date_range_start: asString(args.date_range_start),
    date_range_end: asString(args.date_range_end),
    zip_or_area: asString(args.zip_or_area),
    urgency: asString(args.urgency)
  });

  logToolEvent(sessionId, "retell.listAvailability", args, result, "ok");
  sendJson(response, 200, result);
}

function handleCreateAppointment(payload: JsonObject, response: http.ServerResponse): void {
  const args = extractToolArgs(payload);
  const callId = extractCallId(payload);
  const sessionId = getOrCreateSessionId(callId, extractCallerPhone(payload));

  const booking: CreateAppointmentArgs = {
    name: asString(args.name) ?? "",
    phone: asString(args.phone) ?? "",
    address: asString(args.address) ?? "",
    issue: asString(args.issue) ?? "other",
    urgency: asString(args.urgency) ?? "routine",
    window_start: asString(args.window_start) ?? "",
    window_end: asString(args.window_end) ?? "",
    notes: asString(args.notes)
  };

  if (!booking.name || !booking.phone || !booking.address || !booking.window_start || !booking.window_end) {
    const errorResult = {
      ok: false,
      error_code: "INVALID_ARGUMENTS",
      message: "name, phone, address, window_start, and window_end are required."
    };
    logToolEvent(sessionId, "retell.createAppointment", args, errorResult, "error");
    sendJson(response, 400, errorResult);
    return;
  }

  const created = calendar.createAppointment(booking);
  if (!created.ok) {
    logToolEvent(sessionId, "retell.createAppointment", args, created, "error");
    sendJson(response, 200, created);
    return;
  }

  const confirmationSms = sms.sendSms(
    {
      to: booking.phone,
      message: `Confirmed: Plumbing appointment scheduled for ${created.window_label}. Reply RESCHEDULE if you need to change it.`
    },
    sessionId
  );

  const quote = quoteService.createQuote(booking.issue, booking.urgency);
  const quoteSms = sms.sendSms(
    {
      to: booking.phone,
      message: quoteService.buildQuoteSms(booking.name, quote)
    },
    sessionId
  );

  const result = {
    ...created,
    confirmation_sms_id: confirmationSms.sms_id,
    quote_sms_id: quoteSms.sms_id
  };

  logToolEvent(sessionId, "retell.createAppointment", args, result, "ok");
  sendJson(response, 200, result);
}

function handleCancelAppointment(payload: JsonObject, response: http.ServerResponse): void {
  const args = extractToolArgs(payload);
  const callId = extractCallId(payload);
  const sessionId = getOrCreateSessionId(callId, extractCallerPhone(payload));

  const appointmentId = asNumber(args.appointment_id);
  if (!appointmentId) {
    const errorResult = {
      ok: false,
      error_code: "INVALID_ARGUMENTS",
      message: "appointment_id is required."
    };
    logToolEvent(sessionId, "retell.cancelAppointment", args, errorResult, "error");
    sendJson(response, 400, errorResult);
    return;
  }

  const existing = db.getAppointmentById(appointmentId);
  const cancelled = calendar.cancelAppointment({
    appointment_id: appointmentId,
    reason: asString(args.reason)
  });

  if (cancelled.ok && existing) {
    sms.sendSms(
      {
        to: existing.phone,
        message: `Your plumbing appointment has been cancelled. Reply anytime to schedule a new window.`
      },
      sessionId
    );
  }

  logToolEvent(sessionId, "retell.cancelAppointment", args, cancelled, cancelled.ok ? "ok" : "error");
  sendJson(response, 200, cancelled);
}

function handleRescheduleAppointment(payload: JsonObject, response: http.ServerResponse): void {
  const args = extractToolArgs(payload);
  const callId = extractCallId(payload);
  const sessionId = getOrCreateSessionId(callId, extractCallerPhone(payload));

  const appointmentId = asNumber(args.appointment_id);
  const newWindowStart = asString(args.new_window_start);
  const newWindowEnd = asString(args.new_window_end);

  if (!appointmentId || !newWindowStart || !newWindowEnd) {
    const errorResult = {
      ok: false,
      error_code: "INVALID_ARGUMENTS",
      message: "appointment_id, new_window_start, and new_window_end are required."
    };
    logToolEvent(sessionId, "retell.rescheduleAppointment", args, errorResult, "error");
    sendJson(response, 400, errorResult);
    return;
  }

  const existing = db.getAppointmentById(appointmentId);
  const rescheduled = calendar.rescheduleAppointment({
    appointment_id: appointmentId,
    new_window_start: newWindowStart,
    new_window_end: newWindowEnd,
    reason: asString(args.reason)
  });

  if (rescheduled.ok && existing) {
    sms.sendSms(
      {
        to: existing.phone,
        message: `Your plumbing appointment is now set for ${rescheduled.window_label}.`
      },
      sessionId
    );
  }

  logToolEvent(sessionId, "retell.rescheduleAppointment", args, rescheduled, rescheduled.ok ? "ok" : "error");
  sendJson(response, 200, rescheduled);
}

function handleWebhook(payload: JsonObject, requestRaw: string, response: http.ServerResponse): void {
  if (retellWebhookSecret) {
    const signature =
      asString((payload as JsonObject).signature) ??
      asString((payload as JsonObject).webhook_signature) ??
      asString((payload as JsonObject).signature_hash);
    if (signature && secureHash(requestRaw + retellWebhookSecret) !== signature) {
      console.warn("[WARN] Retell webhook signature check failed; accepting request but verify your dashboard signature settings.");
    }
  }

  const eventType = extractWebhookEventType(payload);
  const callId = extractCallId(payload);
  const callerPhone = extractCallerPhone(payload);
  const sessionId = getOrCreateSessionId(callId, callerPhone);

  if (sessionId) {
    db.logTurn(sessionId, "system", `Retell webhook event: ${eventType}`);
  }

  if (/call_ended|call_completed|call_finished|ended/i.test(eventType) && sessionId) {
    const outcome = asString((payload as JsonObject).disconnection_reason) ?? "RETELL_CALL_ENDED";
    db.endCallSession(sessionId, outcome);
    if (callId) {
      callSessionMap.delete(callId);
    }
  }

  sendJson(response, 200, { ok: true });
}

const server = http.createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "retell-bridge",
        retell_api_key_set: Boolean(retellApiKey),
        retell_agent_id_set: Boolean(retellAgentId),
        retell_webhook_secret_set: Boolean(retellWebhookSecret)
      });
      return;
    }

    if (method === "GET" && url.pathname === "/retell/webhook") {
      sendJson(response, 200, {
        ok: true,
        message: "Retell webhook endpoint reachable."
      });
      return;
    }

    if (method !== "POST") {
      notFound(response);
      return;
    }

    const body = await readJsonBody(request);
    const payload = asObject(body.payload);
    if (!payload) {
      sendJson(response, 400, {
        ok: false,
        error: "Invalid JSON payload"
      });
      return;
    }

    if (url.pathname === "/retell/tools/listAvailability") {
      handleListAvailability(payload, response);
      return;
    }

    if (url.pathname === "/retell/tools/createAppointment") {
      handleCreateAppointment(payload, response);
      return;
    }

    if (url.pathname === "/retell/tools/cancelAppointment") {
      handleCancelAppointment(payload, response);
      return;
    }

    if (url.pathname === "/retell/tools/rescheduleAppointment") {
      handleRescheduleAppointment(payload, response);
      return;
    }

    if (url.pathname === "/retell/webhook") {
      handleWebhook(payload, body.raw, response);
      return;
    }

    notFound(response);
  } catch (error) {
    console.error("[ERROR] Retell bridge request failed:", error);
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(retellPort, () => {
  console.log(`[SYSTEM] Retell bridge listening on http://localhost:${retellPort}`);
  console.log("[SYSTEM] Endpoints:");
  console.log("[SYSTEM]   GET  /health");
  console.log("[SYSTEM]   POST /retell/tools/listAvailability");
  console.log("[SYSTEM]   POST /retell/tools/createAppointment");
  console.log("[SYSTEM]   POST /retell/tools/cancelAppointment");
  console.log("[SYSTEM]   POST /retell/tools/rescheduleAppointment");
  console.log("[SYSTEM]   POST /retell/webhook");
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  db.close();
  server.close(() => process.exit(0));
});
