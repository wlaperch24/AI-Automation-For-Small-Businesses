import { calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import { config } from "../config";
import { getCalendarClient } from "./google";
import { buildCandidateSlots, filterBusySlots, rankSlotsByPreference, toSlotOptions } from "./time";
import { SlotOption } from "../types";

export class CalendarService {
  private readonly calendarId: string;
  private readonly calendar: calendar_v3.Calendar;

  constructor() {
    this.calendarId = config.googleCalendarId;
    this.calendar = getCalendarClient();
  }

  async getOpenSlots(preferredText: string, limit = 3): Promise<SlotOption[]> {
    const candidateLocal = buildCandidateSlots(config.slotLookaheadDays, config.callDurationMinutes);

    if (candidateLocal.length === 0) {
      return [];
    }

    const timeMin = candidateLocal[0].toUTC().toISO();
    const timeMax = candidateLocal[candidateLocal.length - 1]
      .plus({ minutes: config.callDurationMinutes })
      .toUTC()
      .toISO();

    if (!timeMin || !timeMax) {
      return [];
    }

    const busyResponse = await this.calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: "UTC",
        items: [{ id: this.calendarId }]
      }
    });

    const busy = busyResponse.data.calendars?.[this.calendarId]?.busy ?? [];

    const freeSlots = filterBusySlots(candidateLocal, busy as Array<{ start: string; end: string }>, config.callDurationMinutes);
    const ranked = preferredText ? rankSlotsByPreference(freeSlots, preferredText) : freeSlots;

    return toSlotOptions(ranked.slice(0, limit), config.callDurationMinutes);
  }

  async isSlotStillFree(slot: SlotOption): Promise<boolean> {
    const busyResponse = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: slot.startIso,
        timeMax: slot.endIso,
        timeZone: "UTC",
        items: [{ id: this.calendarId }]
      }
    });

    const busy = busyResponse.data.calendars?.[this.calendarId]?.busy ?? [];
    return busy.length === 0;
  }

  async createCallbackEvent(input: {
    slot: SlotOption;
    leadName: string;
    issueSummary: string;
    phone: string;
  }): Promise<string> {
    const event = await this.calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: `Callback - ${input.leadName || input.phone}`,
        description: [`Phone: ${input.phone}`, `Issue: ${input.issueSummary || "N/A"}`].join("\n"),
        start: {
          dateTime: input.slot.startIso,
          timeZone: "UTC"
        },
        end: {
          dateTime: input.slot.endIso,
          timeZone: "UTC"
        }
      }
    });

    const eventId = event.data.id;
    if (!eventId) {
      throw new Error("Google Calendar did not return an event id");
    }
    return eventId;
  }

  async getEarliestSlotTodayOrNextBusinessDay(): Promise<SlotOption | null> {
    const today = DateTime.now().setZone(config.businessTimezone).toFormat("yyyy-MM-dd");
    const preferred = `today ${today}`;
    const slots = await this.getOpenSlots(preferred, 1);
    return slots[0] ?? null;
  }
}

let singleton: CalendarService | null = null;

export function getCalendarService(): CalendarService {
  if (!singleton) {
    singleton = new CalendarService();
  }
  return singleton;
}
