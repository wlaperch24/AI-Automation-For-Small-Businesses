import { config } from "../config";
import {
  IncomingMessageEvent,
  MissedCallEvent,
  ConversationRecord,
  SlotOption,
  AlertRecord,
  AuditRecord
} from "../types";
import { getSheetStore, parseBoolean } from "./sheets";
import { CalendarService, getCalendarService } from "./calendar";
import { getOpenPhoneClient, OpenPhoneClient } from "./openphone";
import {
  buildBookingConfirmationText,
  buildEscalationText,
  buildFallbackText,
  buildInitialMissedCallText,
  buildNoReplyFollowUpText,
  buildReminderText,
  buildSlotOfferText
} from "./messages";
import {
  mergeIntakeFields,
  missingFieldsPrompt,
  missingIntakeFields,
  parseInboundMessage
} from "./intake";
import { sendAlertEmail } from "./alerts";
import { minutesSince, minutesUntil } from "./time";

interface SendContext {
  event: string;
  note?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseSlots(raw: string): SlotOption[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as SlotOption[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((slot) => Boolean(slot.startIso && slot.endIso && slot.label));
  } catch {
    return [];
  }
}

function bool(value: string): boolean {
  return parseBoolean(value || "false");
}

function shouldEscalate(conversation: ConversationRecord): boolean {
  const count = Number(conversation.message_count || "0");
  return count >= config.escalateAfterMessages;
}

export class ConversationEngine {
  private readonly store = getSheetStore();
  private readonly calendar: CalendarService = getCalendarService();
  private readonly openPhone: OpenPhoneClient = getOpenPhoneClient();

  async initialize(): Promise<void> {
    await this.store.ensureSchema();
  }

  private async audit(entry: Omit<AuditRecord, "timestamp">): Promise<void> {
    await this.store.logAudit({
      timestamp: nowIso(),
      ...entry
    });
  }

  private async alert(entry: Omit<AlertRecord, "timestamp" | "resolved">): Promise<void> {
    await this.store.logAlert({
      timestamp: nowIso(),
      resolved: "false",
      ...entry
    });

    await sendAlertEmail(entry.subject, entry.body);
  }

  private async sendSms(conversation: ConversationRecord, content: string, context: SendContext): Promise<void> {
    const from = conversation.business_number || config.openPhoneDefaultFromNumber;
    if (!from) {
      throw new Error("No business number found for outbound message.");
    }

    await this.openPhone.sendMessage({
      to: conversation.phone_e164,
      from,
      content
    });

    await this.store.upsertConversation(conversation.phone_e164, {
      business_number: from,
      last_outbound_at: nowIso(),
      last_error: ""
    });

    await this.audit({
      level: "INFO",
      phone_e164: conversation.phone_e164,
      event: context.event,
      message: "SMS sent",
      details_json: JSON.stringify({
        note: context.note,
        content
      })
    });
  }

  private async queueRetry(
    conversation: ConversationRecord,
    payload: { content: string },
    errorMessage: string
  ): Promise<void> {
    await this.store.setRetry(conversation.phone_e164, payload, errorMessage);
    await this.alert({
      severity: "ERROR",
      phone_e164: conversation.phone_e164,
      subject: "SMS automation retry queued",
      body: `Phone: ${conversation.phone_e164}\nError: ${errorMessage}`
    });
  }

  private async safeSendSms(conversation: ConversationRecord, content: string, context: SendContext): Promise<void> {
    try {
      await this.sendSms(conversation, content, context);
      await this.store.clearRetry(conversation.phone_e164);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown send error";
      await this.queueRetry(conversation, { content }, message);
      throw error;
    }
  }

  private async escalateConversation(conversation: ConversationRecord, reason: string): Promise<void> {
    if (bool(conversation.escalation_sent)) {
      return;
    }

    await this.safeSendSms(conversation, buildEscalationText(), {
      event: "escalation.sms",
      note: reason
    });

    await this.store.upsertConversation(conversation.phone_e164, {
      state: "ESCALATED",
      escalation_sent: "true"
    });

    await this.alert({
      severity: "WARN",
      phone_e164: conversation.phone_e164,
      subject: "Lead conversation escalated",
      body: `Phone: ${conversation.phone_e164}\nReason: ${reason}`
    });
  }

  private async offerSlots(conversation: ConversationRecord): Promise<void> {
    const slots = await this.calendar.getOpenSlots(conversation.preferred_time_text || "", 3);

    if (slots.length === 0) {
      await this.alert({
        severity: "WARN",
        phone_e164: conversation.phone_e164,
        subject: "No callback slots found",
        body: `No open Google Calendar slots found for ${conversation.phone_e164}.`
      });

      await this.safeSendSms(
        conversation,
        "I could not find an open callback slot right now. I will follow up personally as soon as possible.",
        { event: "slots.none" }
      );

      await this.store.upsertConversation(conversation.phone_e164, {
        state: "ESCALATED"
      });
      return;
    }

    await this.store.upsertConversation(conversation.phone_e164, {
      state: "AWAITING_SLOT",
      offered_slots_json: JSON.stringify(slots)
    });

    await this.safeSendSms(conversation, buildSlotOfferText(slots), {
      event: "slots.offer"
    });
  }

  private async bookSelectedSlot(
    conversation: ConversationRecord,
    slot: SlotOption
  ): Promise<void> {
    const available = await this.calendar.isSlotStillFree(slot);
    if (!available) {
      const refreshed = await this.calendar.getOpenSlots(conversation.preferred_time_text || "", 3);

      if (refreshed.length === 0) {
        await this.safeSendSms(
          conversation,
          "That time was just taken, and I do not have a new opening right now. I will follow up personally.",
          { event: "slot.conflict.none" }
        );
        await this.store.upsertConversation(conversation.phone_e164, {
          state: "ESCALATED"
        });
        return;
      }

      await this.store.upsertConversation(conversation.phone_e164, {
        offered_slots_json: JSON.stringify(refreshed),
        state: "AWAITING_SLOT"
      });

      await this.safeSendSms(
        conversation,
        `That slot was just taken. Here are the next options:\n${buildSlotOfferText(refreshed)}`,
        { event: "slot.conflict.refresh" }
      );
      return;
    }

    const calendarEventId = await this.calendar.createCallbackEvent({
      slot,
      leadName: conversation.lead_name,
      issueSummary: conversation.issue_summary,
      phone: conversation.phone_e164
    });

    await this.store.upsertConversation(conversation.phone_e164, {
      state: "BOOKED",
      selected_slot_iso: slot.startIso,
      calendar_event_id: calendarEventId,
      reminder_15m_sent: "false",
      offered_slots_json: "[]"
    });

    await this.safeSendSms(conversation, buildBookingConfirmationText(slot.startIso), {
      event: "slot.booked"
    });
  }

  async handleMissedCall(event: MissedCallEvent): Promise<void> {
    const existing = await this.store.findConversation(event.phone);
    const conversation = await this.store.upsertConversation(event.phone, {
      state: existing?.state === "OPTOUT" ? "OPTOUT" : "AWAITING_INFO",
      business_number: event.businessNumber,
      last_error: "",
      followup_15m_sent: "false",
      fallback_sent: "false",
      last_inbound_at: existing?.last_inbound_at ?? ""
    });

    if (conversation.state === "OPTOUT") {
      await this.audit({
        level: "INFO",
        phone_e164: conversation.phone_e164,
        event: "missed_call.optout",
        message: "Skipped due to OPTOUT state",
        details_json: "{}"
      });
      return;
    }

    await this.safeSendSms(conversation, buildInitialMissedCallText(), {
      event: "missed_call.initial"
    });
  }

  async handleIncomingMessage(event: IncomingMessageEvent): Promise<void> {
    const existing = await this.store.findConversation(event.phone);
    const baseConversation =
      existing ??
      (await this.store.upsertConversation(event.phone, {
        state: "AWAITING_INFO",
        business_number: event.businessNumber
      }));

    if (baseConversation.state === "OPTOUT") {
      await this.audit({
        level: "INFO",
        phone_e164: baseConversation.phone_e164,
        event: "message.optout_ignored",
        message: "Inbound ignored because caller is opted out",
        details_json: JSON.stringify({ eventType: event.eventType })
      });
      return;
    }

    const messageCount = Number(baseConversation.message_count || "0") + 1;

    let conversation = await this.store.upsertConversation(event.phone, {
      message_count: String(messageCount),
      last_inbound_at: event.timestampIso,
      business_number: event.businessNumber
    });

    const parsed = parseInboundMessage(event.text);

    if (parsed.command === "STOP") {
      await this.store.upsertConversation(event.phone, {
        state: "OPTOUT"
      });
      await this.safeSendSms(conversation, "You are opted out. You will not receive automated texts from this number.", {
        event: "optout.confirm"
      });
      return;
    }

    if (parsed.command === "RESCHEDULE") {
      await this.store.upsertConversation(event.phone, {
        state: "AWAITING_INFO",
        preferred_time_text: "",
        selected_slot_iso: "",
        calendar_event_id: "",
        offered_slots_json: "[]",
        followup_15m_sent: "false"
      });

      await this.safeSendSms(
        conversation,
        "No problem. Please share your preferred callback times and I will send new options.",
        {
          event: "reschedule.request"
        }
      );
      return;
    }

    conversation = mergeIntakeFields(conversation, parsed.extraction);
    conversation = await this.store.upsertConversation(event.phone, {
      lead_name: conversation.lead_name,
      issue_summary: conversation.issue_summary,
      preferred_time_text: conversation.preferred_time_text
    });

    if (conversation.state === "AWAITING_SLOT") {
      const offeredSlots = parseSlots(conversation.offered_slots_json);
      const selectedByNumber =
        parsed.slotChoice && offeredSlots.length >= parsed.slotChoice
          ? offeredSlots[parsed.slotChoice - 1]
          : undefined;

      const selectedByYes = parsed.confirmedSuggestedSlot && offeredSlots.length === 1 ? offeredSlots[0] : undefined;
      const selectedSlot = selectedByNumber ?? selectedByYes;

      if (!selectedSlot) {
        await this.safeSendSms(conversation, "Please reply 1, 2, or 3 to choose a callback time.", {
          event: "slot.invalid_choice"
        });
      } else {
        await this.bookSelectedSlot(conversation, selectedSlot);
      }
    } else {
      const missing = missingIntakeFields(conversation);
      if (missing.length > 0) {
        await this.safeSendSms(conversation, missingFieldsPrompt(missing), {
          event: "intake.missing"
        });
      } else {
        await this.offerSlots(conversation);
      }
    }

    const latest = await this.store.findConversation(event.phone);
    if (latest && latest.state !== "BOOKED" && latest.state !== "OPTOUT" && shouldEscalate(latest)) {
      await this.escalateConversation(latest, `Message threshold reached (${latest.message_count})`);
    }
  }

  async handleProcessingFailure(input: {
    phone: string;
    businessNumber: string;
    reason: string;
    eventType: string;
  }): Promise<void> {
    const conversation = await this.store.upsertConversation(input.phone, {
      business_number: input.businessNumber,
      last_error: trimMessage(input.reason)
    });

    if (!bool(conversation.fallback_sent)) {
      try {
        await this.safeSendSms(conversation, buildFallbackText(), {
          event: "processing.fallback"
        });
        await this.store.upsertConversation(conversation.phone_e164, {
          fallback_sent: "true"
        });
      } catch {
        // Already queued for retry inside safeSendSms
      }
    }

    await this.alert({
      severity: "ERROR",
      phone_e164: input.phone,
      subject: "SMS automation processing failure",
      body: `Event: ${input.eventType}\nPhone: ${input.phone}\nError: ${input.reason}`
    });
  }

  async runNoReplyFollowUpJob(): Promise<{ processed: number }> {
    const conversations = await this.store.listConversations();
    let processed = 0;

    for (const conversation of conversations) {
      if (conversation.state !== "AWAITING_INFO" && conversation.state !== "AWAITING_SLOT") {
        continue;
      }

      if (bool(conversation.followup_15m_sent)) {
        continue;
      }

      const lastSignal = conversation.last_inbound_at || conversation.last_outbound_at;
      if (!lastSignal) {
        continue;
      }

      const minutesIdle = minutesSince(lastSignal);
      if (minutesIdle < config.followUpAfterMinutes) {
        continue;
      }

      const suggested = await this.calendar.getEarliestSlotTodayOrNextBusinessDay();
      if (!suggested) {
        continue;
      }

      await this.store.upsertConversation(conversation.phone_e164, {
        followup_15m_sent: "true",
        state: "AWAITING_SLOT",
        offered_slots_json: JSON.stringify([suggested])
      });

      await this.safeSendSms(conversation, buildNoReplyFollowUpText(suggested.startIso), {
        event: "followup.15m"
      });

      processed += 1;
    }

    return { processed };
  }

  async runReminderJob(): Promise<{ processed: number }> {
    const conversations = await this.store.listConversations();
    let processed = 0;

    for (const conversation of conversations) {
      if (conversation.state !== "BOOKED") {
        continue;
      }

      if (bool(conversation.reminder_15m_sent)) {
        continue;
      }

      if (!conversation.selected_slot_iso) {
        continue;
      }

      const minutes = minutesUntil(conversation.selected_slot_iso);
      if (minutes > 15 || minutes < 0) {
        continue;
      }

      await this.safeSendSms(conversation, buildReminderText(conversation.selected_slot_iso), {
        event: "reminder.15m"
      });

      await this.store.upsertConversation(conversation.phone_e164, {
        reminder_15m_sent: "true"
      });

      processed += 1;
    }

    return { processed };
  }

  async runRetryJob(): Promise<{ processed: number; escalated: number }> {
    const conversations = await this.store.listConversations();
    let processed = 0;
    let escalated = 0;

    for (const conversation of conversations) {
      if (!bool(conversation.pending_retry)) {
        continue;
      }

      const retryCount = Number(conversation.retry_count || "0");
      if (!conversation.retry_payload_json) {
        await this.store.upsertConversation(conversation.phone_e164, {
          pending_retry: "false"
        });
        continue;
      }

      let payload: { content: string };
      try {
        payload = JSON.parse(conversation.retry_payload_json) as { content: string };
      } catch {
        await this.store.upsertConversation(conversation.phone_e164, {
          pending_retry: "false",
          retry_payload_json: "",
          last_error: "Invalid retry payload"
        });
        continue;
      }

      try {
        await this.sendSms(conversation, payload.content, {
          event: "retry.send"
        });
        await this.store.clearRetry(conversation.phone_e164);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Retry send failed";

        if (retryCount >= 1) {
          await this.store.upsertConversation(conversation.phone_e164, {
            pending_retry: "false",
            state: "ESCALATED",
            last_error: message
          });
          await this.alert({
            severity: "ERROR",
            phone_e164: conversation.phone_e164,
            subject: "Retry failed and escalated",
            body: `Phone: ${conversation.phone_e164}\nError: ${message}`
          });
          escalated += 1;
        } else {
          await this.store.upsertConversation(conversation.phone_e164, {
            retry_count: String(retryCount + 1),
            last_error: message
          });
        }
      }
    }

    return { processed, escalated };
  }
}

let singleton: ConversationEngine | null = null;

export function getConversationEngine(): ConversationEngine {
  if (!singleton) {
    singleton = new ConversationEngine();
  }
  return singleton;
}
