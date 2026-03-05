import { formatSlotLabel } from "./time";
import { SlotOption } from "../types";

export function buildInitialMissedCallText(): string {
  return "Sorry I missed your call. I can book a callback by text right now. Please reply with: 1) your name 2) what issue you need help with 3) times you are available today or next business day (ET). I will confirm a 15-minute slot. Reply STOP to opt out.";
}

export function buildSlotOfferText(slots: SlotOption[]): string {
  const lines = slots.map((slot, index) => `${index + 1}) ${slot.label}`);
  return [`Thanks. I can call at:`, ...lines, "Reply 1, 2, or 3 to book."].join("\n");
}

export function buildBookingConfirmationText(slotStartIso: string): string {
  return `Booked: ${formatSlotLabel(slotStartIso)}. I will call you then. If anything changes, reply RESCHEDULE.`;
}

export function buildNoReplyFollowUpText(slotStartIso: string): string {
  return `I have some time at ${formatSlotLabel(slotStartIso)} today. Can I call you then? Reply YES or share a better time.`;
}

export function buildReminderText(slotStartIso: string): string {
  return `Reminder: I am scheduled to call you at ${formatSlotLabel(slotStartIso)}. Reply RESCHEDULE if you need a different time.`;
}

export function buildEscalationText(): string {
  return "Thanks for the details. I will take this over personally and follow up shortly.";
}

export function buildFallbackText(): string {
  return "Sorry - we hit a scheduling issue. Please share your best callback time and I will follow up as soon as possible.";
}
