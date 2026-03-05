import { ConversationRecord } from "../types";

const STOP_REGEX = /^\s*stop\s*$/i;
const RESCHEDULE_REGEX = /\breschedule\b/i;
const SLOT_CHOICE_REGEX = /^\s*([1-3])\s*$/;
const YES_REGEX = /^\s*(yes|yep|yeah|sure)\s*$/i;

export interface IntakeExtraction {
  leadName?: string;
  issueSummary?: string;
  preferredTimeText?: string;
}

export interface ParsedInbound {
  command: "STOP" | "RESCHEDULE" | null;
  slotChoice: number | null;
  confirmedSuggestedSlot: boolean;
  extraction: IntakeExtraction;
}

function cleanupText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractName(text: string): string | undefined {
  const fromLabel = text.match(/\bname\s*[:\-]\s*([^,\n]+)/i);
  if (fromLabel) {
    return cleanupText(fromLabel[1]);
  }

  const fromPhrase = text.match(/\b(?:my name is|this is|i am)\s+([a-z][a-z' -]{1,60})/i);
  if (fromPhrase) {
    return cleanupText(fromPhrase[1]);
  }

  const lineOne = text.split(/\n+/)[0]?.trim();
  if (lineOne && /^[A-Za-z][A-Za-z' -]{1,60}$/.test(lineOne)) {
    return cleanupText(lineOne);
  }

  return undefined;
}

function extractIssue(text: string): string | undefined {
  const fromLabel = text.match(/\b(?:issue|problem|need)\s*[:\-]\s*([^\n]+)/i);
  if (fromLabel) {
    return cleanupText(fromLabel[1]);
  }

  const fromPhrase = text.match(/\b(?:i need help with|calling about|need help with|it'?s about)\s+([^\n]+)/i);
  if (fromPhrase) {
    return cleanupText(fromPhrase[1]);
  }

  if (text.length > 20) {
    return cleanupText(text).slice(0, 240);
  }

  return undefined;
}

function extractPreferredTime(text: string): string | undefined {
  const fromLabel = text.match(/\b(?:available|availability|time|callback)\s*[:\-]\s*([^\n]+)/i);
  if (fromLabel) {
    return cleanupText(fromLabel[1]);
  }

  const hasTimeLikeSignal = /\b(today|tomorrow|mon|tue|wed|thu|fri|am|pm|morning|afternoon|evening|\d{1,2}:?\d{0,2})\b/i.test(
    text
  );

  if (hasTimeLikeSignal) {
    return cleanupText(text).slice(0, 160);
  }

  return undefined;
}

export function parseInboundMessage(text: string): ParsedInbound {
  const cleaned = text.trim();

  if (STOP_REGEX.test(cleaned)) {
    return {
      command: "STOP",
      slotChoice: null,
      confirmedSuggestedSlot: false,
      extraction: {}
    };
  }

  if (RESCHEDULE_REGEX.test(cleaned)) {
    return {
      command: "RESCHEDULE",
      slotChoice: null,
      confirmedSuggestedSlot: false,
      extraction: {}
    };
  }

  const slotChoiceMatch = cleaned.match(SLOT_CHOICE_REGEX);

  return {
    command: null,
    slotChoice: slotChoiceMatch ? Number(slotChoiceMatch[1]) : null,
    confirmedSuggestedSlot: YES_REGEX.test(cleaned),
    extraction: {
      leadName: extractName(cleaned),
      issueSummary: extractIssue(cleaned),
      preferredTimeText: extractPreferredTime(cleaned)
    }
  };
}

export function missingIntakeFields(conversation: ConversationRecord): string[] {
  const missing: string[] = [];
  if (!conversation.lead_name) {
    missing.push("name");
  }
  if (!conversation.issue_summary) {
    missing.push("issue");
  }
  if (!conversation.preferred_time_text) {
    missing.push("availability");
  }
  return missing;
}

export function mergeIntakeFields(
  conversation: ConversationRecord,
  extracted: IntakeExtraction
): ConversationRecord {
  return {
    ...conversation,
    lead_name: conversation.lead_name || extracted.leadName || "",
    issue_summary: conversation.issue_summary || extracted.issueSummary || "",
    preferred_time_text: conversation.preferred_time_text || extracted.preferredTimeText || ""
  };
}

export function missingFieldsPrompt(missing: string[]): string {
  const labels = missing.join(", ");
  return `Thanks. I still need your ${labels}. Please reply with: Name, issue, and best callback times.`;
}
