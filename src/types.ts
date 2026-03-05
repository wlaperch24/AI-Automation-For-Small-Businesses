export type ConversationState =
  | "AWAITING_INFO"
  | "AWAITING_SLOT"
  | "BOOKED"
  | "ESCALATED"
  | "OPTOUT";

export interface ConversationRecord {
  phone_e164: string;
  state: ConversationState;
  lead_name: string;
  issue_summary: string;
  preferred_time_text: string;
  offered_slots_json: string;
  selected_slot_iso: string;
  calendar_event_id: string;
  message_count: string;
  last_inbound_at: string;
  last_outbound_at: string;
  followup_15m_sent: string;
  reminder_15m_sent: string;
  fallback_sent: string;
  escalation_sent: string;
  pending_retry: string;
  retry_count: string;
  retry_payload_json: string;
  business_number: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface DedupeRecord {
  event_id: string;
  event_type: string;
  processed_at: string;
}

export interface AuditRecord {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  phone_e164: string;
  event: string;
  message: string;
  details_json: string;
}

export interface AlertRecord {
  timestamp: string;
  severity: "WARN" | "ERROR";
  phone_e164: string;
  subject: string;
  body: string;
  resolved: string;
}

export interface OutboundMessage {
  to: string;
  from: string;
  content: string;
}

export interface SlotOption {
  startIso: string;
  endIso: string;
  label: string;
}

export interface IncomingMessageEvent {
  eventId: string;
  eventType: string;
  phone: string;
  businessNumber: string;
  text: string;
  timestampIso: string;
}

export interface MissedCallEvent {
  eventId: string;
  eventType: string;
  phone: string;
  businessNumber: string;
  timestampIso: string;
}
