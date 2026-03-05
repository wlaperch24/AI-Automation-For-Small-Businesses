import { DateTime } from "luxon";
import { config } from "../config";
import { SlotOption } from "../types";

const WEEKDAYS = new Set([1, 2, 3, 4, 5]);

export function nowInBusinessZone(): DateTime {
  return DateTime.now().setZone(config.businessTimezone);
}

export function toIso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? "";
}

export function parseIsoInBusinessZone(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(config.businessTimezone);
}

export function formatSlotLabel(startIso: string): string {
  const local = parseIsoInBusinessZone(startIso);
  const zoneLabel = local.offsetNameShort ?? local.zoneName;
  return `${local.toFormat("ccc LLL d h:mm a")} ${zoneLabel}`;
}

export function isBusinessDay(dt: DateTime): boolean {
  return WEEKDAYS.has(dt.weekday);
}

export function isWithinBusinessHours(dt: DateTime): boolean {
  const hour = dt.hour + dt.minute / 60;
  return hour >= config.businessHourStart && hour < config.businessHourEnd;
}

export function buildCandidateSlots(
  lookaheadDays: number,
  durationMinutes: number
): DateTime[] {
  const now = nowInBusinessZone();
  const startCutoff = now.plus({ minutes: 1 });
  const results: DateTime[] = [];

  for (let dayOffset = 0; dayOffset <= lookaheadDays; dayOffset += 1) {
    const day = now.startOf("day").plus({ days: dayOffset });
    if (!isBusinessDay(day)) {
      continue;
    }

    for (
      let minute = config.businessHourStart * 60;
      minute <= config.businessHourEnd * 60 - durationMinutes;
      minute += durationMinutes
    ) {
      const slotStart = day.plus({ minutes: minute });
      if (slotStart < startCutoff) {
        continue;
      }
      results.push(slotStart);
    }
  }

  return results;
}

function hasOverlap(slotStart: DateTime, durationMinutes: number, busyStart: DateTime, busyEnd: DateTime): boolean {
  const slotEnd = slotStart.plus({ minutes: durationMinutes });
  return slotStart < busyEnd && slotEnd > busyStart;
}

export function filterBusySlots(
  candidateSlots: DateTime[],
  busyWindows: Array<{ start: string; end: string }>,
  durationMinutes: number
): DateTime[] {
  if (busyWindows.length === 0) {
    return candidateSlots;
  }

  const busy = busyWindows
    .map((window) => ({
      start: DateTime.fromISO(window.start, { zone: "utc" }),
      end: DateTime.fromISO(window.end, { zone: "utc" })
    }))
    .filter((window) => window.start.isValid && window.end.isValid);

  return candidateSlots.filter((slot) => {
    const slotUtc = slot.toUTC();
    return !busy.some((window) => hasOverlap(slotUtc, durationMinutes, window.start, window.end));
  });
}

function parsePreferredHour(preference: string): number | null {
  const match = preference.match(/\b(1[0-2]|0?[1-9])(?::([0-5][0-9]))?\s*(am|pm)\b/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  return hour;
}

function scoreDayPreference(slot: DateTime, preferenceLower: string): number {
  let score = 0;
  const weekdayMap: Record<string, number> = {
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5
  };

  if (preferenceLower.includes("today") && slot.hasSame(nowInBusinessZone(), "day")) {
    score += 120;
  }

  if (preferenceLower.includes("tomorrow") && slot.hasSame(nowInBusinessZone().plus({ days: 1 }), "day")) {
    score += 100;
  }

  for (const [token, weekday] of Object.entries(weekdayMap)) {
    if (preferenceLower.includes(token) && slot.weekday === weekday) {
      score += 90;
    }
  }

  return score;
}

function scoreTimePreference(slot: DateTime, preferenceLower: string): number {
  const preferredHour = parsePreferredHour(preferenceLower);
  if (preferredHour === null) {
    return 0;
  }
  return 60 - Math.abs(slot.hour - preferredHour) * 5;
}

export function rankSlotsByPreference(slots: DateTime[], preferredText: string): DateTime[] {
  const normalizedPreference = preferredText.toLowerCase();

  return [...slots].sort((a, b) => {
    const scoreA = scoreDayPreference(a, normalizedPreference) + scoreTimePreference(a, normalizedPreference);
    const scoreB = scoreDayPreference(b, normalizedPreference) + scoreTimePreference(b, normalizedPreference);

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return a.toMillis() - b.toMillis();
  });
}

export function toSlotOptions(slots: DateTime[], durationMinutes: number): SlotOption[] {
  return slots.map((slot) => {
    const startIso = toIso(slot);
    const endIso = toIso(slot.plus({ minutes: durationMinutes }));
    return {
      startIso,
      endIso,
      label: formatSlotLabel(startIso)
    };
  });
}

export function minutesSince(iso: string): number {
  const parsed = DateTime.fromISO(iso, { zone: "utc" });
  if (!parsed.isValid) {
    return Number.POSITIVE_INFINITY;
  }
  return nowInBusinessZone().toUTC().diff(parsed, "minutes").minutes;
}

export function minutesUntil(iso: string): number {
  const parsed = DateTime.fromISO(iso, { zone: "utc" });
  if (!parsed.isValid) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed.diff(nowInBusinessZone().toUTC(), "minutes").minutes;
}
