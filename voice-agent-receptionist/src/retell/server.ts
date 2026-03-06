import http from "node:http";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { loadRuntimeConfig } from "../sim/call_simulator";
import { CreateAppointmentArgs } from "../tools/calendar";
import { createMultiAgentCoordinator } from "../agents/manager/coordinator";
import { createMultiAgentRuntime } from "../agents/runtime";

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

const runtime = createMultiAgentRuntime({
  dbPath: runtimeConfig.dbPath,
  schemaPath: runtimeConfig.schemaPath,
  operatorEmail: runtimeConfig.operatorEmail,
  calendarConfig: {
    timezone: runtimeConfig.businessTimezone,
    workdayStartHour: runtimeConfig.workdayStartHour,
    workdayEndHour: runtimeConfig.workdayEndHour,
    saturdayStartHour: runtimeConfig.saturdayStartHour,
    saturdayEndHour: runtimeConfig.saturdayEndHour,
    slotDurationHours: runtimeConfig.slotDurationHours
  }
});
const db = runtime.db;
const coordinator = createMultiAgentCoordinator(runtime);
const callSessionMap = new Map<string, number>();
const timerStartedAtMsMap = new Map<string, number>();
const timerEndedMap = new Map<string, boolean>();
const timerLastSeenAtMsMap = new Map<string, number>();
const TIMER_IDLE_RESET_MS = 90_000;
const listAvailabilityPaths = new Set([
  "/retell/tools/listAvailability",
  "/retell/tools/list_availability",
  "/retell/tools/listavailability"
]);
const createAppointmentPaths = new Set([
  "/retell/tools/createAppointment",
  "/retell/tools/create_appointment",
  "/retell/tools/createappointment"
]);
const cancelAppointmentPaths = new Set([
  "/retell/tools/cancelAppointment",
  "/retell/tools/cancel_appointment",
  "/retell/tools/cancelappointment"
]);
const rescheduleAppointmentPaths = new Set([
  "/retell/tools/rescheduleAppointment",
  "/retell/tools/reschedule_appointment",
  "/retell/tools/rescheduleappointment"
]);
const getCallTimerPaths = new Set([
  "/retell/tools/getCallTimer",
  "/retell/tools/get_call_timer",
  "/retell/tools/getcalltimer"
]);

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
  timerStartedAtMsMap.set(callId, Date.now());
  timerEndedMap.set(callId, false);
  return sessionId;
}

function toSecondsFromSecondsField(value: number): number {
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function toSecondsFromMillisecondsField(value: number): number {
  if (value < 0) {
    return 0;
  }
  return Math.floor(value / 1000);
}

interface ExtractedElapsed {
  elapsedSeconds?: number;
  source?: string;
}

function extractElapsedSeconds(payload: JsonObject, args: JsonObject): ExtractedElapsed {
  const argsSeconds = asNumber(args.elapsed_seconds) ?? asNumber(args.elapsedSeconds);
  if (argsSeconds !== undefined) {
    return {
      elapsedSeconds: toSecondsFromSecondsField(argsSeconds),
      source: "args.seconds_field"
    };
  }

  const argsMs = asNumber(args.elapsed_ms) ?? asNumber(args.elapsedMs);
  if (argsMs !== undefined) {
    return {
      elapsedSeconds: toSecondsFromMillisecondsField(argsMs),
      source: "args.milliseconds_field"
    };
  }

  const payloadSeconds =
    asNumber(payload.elapsed_seconds) ??
    asNumber(payload.elapsedSeconds) ??
    asNumber(payload.call_elapsed_seconds) ??
    asNumber(payload.duration_seconds);
  if (payloadSeconds !== undefined) {
    return {
      elapsedSeconds: toSecondsFromSecondsField(payloadSeconds),
      source: "payload.seconds_field"
    };
  }

  const payloadMs =
    asNumber(payload.elapsed_ms) ??
    asNumber(payload.elapsedMs) ??
    asNumber(payload.call_duration_ms) ??
    asNumber(payload.duration_ms);
  if (payloadMs !== undefined) {
    return {
      elapsedSeconds: toSecondsFromMillisecondsField(payloadMs),
      source: "payload.milliseconds_field"
    };
  }

  const call = asObject(payload.call);
  if (call) {
    const nestedSeconds =
      asNumber(call.elapsed_seconds) ??
      asNumber(call.duration_seconds) ??
      asNumber(call.call_elapsed_seconds);
    if (nestedSeconds !== undefined) {
      return {
        elapsedSeconds: toSecondsFromSecondsField(nestedSeconds),
        source: "call.seconds_field"
      };
    }
    const nestedMs = asNumber(call.elapsed_ms) ?? asNumber(call.duration_ms) ?? asNumber(call.call_duration_ms);
    if (nestedMs !== undefined) {
      return {
        elapsedSeconds: toSecondsFromMillisecondsField(nestedMs),
        source: "call.milliseconds_field"
      };
    }
  }

  return {};
}

function resolveTimerKey(callId: string | undefined, payload: JsonObject, args: JsonObject): string {
  return (
    callId ??
    asString(args.timer_key) ??
    asString(args.session_key) ??
    asString(payload.conversation_id) ??
    asString(payload.session_id) ??
    asString(payload.test_job_id) ??
    "retell-default-timer"
  );
}

function getOrCreateCallStartMs(timerKey: string): number {
  const existing = timerStartedAtMsMap.get(timerKey);
  if (existing !== undefined) {
    return existing;
  }
  const now = Date.now();
  timerStartedAtMsMap.set(timerKey, now);
  return now;
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

  const result = coordinator.listAvailability({
    date_range_start: asString(args.date_range_start),
    date_range_end: asString(args.date_range_end),
    zip_or_area: asString(args.zip_or_area),
    urgency: asString(args.urgency)
  });

  logToolEvent(sessionId, "retell.listAvailability", args, result, result.ok ? "ok" : "error");
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

  const result = coordinator.createAppointment({
    sessionId,
    args: booking
  });

  logToolEvent(sessionId, "retell.createAppointment", args, result, result.ok ? "ok" : "error");
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

  const cancelled = coordinator.cancelAppointment({
    sessionId,
    args: {
      appointment_id: appointmentId,
      reason: asString(args.reason)
    }
  });

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

  const rescheduled = coordinator.rescheduleAppointment({
    sessionId,
    args: {
      appointment_id: appointmentId,
      new_window_start: newWindowStart,
      new_window_end: newWindowEnd,
      reason: asString(args.reason)
    }
  });

  logToolEvent(sessionId, "retell.rescheduleAppointment", args, rescheduled, rescheduled.ok ? "ok" : "error");
  sendJson(response, 200, rescheduled);
}

function handleGetCallTimer(payload: JsonObject, response: http.ServerResponse): void {
  const args = extractToolArgs(payload);
  const callId = extractCallId(payload);
  const sessionId = getOrCreateSessionId(callId, extractCallerPhone(payload));
  const timerKey = resolveTimerKey(callId, payload, args);
  const nowMs = Date.now();
  const lastSeenAtMs = timerLastSeenAtMsMap.get(timerKey);
  const hadPriorTimerState = timerStartedAtMsMap.has(timerKey);

  const checkpoint = asString(args.checkpoint)?.toLowerCase();
  const shouldResetByCheckpoint = checkpoint === "first_turn" || checkpoint === "call_start" || checkpoint === "reset";
  const autoResetAfterPriorEnd = Boolean(!shouldResetByCheckpoint && timerEndedMap.get(timerKey));
  const wrapAtSeconds = Math.max(30, Math.floor(runtimeConfig.voiceWrapupSeconds));
  const hardEndAtSeconds = Math.max(wrapAtSeconds + 15, Math.floor(runtimeConfig.voiceHardMaxSeconds));

  const extracted = extractElapsedSeconds(payload, args);
  const hasElapsedFromPayload = extracted.elapsedSeconds !== undefined && extracted.source !== "derived_from_call_start";
  const autoResetAfterInactivity = Boolean(
    !shouldResetByCheckpoint &&
      !hasElapsedFromPayload &&
      lastSeenAtMs !== undefined &&
      nowMs - lastSeenAtMs > TIMER_IDLE_RESET_MS
  );
  const timerResetApplied = shouldResetByCheckpoint || autoResetAfterPriorEnd || autoResetAfterInactivity;
  const staleFirstTimerReset =
    !timerResetApplied &&
    !hadPriorTimerState &&
    extracted.elapsedSeconds !== undefined &&
    extracted.elapsedSeconds >= hardEndAtSeconds;

  if (timerResetApplied || staleFirstTimerReset) {
    timerStartedAtMsMap.set(timerKey, nowMs);
    timerEndedMap.set(timerKey, false);
  }

  const elapsedSeconds = timerResetApplied
    ? 0
    : staleFirstTimerReset
      ? 0
    : extracted.elapsedSeconds !== undefined
      ? extracted.elapsedSeconds
      : Math.max(0, Math.floor((Date.now() - getOrCreateCallStartMs(timerKey)) / 1000));
  const timerSource = timerResetApplied
    ? autoResetAfterPriorEnd
      ? "auto_reset_after_prior_hard_end"
      : autoResetAfterInactivity
        ? "auto_reset_after_idle_gap"
      : "checkpoint_reset"
    : staleFirstTimerReset
      ? "auto_reset_stale_elapsed_on_first_invocation"
      : extracted.source ?? "derived_from_call_start";

  if (elapsedSeconds >= hardEndAtSeconds) {
    timerEndedMap.set(timerKey, true);
  }
  timerLastSeenAtMsMap.set(timerKey, nowMs);

  const result = {
    ok: true,
    elapsed_seconds: elapsedSeconds,
    should_wrap: elapsedSeconds >= wrapAtSeconds,
    should_end: elapsedSeconds >= hardEndAtSeconds,
    wrap_at_seconds: wrapAtSeconds,
    hard_end_at_seconds: hardEndAtSeconds,
    seconds_remaining: Math.max(0, hardEndAtSeconds - elapsedSeconds),
    checkpoint: checkpoint ?? null,
    timer_reset_applied: timerResetApplied,
    timer_source: timerSource,
    timer_key: timerKey
  };

  logToolEvent(sessionId, "retell.getCallTimer", args, result, "ok");
  sendJson(response, 200, result);
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
      timerStartedAtMsMap.delete(callId);
      timerEndedMap.delete(callId);
      timerLastSeenAtMsMap.delete(callId);
    }
  }

  sendJson(response, 200, { ok: true });
}

const server = http.createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "retell-bridge",
        retell_api_key_set: Boolean(retellApiKey),
        retell_agent_id_set: Boolean(retellAgentId),
        retell_webhook_secret_set: Boolean(retellWebhookSecret)
      });
      return;
    }

    if (method === "GET" && path === "/retell/webhook") {
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

    if (listAvailabilityPaths.has(path)) {
      handleListAvailability(payload, response);
      return;
    }

    if (createAppointmentPaths.has(path)) {
      handleCreateAppointment(payload, response);
      return;
    }

    if (cancelAppointmentPaths.has(path)) {
      handleCancelAppointment(payload, response);
      return;
    }

    if (rescheduleAppointmentPaths.has(path)) {
      handleRescheduleAppointment(payload, response);
      return;
    }

    if (getCallTimerPaths.has(path)) {
      handleGetCallTimer(payload, response);
      return;
    }

    if (path === "/retell/webhook") {
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
  console.log(`[SYSTEM] Multi-agent coordinator online: ${coordinator.getAgentRegistry().join(", ")}`);
  console.log("[SYSTEM] Endpoints:");
  console.log("[SYSTEM]   GET  /health");
  console.log("[SYSTEM]   POST /retell/tools/listAvailability");
  console.log("[SYSTEM]   POST /retell/tools/createAppointment");
  console.log("[SYSTEM]   POST /retell/tools/cancelAppointment");
  console.log("[SYSTEM]   POST /retell/tools/rescheduleAppointment");
  console.log("[SYSTEM]   POST /retell/tools/getCallTimer");
  console.log("[SYSTEM]   (snake_case + lowercase aliases also accepted for tool routes)");
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
