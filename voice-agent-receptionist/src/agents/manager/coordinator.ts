import {
  AgentDescriptor,
  ManagedAvailabilityInput,
  ManagedCancelInput,
  ManagedCreateAppointmentInput,
  ManagedFollowUpInput,
  ManagedRescheduleInput
} from "../contracts";
import {
  MultiAgentRuntime,
  MultiAgentRuntimeConfig,
  createMultiAgentRuntime
} from "../runtime";
import { DottyIntakeAgent } from "../intake/dotty_intake_agent";
import { SchedulingAgent } from "../scheduling/scheduling_agent";
import { QuoteFollowupAgent } from "../quote/quote_followup_agent";
import { CallbackOpsAgent } from "../callback/callback_ops_agent";

interface ManagedCreateAppointmentResult {
  ok: boolean;
  appointment_id?: number;
  window_label?: string;
  error_code?: string;
  message?: string;
  confirmation_sms_id?: number;
  quote_sms_id?: number;
}

interface ManagedCancelResult {
  ok: boolean;
  appointment_id?: number;
  status?: string;
  error_code?: string;
  message?: string;
  cancellation_sms_id?: number;
}

interface ManagedRescheduleResult {
  ok: boolean;
  appointment_id?: number;
  window_label?: string;
  error_code?: string;
  message?: string;
  reschedule_sms_id?: number;
}

function isRuntime(value: unknown): value is MultiAgentRuntime {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MultiAgentRuntime>;
  return Boolean(candidate.db && candidate.calendar && candidate.sms && candidate.quoteService && candidate.safetyService);
}

export class MultiAgentCoordinator {
  private readonly dottyIntakeAgent: DottyIntakeAgent;
  private readonly schedulingAgent: SchedulingAgent;
  private readonly quoteFollowupAgent: QuoteFollowupAgent;
  private readonly callbackOpsAgent: CallbackOpsAgent;
  private readonly descriptors: AgentDescriptor[];

  constructor(private readonly runtime: MultiAgentRuntime, private readonly ownsDbLifecycle: boolean) {
    this.dottyIntakeAgent = new DottyIntakeAgent();
    this.schedulingAgent = new SchedulingAgent(runtime.calendar, runtime.db);
    this.quoteFollowupAgent = new QuoteFollowupAgent(runtime.sms, runtime.quoteService);
    this.callbackOpsAgent = new CallbackOpsAgent(runtime.db, runtime.operatorEmail);
    this.descriptors = [
      this.dottyIntakeAgent.descriptor,
      this.schedulingAgent.descriptor,
      this.quoteFollowupAgent.descriptor,
      this.callbackOpsAgent.descriptor,
      {
        id: "manager",
        name: "Manager Coordinator",
        purpose: "Delegates work to specialized agents and maintains shared context.",
        owns: ["routing", "cross-agent orchestration"]
      }
    ];
  }

  getAgentRegistry(): string[] {
    return this.descriptors.map((item) => item.id);
  }

  listAvailability(input: ManagedAvailabilityInput["args"]) {
    return this.schedulingAgent.listAvailability(input);
  }

  createAppointment(input: ManagedCreateAppointmentInput): ManagedCreateAppointmentResult {
    const created = this.schedulingAgent.createAppointment(input.args);
    if (!created.ok) {
      return created;
    }

    const sms = this.quoteFollowupAgent.sendBookingTexts({
      sessionId: input.sessionId,
      name: input.args.name,
      phone: input.args.phone,
      issue: input.args.issue,
      urgency: input.args.urgency,
      windowLabel: created.window_label
    });

    return {
      ...created,
      confirmation_sms_id: sms.confirmation_sms_id,
      quote_sms_id: sms.quote_sms_id
    };
  }

  cancelAppointment(input: ManagedCancelInput): ManagedCancelResult {
    const appointment = this.schedulingAgent.getAppointmentById(input.args.appointment_id);
    const cancelled = this.schedulingAgent.cancelAppointment(input.args);

    if (!cancelled.ok) {
      return cancelled;
    }

    if (!appointment) {
      return cancelled;
    }

    const sms = this.quoteFollowupAgent.sendCancellationText(input.sessionId, appointment.phone);
    return {
      ...cancelled,
      cancellation_sms_id: sms.cancellation_sms_id
    };
  }

  rescheduleAppointment(input: ManagedRescheduleInput): ManagedRescheduleResult {
    const appointment = this.schedulingAgent.getAppointmentById(input.args.appointment_id);
    const moved = this.schedulingAgent.rescheduleAppointment(input.args);

    if (!moved.ok) {
      return moved;
    }

    if (!appointment) {
      return moved;
    }

    const sms = this.quoteFollowupAgent.sendRescheduleText(input.sessionId, appointment.phone, moved.window_label);
    return {
      ...moved,
      reschedule_sms_id: sms.reschedule_sms_id
    };
  }

  createOfficeFollowUp(input: ManagedFollowUpInput): { ok: true; follow_up_task_id: number } {
    return this.callbackOpsAgent.createOfficeFollowUp({
      sessionId: input.sessionId,
      callbackPhone: input.callbackPhone,
      note: input.note,
      details: input.details,
      assignee: input.assignee
    });
  }

  close(): void {
    if (this.ownsDbLifecycle) {
      this.runtime.db.close();
    }
  }
}

export function createMultiAgentCoordinator(input: MultiAgentRuntime | MultiAgentRuntimeConfig): MultiAgentCoordinator {
  if (isRuntime(input)) {
    return new MultiAgentCoordinator(input, false);
  }
  return new MultiAgentCoordinator(createMultiAgentRuntime(input), true);
}

