import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import OpenAI from "openai";
import { OpenAIRealtimeWebSocket } from "openai/beta/realtime/websocket";
import { RealtimeServerEvent } from "openai/resources/beta/realtime/realtime";
import { EMERGENCY_REPLY, buildSystemPrompt } from "./prompts";
import {
  AvailabilityWindow,
  CancelAppointmentArgs,
  CalendarConfig,
  CreateAppointmentArgs,
  ListAvailabilityArgs,
  LocalCalendarTool,
  RescheduleAppointmentArgs
} from "./tools/calendar";
import { AppointmentRecord, SqliteLogger } from "./tools/logging";
import { SimulatedSmsTool } from "./tools/sms";
import { QuoteService } from "./services/quote";
import { SafetyService } from "./services/safety";
import { PendingBooking, ReceptionWorkflowManager } from "./workflows/manager";

export interface AgentSessionConfig {
  openaiApiKey?: string;
  textModel: string;
  realtimeModel: string;
  realtimeVoice: string;
  voiceWrapupSeconds?: number;
  voiceHardMaxSeconds?: number;
  approvalMode: boolean;
  operatorEmail: string;
  dbPath: string;
  schemaPath: string;
  calendarConfig: CalendarConfig;
  forceLocalPlanner?: boolean;
}

export interface AgentTurnResult {
  reply: string;
  pendingApproval: boolean;
  callEnded: boolean;
}

export interface ApprovalResult {
  ok: boolean;
  message: string;
  appointmentId?: number;
  smsId?: number;
  quoteSmsId?: number;
}

export interface AppointmentCommandResult {
  ok: boolean;
  message: string;
  appointmentId?: number;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface VoiceIntakeSnapshot {
  name?: string;
  address?: string;
  phone?: string;
  issue?: string;
  urgency?: string;
}

function detectIssue(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes("burst")) return "burst_pipe";
  if (normalized.includes("clog") || normalized.includes("drain")) return "clog";
  if (normalized.includes("hot water") || normalized.includes("water heater")) return "no_hot_water";
  if (normalized.includes("leak")) return "leak";
  if (/(pipe|plumbing|toilet|faucet)/i.test(text)) return "other";
  return undefined;
}

function detectUrgency(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes("sewage")) return "sewage_backup";
  if (normalized.includes("flood")) return "flooding";
  if (normalized.includes("no water")) return "no_water";
  if (normalized.includes("active leak") || normalized.includes("leaking now")) return "active_leak";
  if (normalized.includes("urgent") || normalized.includes("asap") || normalized.includes("today")) return "urgent";
  if (normalized.includes("routine") || normalized.includes("not urgent") || normalized.includes("whenever")) return "routine";
  return undefined;
}

function extractPhone(text: string): string | undefined {
  const match = text.match(/(\+?1[\s.-]?)?\(?([0-9]{3})\)?[\s.-]?([0-9]{3})[\s.-]?([0-9]{4})/);
  if (!match) {
    return undefined;
  }
  return `${match[2]}-${match[3]}-${match[4]}`;
}

function extractName(text: string): string | undefined {
  const phrase = text.match(/(?:my name is|this is|i am)\s+([A-Za-z][A-Za-z' -]{1,60})/i);
  if (phrase) {
    return cleanText(phrase[1]);
  }
  return undefined;
}

function extractAddress(text: string): string | undefined {
  const normalized = cleanText(text);

  const streetSegment =
    /\b\d+\s+[A-Za-z0-9][A-Za-z0-9 .,'-]*?\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|place|pl)\b(?:\s+[A-Za-z.'-]+){0,4}(?:\s+[A-Z]{2})?(?:\s+\d{5})?(?=(?:\s*(?:,|\.|;|$|callback\b|phone\b|call back\b|my number\b)))/i;

  const addressCue = normalized.match(/(?:address(?:\s+is)?[:\s-]+)(.+)$/i);
  if (addressCue?.[1]) {
    const scoped = cleanText(addressCue[1]);
    const scopedMatch = scoped.match(streetSegment);
    if (scopedMatch?.[0]) {
      return cleanText(scopedMatch[0].replace(/[.,;:]\s*$/, ""));
    }
  }

  const directMatch = normalized.match(streetSegment);
  if (directMatch?.[0]) {
    return cleanText(directMatch[0].replace(/[.,;:]\s*$/, ""));
  }

  return undefined;
}

export class AgentSession {
  private readonly openai?: OpenAI;
  private readonly db: SqliteLogger;
  private readonly calendar: LocalCalendarTool;
  private readonly sms: SimulatedSmsTool;
  private readonly systemPrompt: string;
  private readonly safetyService: SafetyService;
  private readonly quoteService: QuoteService;
  private readonly workflowManager: ReceptionWorkflowManager;

  private sessionId: number | null = null;
  private previousResponseId: string | undefined;
  private pendingBooking: PendingBooking | null = null;
  private safetyEscalated = false;
  private outcome = "IN_PROGRESS";
  private readonly voiceIntake: VoiceIntakeSnapshot = {};
  private timeoutFollowUpTaskCreated = false;

  constructor(private readonly config: AgentSessionConfig) {
    this.db = new SqliteLogger(config.dbPath, config.schemaPath);
    this.calendar = new LocalCalendarTool(this.db, config.calendarConfig);
    this.sms = new SimulatedSmsTool(this.db);
    this.safetyService = new SafetyService();
    this.quoteService = new QuoteService();
    this.workflowManager = new ReceptionWorkflowManager(this.calendar, this.safetyService, {
      approvalMode: config.approvalMode,
      emergencyReply: EMERGENCY_REPLY
    });

    this.systemPrompt = buildSystemPrompt({
      approvalMode: config.approvalMode,
      operatorEmail: config.operatorEmail
    });

    if (config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  startSession(mode: "text" | "voice" = "text", callerPhone?: string): void {
    this.sessionId = this.db.createCallSession({
      mode,
      callerPhone,
      approvalMode: this.config.approvalMode
    });

    this.db.logTurn(this.sessionId, "system", `Session started in ${mode} mode.`);
  }

  getPendingBooking(): PendingBooking | null {
    return this.pendingBooking;
  }

  listAppointments(): AppointmentRecord[] {
    return this.db.listAppointments();
  }

  listRescheduleOptions(appointmentId: number):
    | { ok: true; windows: AvailabilityWindow[]; message: string }
    | { ok: false; message: string } {
    const existing = this.db.getAppointmentById(appointmentId);
    if (!existing || existing.status !== "BOOKED") {
      return {
        ok: false,
        message: `No active booked appointment found for id ${appointmentId}.`
      };
    }

    const availability = this.calendar.listAvailability({ urgency: existing.urgency });
    if (!availability.ok || availability.windows.length === 0) {
      return {
        ok: false,
        message: "No reschedule windows available right now."
      };
    }

    const windows = availability.windows.slice(0, 3);
    return {
      ok: true,
      windows,
      message: "Reschedule windows ready."
    };
  }

  cancelAppointmentById(appointmentId: number, reason = "Cancelled by operator"): AppointmentCommandResult {
    this.ensureStarted();

    const existing = this.db.getAppointmentById(appointmentId);
    if (!existing || existing.status !== "BOOKED") {
      return {
        ok: false,
        message: `No active booked appointment found for id ${appointmentId}.`
      };
    }

    const cancelled = this.calendar.cancelAppointment({ appointment_id: appointmentId, reason });
    if (!cancelled.ok) {
      return {
        ok: false,
        message: cancelled.message
      };
    }

    this.sms.sendSms(
      {
        to: existing.phone,
        message: `Your plumbing appointment scheduled for ${this.calendar.formatWindowLabel(existing.window_start, existing.window_end)} has been cancelled. Reply anytime to schedule a new window.`
      },
      this.sessionId!
    );

    this.db.logToolEvent({
      sessionId: this.sessionId!,
      toolName: "cancelAppointment",
      argumentsJson: JSON.stringify({ appointment_id: appointmentId, reason }),
      resultJson: JSON.stringify(cancelled),
      status: "ok"
    });

    return {
      ok: true,
      message: `Appointment ${appointmentId} cancelled and SMS sent.`,
      appointmentId
    };
  }

  rescheduleAppointmentById(
    appointmentId: number,
    newWindowStart: string,
    newWindowEnd: string,
    reason = "Rescheduled by operator"
  ): AppointmentCommandResult {
    this.ensureStarted();

    const existing = this.db.getAppointmentById(appointmentId);
    if (!existing || existing.status !== "BOOKED") {
      return {
        ok: false,
        message: `No active booked appointment found for id ${appointmentId}.`
      };
    }

    const updated = this.calendar.rescheduleAppointment({
      appointment_id: appointmentId,
      new_window_start: newWindowStart,
      new_window_end: newWindowEnd,
      reason
    });

    if (!updated.ok) {
      return {
        ok: false,
        message: updated.message
      };
    }

    this.sms.sendSms(
      {
        to: existing.phone,
        message: `Your appointment has been moved to ${updated.window_label}. Reply RESCHEDULE if you need another time.`
      },
      this.sessionId!
    );

    this.db.logToolEvent({
      sessionId: this.sessionId!,
      toolName: "rescheduleAppointment",
      argumentsJson: JSON.stringify({
        appointment_id: appointmentId,
        new_window_start: newWindowStart,
        new_window_end: newWindowEnd,
        reason
      }),
      resultJson: JSON.stringify(updated),
      status: "ok"
    });

    return {
      ok: true,
      message: `Appointment ${appointmentId} rescheduled to ${updated.window_label}.`,
      appointmentId
    };
  }

  async handleTextTurn(callerText: string): Promise<AgentTurnResult> {
    this.ensureStarted();

    const normalized = cleanText(callerText);
    this.db.logTurn(this.sessionId!, "caller", normalized);

    const safety = this.safetyService.assess(normalized);
    if (safety.isDanger) {
      this.safetyEscalated = true;
      this.outcome = "SAFETY_ESCALATED";

      this.db.logToolEvent({
        sessionId: this.sessionId!,
        toolName: "logEvent",
        argumentsJson: JSON.stringify({
          level: "warn",
          event_type: "safety_risk_detected",
          reason: safety.reason,
          message: normalized
        }),
        resultJson: JSON.stringify({ ok: true }),
        status: "ok"
      });

      this.db.logTurn(this.sessionId!, "agent", EMERGENCY_REPLY);
      return {
        reply: EMERGENCY_REPLY,
        pendingApproval: Boolean(this.pendingBooking),
        callEnded: false
      };
    }

    let reply: string;

    if (!this.openai || this.config.forceLocalPlanner) {
      const result = this.workflowManager.processCallerText(normalized);
      reply = result.reply;

      if (result.pendingBooking) {
        this.pendingBooking = result.pendingBooking;
      }

      if (result.outcome) {
        this.outcome = result.outcome;
      }

      if (result.bookedAppointment) {
        this.sendPostBookingMessages(result.bookedAppointment.booking, result.bookedAppointment.windowLabel);
      }
    } else {
      reply = await this.handleOpenAITurn(normalized);
    }

    this.db.logTurn(this.sessionId!, "agent", reply);

    return {
      reply,
      pendingApproval: Boolean(this.pendingBooking),
      callEnded: this.outcome !== "IN_PROGRESS"
    };
  }

  async approvePendingBooking(): Promise<ApprovalResult> {
    this.ensureStarted();

    if (!this.pendingBooking) {
      return {
        ok: false,
        message: "No pending booking to approve."
      };
    }

    const pending = this.pendingBooking;
    const result = this.calendar.createAppointment(pending);

    if (!result.ok) {
      const message = `Approval failed: ${result.message}`;
      this.db.logToolEvent({
        sessionId: this.sessionId!,
        toolName: "createAppointment",
        argumentsJson: JSON.stringify(pending),
        resultJson: JSON.stringify(result),
        status: "error"
      });

      this.pendingBooking = null;
      return {
        ok: false,
        message
      };
    }

    const smsResult = this.sendPostBookingMessages(pending, result.window_label);

    this.pendingBooking = null;
    this.outcome = "BOOKED";

    const agentMessage = `Perfect. You are booked for ${result.window_label}. I sent confirmation and quote text messages to ${pending.phone}.`;
    this.db.logTurn(this.sessionId!, "agent", agentMessage);

    return {
      ok: true,
      message: agentMessage,
      appointmentId: result.appointment_id,
      smsId: smsResult.confirmationSmsId,
      quoteSmsId: smsResult.quoteSmsId
    };
  }

  async rejectPendingBooking(reason = "Operator rejected booking"): Promise<ApprovalResult> {
    this.ensureStarted();

    if (!this.pendingBooking) {
      return {
        ok: false,
        message: "No pending booking to reject."
      };
    }

    this.db.logToolEvent({
      sessionId: this.sessionId!,
      toolName: "approval.reject",
      argumentsJson: JSON.stringify({ reason }),
      resultJson: JSON.stringify({ ok: true }),
      status: "ok"
    });

    this.pendingBooking = null;

    const message = "Understood. Booking was not submitted. I can offer different windows if needed.";
    this.db.logTurn(this.sessionId!, "agent", message);

    return {
      ok: true,
      message
    };
  }

  async startVoiceLoop(): Promise<void> {
    this.ensureStarted();

    if (!this.openai) {
      throw new Error("OPENAI_API_KEY is required for voice mode.");
    }

    const soxCheck = spawnSync("sox", ["--version"], { stdio: "ignore" });
    if (soxCheck.status !== 0) {
      throw new Error("SoX is required for mic/speaker mode. Install on macOS with: brew install sox");
    }

    const configuredWrapupSeconds = Math.max(30, Math.floor(this.config.voiceWrapupSeconds ?? 212));
    const configuredHardMaxSeconds = Math.max(configuredWrapupSeconds + 15, Math.floor(this.config.voiceHardMaxSeconds ?? 288));
    const formatSeconds = (totalSeconds: number): string => {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${String(seconds).padStart(2, "0")}`;
    };

    console.log(
      `[SYSTEM] Voice mode started. Speak naturally. Type 'approve', 'reject', 'respond', or 'exit' when needed. Wrap-up at ${formatSeconds(configuredWrapupSeconds)}, hard stop at ${formatSeconds(configuredHardMaxSeconds)}.`
    );

    const rt = new OpenAIRealtimeWebSocket(
      {
        model: this.config.realtimeModel
      },
      this.openai
    );
    let realtimeReadyForAudio = false;
    let introSent = false;
    let lastAgentSpokenLine = "";
    let wrapupTriggered = false;
    let hardStopTriggered = false;
    let shuttingDown = false;
    let wrapupTimer: ReturnType<typeof setTimeout> | null = null;
    let hardStopTimer: ReturnType<typeof setTimeout> | null = null;
    let commandLine: readline.Interface | null = null;

    const playback = spawn("sox", ["-q", "-t", "raw", "-r", "24000", "-c", "1", "-b", "16", "-e", "signed-integer", "-", "-d"], {
      stdio: ["pipe", "ignore", "pipe"]
    });

    const recorder = spawn("sox", ["-q", "-d", "-r", "24000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    recorder.stdout.on("data", (chunk: Buffer) => {
      if (!realtimeReadyForAudio) {
        return;
      }

      rt.send({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      });
    });

    recorder.stderr.on("data", (chunk: Buffer) => {
      const text = cleanText(chunk.toString("utf8"));
      if (text) {
        console.error(`[ERROR] Mic capture: ${text}`);
      }
    });

    playback.stderr.on("data", (chunk: Buffer) => {
      const text = cleanText(chunk.toString("utf8"));
      if (text) {
        console.error(`[ERROR] Speaker playback: ${text}`);
      }
    });

    recorder.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[ERROR] Microphone process exited with code ${code}. Check macOS microphone permissions for your terminal.`);
      }
    });

    const clearVoiceTimers = (): void => {
      if (wrapupTimer) {
        clearTimeout(wrapupTimer);
        wrapupTimer = null;
      }
      if (hardStopTimer) {
        clearTimeout(hardStopTimer);
        hardStopTimer = null;
      }
    };

    const sendVoiceInstruction = (instruction: string): void => {
      if (!realtimeReadyForAudio || shuttingDown) {
        return;
      }

      try {
        rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: instruction }]
          }
        } as any);
        rt.send({ type: "response.create" });
      } catch (error) {
        console.error("[ERROR] Could not send voice instruction:", error);
      }
    };

    const closeVoiceLoop = (reason: string): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      realtimeReadyForAudio = false;
      clearVoiceTimers();

      recorder.kill("SIGTERM");
      playback.kill("SIGTERM");
      rt.close();

      if (commandLine) {
        commandLine.close();
      }

      this.db.logTurn(this.sessionId!, "system", `Voice loop closed: ${reason}`);
    };

    const triggerWrapup = (): void => {
      if (wrapupTriggered || shuttingDown || this.outcome === "BOOKED" || this.safetyEscalated) {
        return;
      }

      wrapupTriggered = true;
      console.log(`[SYSTEM] Wrap-up timer reached (${formatSeconds(configuredWrapupSeconds)}). Prioritizing issue + scheduling.`);
      this.db.logTurn(this.sessionId!, "system", "Voice wrap-up timer reached.");

      sendVoiceInstruction(
        "You have a meeting starting soon. Politely wrap up now. Prioritize identifying issue type and locking an appointment. Ask only for missing critical fields: name, full street address, callback number, and issue."
      );
    };

    const triggerHardStop = (): void => {
      if (hardStopTriggered || shuttingDown) {
        return;
      }
      hardStopTriggered = true;

      if (this.outcome !== "BOOKED" && !this.safetyEscalated) {
        const missing = this.getMissingVoiceFields();
        const note =
          missing.length > 0
            ? `Hard call timeout reached. Callback needed to collect remaining details: ${missing.join(", ")}.`
            : "Hard call timeout reached before booking completion. Callback needed to finish scheduling.";

        this.createTimeoutFollowUpTask(note);

        sendVoiceInstruction(
          "You must end the call now. In one short sentence, say you have a meeting starting and the office manager will call back shortly to collect any remaining details and complete scheduling."
        );
      }

      console.log(`[SYSTEM] Hard call limit reached (${formatSeconds(configuredHardMaxSeconds)}). Ending call.`);
      this.db.logTurn(this.sessionId!, "system", "Voice hard timeout reached.");
      setTimeout(() => closeVoiceLoop("hard_timeout"), 3000);
    };

    wrapupTimer = setTimeout(triggerWrapup, configuredWrapupSeconds * 1000);
    hardStopTimer = setTimeout(triggerHardStop, configuredHardMaxSeconds * 1000);

    rt.on("session.created", () => {
      console.log("[SYSTEM] Realtime connected.");
      rt.send({
        type: "session.update",
        session: {
          instructions: this.systemPrompt,
          modalities: ["audio", "text"],
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          voice: this.config.realtimeVoice as any,
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe"
          },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true
          },
          tool_choice: "auto",
          tools: this.getToolSchemas()
        }
      } as any);
    });

    rt.on("session.updated", () => {
      if (!realtimeReadyForAudio) {
        realtimeReadyForAudio = true;
        console.log("[SYSTEM] Realtime session ready. Start speaking now.");
      }

      if (!introSent) {
        introSent = true;
        rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Start this call now. Give a short friendly greeting and ask for caller name, full address, and callback number."
              }
            ]
          }
        } as any);
        rt.send({ type: "response.create" });
      }
    });

    rt.on("input_audio_buffer.speech_started", () => {
      console.log("[SYSTEM] Heard speech...");
    });

    rt.on("input_audio_buffer.speech_stopped", () => {
      console.log("[SYSTEM] Processing speech...");
    });

    rt.on("conversation.item.input_audio_transcription.completed", (event: any) => {
      const transcript = cleanText(event.transcript ?? "");
      if (!transcript) {
        return;
      }

      console.log(`[CALLER] ${transcript}`);
      this.db.logTurn(this.sessionId!, "caller", transcript);
      this.updateVoiceIntake(transcript);

      if (this.safetyService.assess(transcript).isDanger) {
        this.safetyEscalated = true;
        this.outcome = "SAFETY_ESCALATED";
      }
    });

    rt.on("response.audio.delta", (event: any) => {
      const audio = Buffer.from(event.delta, "base64");
      if (playback.stdin.writable) {
        playback.stdin.write(audio);
      }
    });

    rt.on("response.audio_transcript.done", (event: any) => {
      const transcript = cleanText(event.transcript ?? "");
      if (!transcript) {
        return;
      }

      lastAgentSpokenLine = transcript;
      console.log(`[AGENT] ${transcript}`);
      this.db.logTurn(this.sessionId!, "agent", transcript);
    });

    rt.on("response.text.done", (event: any) => {
      const text = cleanText(event.text ?? "");
      if (!text || text === lastAgentSpokenLine) {
        return;
      }

      console.log(`[AGENT] ${text}`);
      this.db.logTurn(this.sessionId!, "agent", text);
      lastAgentSpokenLine = text;
    });

    rt.on("response.output_item.done", async (event: any) => {
      try {
        const item = event.item;
        if (!item || item.type !== "function_call" || !item.name || !item.call_id) {
          return;
        }

        const result = await this.executeTool(item.name, item.arguments ?? "{}", item.call_id);

        rt.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: item.call_id,
            output: JSON.stringify(result)
          }
        } as any);

        rt.send({ type: "response.create" });
      } catch (error) {
        console.error("[ERROR] Tool execution in voice mode failed:", error);
      }
    });

    rt.on("error", (event: Error | RealtimeServerEvent) => {
      console.error("[ERROR] Realtime connection error:", event);
    });

    rt.on("response.done", (event: any) => {
      const status = event?.response?.status;
      if (status === "failed" || status === "incomplete" || status === "cancelled") {
        console.error("[ERROR] Realtime response ended with status:", status, event?.response?.status_details ?? "");
      }
    });

    commandLine = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    commandLine.on("line", async (line) => {
      const value = cleanText(line).toLowerCase();

      if (value === "approve") {
        const result = await this.approvePendingBooking();
        console.log(`[SYSTEM] ${result.message}`);

        rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Operator approved the booking. Confirm to caller and close politely." }]
          }
        } as any);
        rt.send({ type: "response.create" });
      } else if (value === "reject") {
        const result = await this.rejectPendingBooking("Rejected by operator in voice mode.");
        console.log(`[SYSTEM] ${result.message}`);

        rt.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Operator rejected booking. Offer alternate times." }]
          }
        } as any);
        rt.send({ type: "response.create" });
      } else if (value === "respond") {
        rt.send({ type: "input_audio_buffer.commit" } as any);
        rt.send({ type: "response.create" });
        console.log("[SYSTEM] Forced response requested.");
      } else if (value === "exit") {
        closeVoiceLoop("operator_exit");
      }
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearVoiceTimers();
          resolve();
        }
      };
      playback.on("exit", done);
      recorder.on("exit", done);
    });
  }

  endSession(): void {
    if (this.sessionId !== null) {
      this.db.endCallSession(this.sessionId, this.outcome);
    }
    this.db.close();
  }

  private sendPostBookingMessages(booking: PendingBooking, windowLabel: string): { confirmationSmsId: number; quoteSmsId: number } {
    const confirmation = this.sms.sendSms(
      {
        to: booking.phone,
        message: `Confirmed: Plumbing appointment scheduled for ${windowLabel}. Reply RESCHEDULE if you need to change it.`
      },
      this.sessionId!
    );

    const quote = this.quoteService.createQuote(booking.issue, booking.urgency);
    const quoteMessage = this.quoteService.buildQuoteSms(booking.name, quote);

    const quoteSms = this.sms.sendSms(
      {
        to: booking.phone,
        message: quoteMessage
      },
      this.sessionId!
    );

    this.db.logToolEvent({
      sessionId: this.sessionId!,
      toolName: "quote.create",
      argumentsJson: JSON.stringify({ issue: booking.issue, urgency: booking.urgency }),
      resultJson: JSON.stringify(quote),
      status: "ok"
    });

    return {
      confirmationSmsId: confirmation.sms_id,
      quoteSmsId: quoteSms.sms_id
    };
  }

  private async handleOpenAITurn(callerText: string): Promise<string> {
    const response = await this.createResponse({
      role: "user",
      content: [{ type: "input_text", text: callerText }]
    });

    return response;
  }

  private async createResponse(input: any): Promise<string> {
    if (!this.openai) {
      return "I could not process that just now.";
    }

    let response = await this.openai.responses.create({
      model: this.config.textModel,
      instructions: this.systemPrompt,
      input,
      tools: this.getToolSchemas(),
      ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {})
    } as any);

    this.previousResponseId = response.id;

    while (true) {
      const outputItems = (response as any).output ?? [];
      const functionCalls = outputItems.filter((item: any) => item.type === "function_call");

      if (functionCalls.length === 0) {
        break;
      }

      const toolOutputs: Array<{ type: string; call_id: string; output: string }> = [];

      for (const call of functionCalls) {
        const result = await this.executeTool(call.name, call.arguments ?? "{}", call.call_id);
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      response = await this.openai.responses.create({
        model: this.config.textModel,
        input: toolOutputs,
        tools: this.getToolSchemas(),
        previous_response_id: response.id
      } as any);

      this.previousResponseId = response.id;
    }

    const text = (response as any).output_text as string | undefined;
    if (text && text.trim()) {
      return text.trim();
    }

    const fallback = this.extractTextFromOutput((response as any).output ?? []);
    return fallback || "I can help with that. Could you repeat that briefly?";
  }

  private extractTextFromOutput(outputItems: any[]): string {
    const textParts: string[] = [];
    for (const item of outputItems) {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (content.type === "output_text" && content.text) {
          textParts.push(String(content.text));
        }
      }
    }
    return textParts.join(" ").trim();
  }

  private async executeTool(name: string, rawArgs: string, _callId: string): Promise<unknown> {
    this.ensureStarted();

    const parsedArgs = (() => {
      try {
        return JSON.parse(rawArgs || "{}");
      } catch {
        return {};
      }
    })();

    try {
      let result: unknown;

      if (name === "listAvailability") {
        result = this.calendar.listAvailability(parsedArgs as ListAvailabilityArgs);
      } else if (name === "createAppointment") {
        result = await this.createAppointmentTool(parsedArgs as CreateAppointmentArgs);
      } else if (name === "cancelAppointment") {
        result = this.calendar.cancelAppointment(parsedArgs as CancelAppointmentArgs);
      } else if (name === "rescheduleAppointment") {
        result = this.calendar.rescheduleAppointment(parsedArgs as RescheduleAppointmentArgs);
      } else if (name === "sendSms") {
        result = this.sms.sendSms(parsedArgs, this.sessionId!);
      } else if (name === "logEvent") {
        result = { ok: true, logged: true };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      this.db.logToolEvent({
        sessionId: this.sessionId!,
        toolName: name,
        argumentsJson: JSON.stringify(parsedArgs),
        resultJson: JSON.stringify(result),
        status: "ok"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool error";
      const result = { ok: false, error: message };

      this.db.logToolEvent({
        sessionId: this.sessionId!,
        toolName: name,
        argumentsJson: JSON.stringify(parsedArgs),
        resultJson: JSON.stringify(result),
        status: "error"
      });

      return result;
    }
  }

  private async createAppointmentTool(args: CreateAppointmentArgs): Promise<unknown> {
    this.voiceIntake.name = this.voiceIntake.name ?? args.name;
    this.voiceIntake.phone = this.voiceIntake.phone ?? args.phone;
    this.voiceIntake.address = this.voiceIntake.address ?? args.address;
    this.voiceIntake.issue = this.voiceIntake.issue ?? args.issue;
    this.voiceIntake.urgency = this.voiceIntake.urgency ?? args.urgency;

    if (this.safetyEscalated) {
      return {
        ok: false,
        error_code: "SAFETY_BLOCK",
        message: "Cannot schedule because safety escalation is active."
      };
    }

    const booking: PendingBooking = {
      name: args.name,
      phone: args.phone,
      address: args.address,
      issue: args.issue,
      urgency: args.urgency,
      window_start: args.window_start,
      window_end: args.window_end,
      notes: args.notes ?? ""
    };

    if (this.config.approvalMode) {
      this.pendingBooking = booking;
      return {
        ok: false,
        status: "PENDING_APPROVAL",
        message: "Operator approval required. Ask operator to type approve in CLI.",
        proposed_booking: booking
      };
    }

    const result = this.calendar.createAppointment(args);
    if (result.ok) {
      this.outcome = "BOOKED";
      const quote = this.quoteService.createQuote(args.issue, args.urgency);
      return {
        ...result,
        quote_preview: quote,
        next_step: "Call sendSms for confirmation and send quote follow-up."
      };
    }

    return result;
  }

  private getToolSchemas(): unknown[] {
    return [
      {
        type: "function",
        name: "listAvailability",
        description: "List available appointment windows from local business calendar.",
        parameters: {
          type: "object",
          properties: {
            date_range_start: { type: "string", description: "ISO date/time start." },
            date_range_end: { type: "string", description: "ISO date/time end." },
            zip_or_area: { type: "string", description: "ZIP code or neighborhood." },
            urgency: { type: "string", description: "Urgency text from caller." }
          }
        }
      },
      {
        type: "function",
        name: "createAppointment",
        description: "Create a booked appointment window. May require operator approval.",
        parameters: {
          type: "object",
          required: ["name", "phone", "address", "issue", "urgency", "window_start", "window_end"],
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            address: { type: "string" },
            issue: { type: "string" },
            urgency: { type: "string" },
            window_start: { type: "string" },
            window_end: { type: "string" },
            notes: { type: "string" }
          }
        }
      },
      {
        type: "function",
        name: "cancelAppointment",
        description: "Cancel an existing appointment by appointment ID.",
        parameters: {
          type: "object",
          required: ["appointment_id"],
          properties: {
            appointment_id: { type: "number" },
            reason: { type: "string" }
          }
        }
      },
      {
        type: "function",
        name: "rescheduleAppointment",
        description: "Reschedule an appointment to a new time window.",
        parameters: {
          type: "object",
          required: ["appointment_id", "new_window_start", "new_window_end"],
          properties: {
            appointment_id: { type: "number" },
            new_window_start: { type: "string" },
            new_window_end: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      {
        type: "function",
        name: "sendSms",
        description: "Send a simulated SMS confirmation message and store it in SQLite.",
        parameters: {
          type: "object",
          required: ["to", "message"],
          properties: {
            to: { type: "string" },
            message: { type: "string" }
          }
        }
      },
      {
        type: "function",
        name: "logEvent",
        description: "Write an event to the internal tool log for auditing.",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["info", "warn", "error"] },
            event_type: { type: "string" },
            message: { type: "string" },
            metadata_json: { type: "string" }
          }
        }
      }
    ];
  }

  private updateVoiceIntake(callerText: string): void {
    this.voiceIntake.name = this.voiceIntake.name ?? extractName(callerText);
    this.voiceIntake.address = this.voiceIntake.address ?? extractAddress(callerText);
    this.voiceIntake.phone = this.voiceIntake.phone ?? extractPhone(callerText);
    this.voiceIntake.issue = this.voiceIntake.issue ?? detectIssue(callerText);
    this.voiceIntake.urgency = this.voiceIntake.urgency ?? detectUrgency(callerText);
  }

  private getMissingVoiceFields(): string[] {
    const missing: string[] = [];
    if (!this.voiceIntake.name) missing.push("name");
    if (!this.voiceIntake.address) missing.push("full street address");
    if (!this.voiceIntake.phone) missing.push("callback number");
    if (!this.voiceIntake.issue) missing.push("issue type");
    return missing;
  }

  private createTimeoutFollowUpTask(note: string): void {
    if (this.timeoutFollowUpTaskCreated) {
      return;
    }

    const taskId = this.db.createFollowUpTask({
      sessionId: this.sessionId ?? undefined,
      taskType: "CALLBACK_INCOMPLETE_INTAKE",
      status: "OPEN",
      assignee: this.config.operatorEmail,
      callbackPhone: this.voiceIntake.phone,
      note,
      detailsJson: JSON.stringify({
        missing_fields: this.getMissingVoiceFields(),
        intake: this.voiceIntake,
        pending_booking: this.pendingBooking,
        outcome: this.outcome
      }),
      dueAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

    this.timeoutFollowUpTaskCreated = true;

    this.db.logToolEvent({
      sessionId: this.sessionId ?? undefined,
      toolName: "createFollowUpTask",
      argumentsJson: JSON.stringify({
        reason: "voice_hard_timeout",
        note
      }),
      resultJson: JSON.stringify({
        ok: true,
        follow_up_task_id: taskId
      }),
      status: "ok"
    });
  }

  private ensureStarted(): void {
    if (this.sessionId === null) {
      throw new Error("Session not started. Call startSession() first.");
    }
  }
}

export function createAgentSession(config: AgentSessionConfig): AgentSession {
  return new AgentSession(config);
}
