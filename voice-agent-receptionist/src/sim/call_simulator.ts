import dotenv from "dotenv";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentSession, createAgentSession } from "../agent";
import { AvailabilityWindow } from "../tools/calendar";

export type SimulatorMode = "text" | "voice";

export interface RuntimeConfig {
  openaiApiKey?: string;
  textModel: string;
  realtimeModel: string;
  realtimeVoice: string;
  approvalMode: boolean;
  businessTimezone: string;
  workdayStartHour: number;
  workdayEndHour: number;
  saturdayStartHour: number;
  saturdayEndHour: number;
  slotDurationHours: number;
  dbPath: string;
  operatorEmail: string;
  voiceWrapupSeconds: number;
  voiceHardMaxSeconds: number;
  schemaPath: string;
  forceLocalPlanner?: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return /^(true|1|yes)$/i.test(value.trim());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  dotenv.config();

  const baseDir = process.cwd();

  return {
    openaiApiKey: process.env.OPENAI_API_KEY,
    textModel: process.env.OPENAI_TEXT_MODEL || "gpt-5-mini",
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini",
    realtimeVoice: process.env.OPENAI_REALTIME_VOICE || "alloy",
    approvalMode: parseBoolean(process.env.APPROVAL_MODE, true),
    businessTimezone: process.env.BUSINESS_TIMEZONE || "America/New_York",
    workdayStartHour: parseNumber(process.env.WORKDAY_START_HOUR, 8),
    workdayEndHour: parseNumber(process.env.WORKDAY_END_HOUR, 18),
    saturdayStartHour: parseNumber(process.env.SATURDAY_START_HOUR, 9),
    saturdayEndHour: parseNumber(process.env.SATURDAY_END_HOUR, 14),
    slotDurationHours: parseNumber(process.env.SLOT_DURATION_HOURS, 2),
    dbPath: process.env.DB_PATH || "./data/receptionist.sqlite",
    operatorEmail: process.env.OPERATOR_EMAIL || "billsplumbingny@gmail.com",
    voiceWrapupSeconds: parseNumber(process.env.VOICE_WRAPUP_SECONDS, 212),
    voiceHardMaxSeconds: parseNumber(process.env.VOICE_HARD_MAX_SECONDS, 288),
    schemaPath: path.join(baseDir, "src/db/schema.sql"),
    ...overrides
  };
}

function parseModeFromArgs(argv: string[]): SimulatorMode {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  if (!modeArg) {
    return "text";
  }

  const value = modeArg.split("=")[1]?.trim();
  return value === "voice" ? "voice" : "text";
}

function printOperatorHelp(): void {
  console.log("[SYSTEM] Operator commands:");
  console.log("[SYSTEM] /help");
  console.log("[SYSTEM] /appointments");
  console.log("[SYSTEM] /cancel <appointment_id>");
  console.log("[SYSTEM] /rebook <appointment_id>");
  console.log("[SYSTEM] /rebook <appointment_id> <option_number>");
  console.log("[SYSTEM] exit");
}

function printAppointments(session: AgentSession): void {
  const appointments = session.listAppointments();
  if (appointments.length === 0) {
    console.log("[SYSTEM] No appointments in database.");
    return;
  }

  for (const appointment of appointments) {
    console.log(
      `[SYSTEM] id=${appointment.id} status=${appointment.status} name=${appointment.name} phone=${appointment.phone} window=${appointment.window_start} -> ${appointment.window_end}`
    );
  }
}

async function handleOperatorCommand(
  command: string,
  session: AgentSession,
  rebookOptions: Map<number, AvailabilityWindow[]>
): Promise<boolean> {
  const trimmed = command.trim();

  if (trimmed === "/help") {
    printOperatorHelp();
    return true;
  }

  if (trimmed === "/appointments") {
    printAppointments(session);
    return true;
  }

  const cancelMatch = trimmed.match(/^\/cancel\s+(\d+)$/);
  if (cancelMatch) {
    const appointmentId = Number(cancelMatch[1]);
    const result = session.cancelAppointmentById(appointmentId);
    console.log(`[SYSTEM] ${result.message}`);
    return true;
  }

  const rebookOptionsMatch = trimmed.match(/^\/rebook\s+(\d+)$/);
  if (rebookOptionsMatch) {
    const appointmentId = Number(rebookOptionsMatch[1]);
    const options = session.listRescheduleOptions(appointmentId);

    if (!options.ok) {
      console.log(`[SYSTEM] ${options.message}`);
      return true;
    }

    rebookOptions.set(appointmentId, options.windows);
    console.log(`[SYSTEM] Rebook options for appointment ${appointmentId}:`);
    options.windows.forEach((window, idx) => {
      console.log(`[SYSTEM] ${idx + 1}) ${window.label}`);
    });
    console.log(`[SYSTEM] Choose with: /rebook ${appointmentId} <option_number>`);
    return true;
  }

  const rebookApplyMatch = trimmed.match(/^\/rebook\s+(\d+)\s+([1-9]\d*)$/);
  if (rebookApplyMatch) {
    const appointmentId = Number(rebookApplyMatch[1]);
    const optionNumber = Number(rebookApplyMatch[2]);

    const options = rebookOptions.get(appointmentId);
    if (!options || options.length === 0) {
      console.log(`[SYSTEM] No cached rebook options for appointment ${appointmentId}. Run /rebook ${appointmentId} first.`);
      return true;
    }

    const selected = options[optionNumber - 1];
    if (!selected) {
      console.log(`[SYSTEM] Invalid option ${optionNumber}.`);
      return true;
    }

    const result = session.rescheduleAppointmentById(appointmentId, selected.window_start, selected.window_end);
    console.log(`[SYSTEM] ${result.message}`);

    if (result.ok) {
      rebookOptions.delete(appointmentId);
    }

    return true;
  }

  return false;
}

export async function runCallSimulator(mode: SimulatorMode, runtimeConfig: RuntimeConfig): Promise<void> {
  const session = createAgentSession({
    openaiApiKey: runtimeConfig.openaiApiKey,
    textModel: runtimeConfig.textModel,
    realtimeModel: runtimeConfig.realtimeModel,
    realtimeVoice: runtimeConfig.realtimeVoice,
    approvalMode: runtimeConfig.approvalMode,
    operatorEmail: runtimeConfig.operatorEmail,
    voiceWrapupSeconds: runtimeConfig.voiceWrapupSeconds,
    voiceHardMaxSeconds: runtimeConfig.voiceHardMaxSeconds,
    dbPath: runtimeConfig.dbPath,
    schemaPath: runtimeConfig.schemaPath,
    forceLocalPlanner: runtimeConfig.forceLocalPlanner,
    calendarConfig: {
      timezone: runtimeConfig.businessTimezone,
      workdayStartHour: runtimeConfig.workdayStartHour,
      workdayEndHour: runtimeConfig.workdayEndHour,
      saturdayStartHour: runtimeConfig.saturdayStartHour,
      saturdayEndHour: runtimeConfig.saturdayEndHour,
      slotDurationHours: runtimeConfig.slotDurationHours
    }
  });

  session.startSession(mode);

  if (mode === "voice") {
    try {
      await session.startVoiceLoop();
    } finally {
      session.endSession();
    }
    return;
  }

  const rl = readline.createInterface({ input, output });
  const rebookOptions = new Map<number, AvailabilityWindow[]>();

  console.log("[SYSTEM] Call simulator started (text mode). Type caller messages. Type exit to end.");
  printOperatorHelp();

  try {
    let keepRunning = true;

    while (keepRunning) {
      const pending = session.getPendingBooking();
      if (pending) {
        const operatorInput = (await rl.question("[OPERATOR] Type approve/reject before continuing caller flow: ")).trim().toLowerCase();

        if (operatorInput === "approve") {
          const result = await session.approvePendingBooking();
          console.log(`[AGENT] ${result.message}`);
          continue;
        }

        if (operatorInput === "reject") {
          const result = await session.rejectPendingBooking("Rejected by CLI operator.");
          console.log(`[AGENT] ${result.message}`);
          continue;
        }

        console.log("[SYSTEM] Please type either 'approve' or 'reject'.");
        continue;
      }

      const callerText = (await rl.question("[CALLER] ")).trim();
      if (!callerText) {
        continue;
      }

      if (callerText.toLowerCase() === "exit") {
        keepRunning = false;
        break;
      }

      if (callerText.startsWith("/")) {
        const handled = await handleOperatorCommand(callerText, session, rebookOptions);
        if (!handled) {
          console.log("[SYSTEM] Unknown command. Type /help.");
        }
        continue;
      }

      const turn = await session.handleTextTurn(callerText);
      console.log(`[AGENT] ${turn.reply}`);

      if (turn.callEnded) {
        console.log("[SYSTEM] Call marked complete. Type exit or continue with a new caller turn.");
      }
    }
  } catch (error) {
    console.error("[ERROR] Simulator failed:", error);
  } finally {
    rl.close();
    session.endSession();
  }
}

if (require.main === module) {
  const mode = parseModeFromArgs(process.argv.slice(2));
  const config = loadRuntimeConfig();

  runCallSimulator(mode, config).catch((error) => {
    console.error("[ERROR]", error);
    process.exitCode = 1;
  });
}
