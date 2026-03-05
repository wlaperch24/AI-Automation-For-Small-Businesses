import {
  AvailabilityWindow,
  CreateAppointmentArgs,
  LocalCalendarTool
} from "../tools/calendar";
import { SafetyService } from "../services/safety";

export type WorkflowState =
  | "COLLECT_CONTACT"
  | "COLLECT_ISSUE"
  | "COLLECT_URGENCY"
  | "COLLECT_SAFETY"
  | "OFFERING_SLOTS"
  | "AWAITING_SLOT_SELECTION"
  | "BOOKING_PENDING_APPROVAL"
  | "BOOKED"
  | "SAFETY_ESCALATED"
  | "ESCALATED_MANUAL";

export interface PendingBooking {
  name: string;
  phone: string;
  address: string;
  issue: string;
  urgency: string;
  window_start: string;
  window_end: string;
  notes: string;
}

interface IntakeState {
  name?: string;
  address?: string;
  phone?: string;
  issue?: string;
  urgency?: string;
  safetyRisk?: "yes" | "no";
  windows?: AvailabilityWindow[];
}

export interface ManagerConfig {
  approvalMode: boolean;
  emergencyReply: string;
}

export interface ManagerTurnResult {
  reply: string;
  state: WorkflowState;
  outcome?: "BOOKED" | "SAFETY_ESCALATED" | "ESCALATED_MANUAL";
  pendingBooking?: PendingBooking;
  bookedAppointment?: {
    appointmentId: number;
    windowLabel: string;
    booking: PendingBooking;
  };
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

  const firstLine = text.split(/\n+/)[0]?.trim();
  if (firstLine && /^[A-Za-z][A-Za-z' -]{2,60}$/.test(firstLine)) {
    return cleanText(firstLine);
  }

  return undefined;
}

function extractAddress(text: string): string | undefined {
  const normalized = cleanText(text);
  if (/\d+\s+[A-Za-z0-9 .'-]+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|place|pl)\b/i.test(normalized)) {
    return normalized;
  }

  return undefined;
}

export class ReceptionWorkflowManager {
  private state: WorkflowState = "COLLECT_CONTACT";
  private readonly intake: IntakeState = {};

  constructor(
    private readonly calendar: LocalCalendarTool,
    private readonly safety: SafetyService,
    private readonly config: ManagerConfig
  ) {}

  getState(): WorkflowState {
    return this.state;
  }

  processCallerText(callerText: string): ManagerTurnResult {
    this.intake.name = this.intake.name ?? extractName(callerText);
    this.intake.address = this.intake.address ?? extractAddress(callerText);
    this.intake.phone = this.intake.phone ?? extractPhone(callerText);
    this.intake.issue = this.intake.issue ?? detectIssue(callerText);
    this.intake.urgency = this.intake.urgency ?? detectUrgency(callerText);

    if (this.intake.safetyRisk === undefined) {
      if (this.safety.isExplicitNoRisk(callerText) || /\b(no|none|not really|nope)\b/i.test(callerText)) {
        this.intake.safetyRisk = "no";
      } else if (this.safety.assess(callerText).isDanger) {
        this.intake.safetyRisk = "yes";
      }
    }

    if (!this.intake.name || !this.intake.address || !this.intake.phone) {
      this.state = "COLLECT_CONTACT";
      const missing: string[] = [];
      if (!this.intake.name) missing.push("name");
      if (!this.intake.address) missing.push("full street address");
      if (!this.intake.phone) missing.push("callback number");
      return {
        reply: `Thanks for calling Bill's Plumbing. I still need your ${missing.join(", ")}.`,
        state: this.state
      };
    }

    if (!this.intake.issue) {
      this.state = "COLLECT_ISSUE";
      return {
        reply: "Thanks. What issue are you dealing with: leak, clog, no hot water, burst pipe, or something else?",
        state: this.state
      };
    }

    if (!this.intake.urgency) {
      this.state = "COLLECT_URGENCY";
      return {
        reply: "Got it. Is this urgent right now, like active leak, flooding, no water, or sewage backup?",
        state: this.state
      };
    }

    if (!this.intake.safetyRisk) {
      this.state = "COLLECT_SAFETY";
      return {
        reply: "Any safety risk right now, like a gas smell or electrical hazard?",
        state: this.state
      };
    }

    if (this.intake.safetyRisk === "yes") {
      this.state = "SAFETY_ESCALATED";
      return {
        reply: this.config.emergencyReply,
        state: this.state,
        outcome: "SAFETY_ESCALATED"
      };
    }

    if (!this.intake.windows || this.intake.windows.length === 0) {
      this.state = "OFFERING_SLOTS";
      const availability = this.calendar.listAvailability({
        urgency: this.intake.urgency
      });

      if (!availability.ok || availability.windows.length === 0) {
        this.state = "ESCALATED_MANUAL";
        return {
          reply: "I could not find an open window right now. We will call you back shortly to schedule manually.",
          state: this.state,
          outcome: "ESCALATED_MANUAL"
        };
      }

      this.intake.windows = availability.windows.slice(0, 3);
      this.state = "AWAITING_SLOT_SELECTION";
      const options = this.intake.windows.map((window, idx) => `${idx + 1}) ${window.label}`).join("\n");

      return {
        reply: `I can offer:\n${options}\nReply with 1, 2, or 3.`,
        state: this.state
      };
    }

    this.state = "AWAITING_SLOT_SELECTION";

    const choiceMatch = callerText.match(/^\s*([1-3])\s*$/);
    if (!choiceMatch) {
      return {
        reply: "Please choose 1, 2, or 3 for the appointment window.",
        state: this.state
      };
    }

    const choice = Number(choiceMatch[1]) - 1;
    const selectedWindow = this.intake.windows[choice];
    if (!selectedWindow) {
      return {
        reply: "That option is not available. Please choose 1, 2, or 3.",
        state: this.state
      };
    }

    const booking: PendingBooking = {
      name: this.intake.name,
      phone: this.intake.phone,
      address: this.intake.address,
      issue: this.intake.issue,
      urgency: this.intake.urgency,
      window_start: selectedWindow.window_start,
      window_end: selectedWindow.window_end,
      notes: "Booked through manager workflow"
    };

    if (this.config.approvalMode) {
      this.state = "BOOKING_PENDING_APPROVAL";
      return {
        reply: `Proposed booking: ${booking.name}, ${booking.phone}, ${booking.address}, ${selectedWindow.label}. Operator, type approve to finalize.`,
        state: this.state,
        pendingBooking: booking
      };
    }

    const created = this.calendar.createAppointment(booking as CreateAppointmentArgs);
    if (!created.ok) {
      this.state = "AWAITING_SLOT_SELECTION";
      return {
        reply: `I couldn't lock that slot: ${created.message}. Let me offer new times.`,
        state: this.state
      };
    }

    this.state = "BOOKED";
    return {
      reply: `Booked. You are confirmed for ${created.window_label}. I sent a confirmation text.`,
      state: this.state,
      outcome: "BOOKED",
      bookedAppointment: {
        appointmentId: created.appointment_id,
        windowLabel: created.window_label,
        booking
      }
    };
  }
}
