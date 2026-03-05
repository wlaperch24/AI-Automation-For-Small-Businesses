import { SqliteLogger } from "./logging";

export interface SendSmsArgs {
  to: string;
  message: string;
}

export class SimulatedSmsTool {
  constructor(private readonly db: SqliteLogger) {}

  sendSms(args: SendSmsArgs, sessionId?: number): { ok: true; sms_id: number; status: string } {
    const to = args.to.trim();
    const message = args.message.trim();

    const smsId = this.db.logSms(sessionId, to, message);

    console.log("[SMS SENT]", { to, message });

    // TODO(phase-b): replace this simulated sender with a Twilio adapter and keep DB audit behavior.
    return {
      ok: true,
      sms_id: smsId,
      status: "SIMULATED_SENT"
    };
  }
}
