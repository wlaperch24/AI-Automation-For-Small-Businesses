import { DateTime } from "luxon";
import { CreateAppointmentInput, SqliteLogger } from "./logging";

export interface CalendarConfig {
  timezone: string;
  workdayStartHour: number;
  workdayEndHour: number;
  saturdayStartHour: number;
  saturdayEndHour: number;
  slotDurationHours: number;
}

export interface ListAvailabilityArgs {
  date_range_start?: string;
  date_range_end?: string;
  zip_or_area?: string;
  urgency?: string;
}

export interface AvailabilityWindow {
  window_start: string;
  window_end: string;
  label: string;
  is_priority: boolean;
}

export interface CreateAppointmentArgs {
  name: string;
  phone: string;
  address: string;
  issue: string;
  urgency: string;
  window_start: string;
  window_end: string;
  notes?: string;
}

export interface CancelAppointmentArgs {
  appointment_id: number;
  reason?: string;
}

export interface RescheduleAppointmentArgs {
  appointment_id: number;
  new_window_start: string;
  new_window_end: string;
  reason?: string;
}

function parseDateInZone(value: string | undefined, timezone: string): DateTime | null {
  if (!value) {
    return null;
  }

  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (parsed.isValid) {
    return parsed;
  }

  return null;
}

function toPriority(urgency: string | undefined): boolean {
  if (!urgency) {
    return false;
  }
  return /(active leak|flooding|no water|sewage backup|urgent|emergency)/i.test(urgency);
}

function isAddressLikelyComplete(address: string): boolean {
  const trimmed = address.trim();
  return /\d/.test(trimmed) && /[a-z]/i.test(trimmed) && trimmed.length >= 10;
}

export class LocalCalendarTool {
  constructor(private readonly db: SqliteLogger, private readonly config: CalendarConfig) {}

  formatWindowLabel(windowStartIso: string, windowEndIso: string): string {
    const zone = this.config.timezone;
    const start = DateTime.fromISO(windowStartIso, { zone: "utc" }).setZone(zone);
    const end = DateTime.fromISO(windowEndIso, { zone: "utc" }).setZone(zone);
    return `${start.toFormat("ccc LLL d, h:mm a")} - ${end.toFormat("h:mm a ZZZZ")}`;
  }

  listAvailability(args: ListAvailabilityArgs): { ok: true; windows: AvailabilityWindow[] } | { ok: false; error: string } {
    const zone = this.config.timezone;
    const now = DateTime.now().setZone(zone);
    const start = parseDateInZone(args.date_range_start, zone) ?? now.startOf("day");
    const end = parseDateInZone(args.date_range_end, zone) ?? start.plus({ days: 14 }).endOf("day");

    if (end <= start) {
      return { ok: false, error: "date_range_end must be after date_range_start" };
    }

    const windows: AvailabilityWindow[] = [];
    const priority = toPriority(args.urgency);
    let cursor = start.startOf("day");

    while (cursor <= end.startOf("day") && windows.length < 6) {
      const hours = this.getHoursForDay(cursor.weekday);
      if (hours) {
        let slotStart = cursor.set({ hour: hours.startHour, minute: 0, second: 0, millisecond: 0 });
        const dayEnd = cursor.set({ hour: hours.endHour, minute: 0, second: 0, millisecond: 0 });

        while (slotStart.plus({ hours: this.config.slotDurationHours }) <= dayEnd && windows.length < 6) {
          const slotEnd = slotStart.plus({ hours: this.config.slotDurationHours });

          if (slotStart > now.plus({ minutes: 15 })) {
            const windowStartIso = slotStart.toUTC().toISO();
            const windowEndIso = slotEnd.toUTC().toISO();

            if (windowStartIso && windowEndIso && !this.db.hasAppointmentConflict(windowStartIso, windowEndIso)) {
              windows.push({
                window_start: windowStartIso,
                window_end: windowEndIso,
                label: this.formatWindowLabel(windowStartIso, windowEndIso),
                is_priority: priority
              });
            }
          }

          slotStart = slotStart.plus({ hours: this.config.slotDurationHours });
        }
      }

      cursor = cursor.plus({ days: 1 });
    }

    return { ok: true, windows };
  }

  createAppointment(args: CreateAppointmentArgs):
    | { ok: true; appointment_id: number; window_label: string }
    | { ok: false; error_code: string; message: string } {
    if (!isAddressLikelyComplete(args.address)) {
      return {
        ok: false,
        error_code: "ADDRESS_REQUIRED",
        message: "A full street address is required before booking."
      };
    }

    const start = DateTime.fromISO(args.window_start, { zone: "utc" });
    const end = DateTime.fromISO(args.window_end, { zone: "utc" });

    if (!start.isValid || !end.isValid || end <= start) {
      return {
        ok: false,
        error_code: "INVALID_WINDOW",
        message: "The selected appointment window is invalid."
      };
    }

    if (this.db.hasAppointmentConflict(args.window_start, args.window_end)) {
      return {
        ok: false,
        error_code: "DOUBLE_BOOKED",
        message: "That appointment window is no longer available."
      };
    }

    const payload: CreateAppointmentInput = {
      name: args.name.trim(),
      phone: args.phone.trim(),
      address: args.address.trim(),
      issue: args.issue.trim(),
      urgency: args.urgency.trim(),
      windowStart: args.window_start,
      windowEnd: args.window_end,
      notes: (args.notes ?? "").trim()
    };

    const appointment = this.db.createAppointment(payload);
    return {
      ok: true,
      appointment_id: appointment.id,
      window_label: this.formatWindowLabel(appointment.window_start, appointment.window_end)
    };
  }

  cancelAppointment(args: CancelAppointmentArgs):
    | { ok: true; appointment_id: number; status: string }
    | { ok: false; error_code: string; message: string } {
    const appointment = this.db.getAppointmentById(args.appointment_id);
    if (!appointment) {
      return {
        ok: false,
        error_code: "NOT_FOUND",
        message: `No appointment found for id ${args.appointment_id}.`
      };
    }

    const cancelled = this.db.cancelAppointment(args.appointment_id);
    if (!cancelled) {
      return {
        ok: false,
        error_code: "CANCEL_FAILED",
        message: "Could not cancel appointment."
      };
    }

    return {
      ok: true,
      appointment_id: cancelled.id,
      status: cancelled.status
    };
  }

  rescheduleAppointment(args: RescheduleAppointmentArgs):
    | { ok: true; appointment_id: number; window_label: string }
    | { ok: false; error_code: string; message: string } {
    const appointment = this.db.getAppointmentById(args.appointment_id);
    if (!appointment) {
      return {
        ok: false,
        error_code: "NOT_FOUND",
        message: `No appointment found for id ${args.appointment_id}.`
      };
    }

    const start = DateTime.fromISO(args.new_window_start, { zone: "utc" });
    const end = DateTime.fromISO(args.new_window_end, { zone: "utc" });

    if (!start.isValid || !end.isValid || end <= start) {
      return {
        ok: false,
        error_code: "INVALID_WINDOW",
        message: "The new window is invalid."
      };
    }

    if (this.db.hasAppointmentConflict(args.new_window_start, args.new_window_end, args.appointment_id)) {
      return {
        ok: false,
        error_code: "DOUBLE_BOOKED",
        message: "That new window conflicts with another booked appointment."
      };
    }

    const updated = this.db.rescheduleAppointment(args.appointment_id, args.new_window_start, args.new_window_end);
    if (!updated) {
      return {
        ok: false,
        error_code: "RESCHEDULE_FAILED",
        message: "Could not reschedule appointment."
      };
    }

    return {
      ok: true,
      appointment_id: updated.id,
      window_label: this.formatWindowLabel(updated.window_start, updated.window_end)
    };
  }

  private getHoursForDay(weekday: number): { startHour: number; endHour: number } | null {
    if (weekday >= 1 && weekday <= 5) {
      return {
        startHour: this.config.workdayStartHour,
        endHour: this.config.workdayEndHour
      };
    }

    if (weekday === 6) {
      return {
        startHour: this.config.saturdayStartHour,
        endHour: this.config.saturdayEndHour
      };
    }

    return null;
  }
}
