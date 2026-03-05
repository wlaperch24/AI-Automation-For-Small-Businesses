import { sheets_v4 } from "googleapis";
import { config, requireConfigValue } from "../config";
import { getSheetsClient } from "./google";
import { AlertRecord, AuditRecord, ConversationRecord, DedupeRecord } from "../types";

const TAB_CONVERSATIONS = "conversations";
const TAB_EVENT_DEDUPE = "event_dedupe";
const TAB_AUDIT_LOG = "audit_log";
const TAB_ALERTS = "alerts";

const CONVERSATION_HEADERS: Array<keyof ConversationRecord> = [
  "phone_e164",
  "state",
  "lead_name",
  "issue_summary",
  "preferred_time_text",
  "offered_slots_json",
  "selected_slot_iso",
  "calendar_event_id",
  "message_count",
  "last_inbound_at",
  "last_outbound_at",
  "followup_15m_sent",
  "reminder_15m_sent",
  "fallback_sent",
  "escalation_sent",
  "pending_retry",
  "retry_count",
  "retry_payload_json",
  "business_number",
  "last_error",
  "created_at",
  "updated_at"
];

const DEDUPE_HEADERS: Array<keyof DedupeRecord> = ["event_id", "event_type", "processed_at"];
const AUDIT_HEADERS: Array<keyof AuditRecord> = [
  "timestamp",
  "level",
  "phone_e164",
  "event",
  "message",
  "details_json"
];
const ALERT_HEADERS: Array<keyof AlertRecord> = [
  "timestamp",
  "severity",
  "phone_e164",
  "subject",
  "body",
  "resolved"
];

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord<T extends string>(headers: T[], row: string[]): Record<T, string> {
  const out = {} as Record<T, string>;
  headers.forEach((header, index) => {
    out[header] = row[index] ?? "";
  });
  return out;
}

function toRow<T extends string>(headers: T[], record: Record<T, string>): string[] {
  return headers.map((header) => record[header] ?? "");
}

function boolToString(value: boolean): string {
  return value ? "true" : "false";
}

function buildDefaultConversation(phone: string): ConversationRecord {
  const now = nowIso();
  return {
    phone_e164: phone,
    state: "AWAITING_INFO",
    lead_name: "",
    issue_summary: "",
    preferred_time_text: "",
    offered_slots_json: "[]",
    selected_slot_iso: "",
    calendar_event_id: "",
    message_count: "0",
    last_inbound_at: "",
    last_outbound_at: "",
    followup_15m_sent: "false",
    reminder_15m_sent: "false",
    fallback_sent: "false",
    escalation_sent: "false",
    pending_retry: "false",
    retry_count: "0",
    retry_payload_json: "",
    business_number: "",
    last_error: "",
    created_at: now,
    updated_at: now
  };
}

class SheetStore {
  private readonly spreadsheetId: string;
  private readonly sheetsClient: sheets_v4.Sheets;
  private schemaEnsured = false;

  constructor() {
    this.spreadsheetId = requireConfigValue(config.googleSheetId, "GOOGLE_SHEET_ID");
    this.sheetsClient = getSheetsClient();
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) {
      return;
    }

    const spreadsheet = await this.sheetsClient.spreadsheets.get({
      spreadsheetId: this.spreadsheetId
    });

    const existing = new Set(
      (spreadsheet.data.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => Boolean(title))
    );

    const requiredTabs = [TAB_CONVERSATIONS, TAB_EVENT_DEDUPE, TAB_AUDIT_LOG, TAB_ALERTS];

    const addRequests = requiredTabs
      .filter((tab) => !existing.has(tab))
      .map((tab) => ({
        addSheet: {
          properties: {
            title: tab
          }
        }
      }));

    if (addRequests.length > 0) {
      await this.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: addRequests
        }
      });
    }

    await this.ensureHeaders(TAB_CONVERSATIONS, CONVERSATION_HEADERS as string[]);
    await this.ensureHeaders(TAB_EVENT_DEDUPE, DEDUPE_HEADERS as string[]);
    await this.ensureHeaders(TAB_AUDIT_LOG, AUDIT_HEADERS as string[]);
    await this.ensureHeaders(TAB_ALERTS, ALERT_HEADERS as string[]);
    this.schemaEnsured = true;
  }

  private async ensureHeaders(tab: string, headers: string[]): Promise<void> {
    const existing = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!1:1`
    });

    const row = existing.data.values?.[0] ?? [];
    const missingHeaders = row.length === 0;

    if (missingHeaders) {
      await this.sheetsClient.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [headers]
        }
      });
    }
  }

  private async getAllRows(tab: string): Promise<string[][]> {
    const response = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A1:ZZ`
    });

    return response.data.values ?? [];
  }

  private async updateRow(tab: string, rowIndex: number, values: string[]): Promise<void> {
    await this.sheetsClient.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [values]
      }
    });
  }

  private async appendRow(tab: string, values: string[]): Promise<void> {
    await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [values]
      }
    });
  }

  async findConversation(phone: string): Promise<ConversationRecord | null> {
    const rows = await this.getAllRows(TAB_CONVERSATIONS);
    if (rows.length <= 1) {
      return null;
    }

    const dataRows = rows.slice(1);
    for (const row of dataRows) {
      const record = toRecord(CONVERSATION_HEADERS, row) as ConversationRecord;
      if (record.phone_e164 === phone) {
        return record;
      }
    }

    return null;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = await this.getAllRows(TAB_CONVERSATIONS);
    if (rows.length <= 1) {
      return [];
    }

    return rows.slice(1).map((row) => toRecord(CONVERSATION_HEADERS, row) as ConversationRecord);
  }

  async upsertConversation(phone: string, patch: Partial<ConversationRecord>): Promise<ConversationRecord> {
    const allRows = await this.getAllRows(TAB_CONVERSATIONS);

    if (allRows.length === 0) {
      await this.ensureHeaders(TAB_CONVERSATIONS, CONVERSATION_HEADERS as string[]);
    }

    let rowIndex = -1;
    let current = buildDefaultConversation(phone);

    for (let index = 1; index < allRows.length; index += 1) {
      const row = allRows[index];
      const record = toRecord(CONVERSATION_HEADERS, row) as ConversationRecord;
      if (record.phone_e164 === phone) {
        rowIndex = index + 1;
        current = record;
        break;
      }
    }

    const merged: ConversationRecord = {
      ...current,
      ...patch,
      phone_e164: phone,
      updated_at: nowIso(),
      created_at: current.created_at || nowIso()
    };

    const nextRow = toRow(CONVERSATION_HEADERS, merged as unknown as Record<keyof ConversationRecord, string>);

    if (rowIndex === -1) {
      await this.appendRow(TAB_CONVERSATIONS, nextRow);
    } else {
      await this.updateRow(TAB_CONVERSATIONS, rowIndex, nextRow);
    }

    return merged;
  }

  async markEventProcessed(eventId: string, eventType: string): Promise<void> {
    await this.appendRow(TAB_EVENT_DEDUPE, [eventId, eventType, nowIso()]);
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const rows = await this.getAllRows(TAB_EVENT_DEDUPE);
    if (rows.length <= 1) {
      return false;
    }

    return rows.slice(1).some((row) => row[0] === eventId);
  }

  async logAudit(entry: AuditRecord): Promise<void> {
    await this.appendRow(TAB_AUDIT_LOG, toRow(AUDIT_HEADERS, entry));
  }

  async logAlert(entry: AlertRecord): Promise<void> {
    await this.appendRow(TAB_ALERTS, toRow(ALERT_HEADERS, entry));
  }

  async setRetry(phone: string, payload: unknown, errorMessage: string): Promise<ConversationRecord> {
    const existing = (await this.findConversation(phone)) ?? buildDefaultConversation(phone);
    const retryCount = Number(existing.retry_count || "0") + 1;

    return this.upsertConversation(phone, {
      pending_retry: boolToString(true),
      retry_payload_json: JSON.stringify(payload),
      retry_count: String(retryCount),
      last_error: errorMessage
    });
  }

  async clearRetry(phone: string): Promise<ConversationRecord> {
    return this.upsertConversation(phone, {
      pending_retry: boolToString(false),
      retry_payload_json: "",
      last_error: ""
    });
  }
}

let singleton: SheetStore | null = null;

export function getSheetStore(): SheetStore {
  if (!singleton) {
    singleton = new SheetStore();
  }
  return singleton;
}

export function parseBoolean(value: string): boolean {
  return value.toLowerCase() === "true";
}
