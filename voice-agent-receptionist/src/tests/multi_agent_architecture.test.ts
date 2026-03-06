import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createMultiAgentCoordinator } from "../agents/manager/coordinator";

async function run(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "dotty-agents-"));
  const dbPath = path.join(tempDir, "receptionist.sqlite");
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");

  const coordinator = createMultiAgentCoordinator({
    dbPath,
    schemaPath,
    operatorEmail: "billsplumbingny@gmail.com",
    calendarConfig: {
      timezone: "America/New_York",
      workdayStartHour: 8,
      workdayEndHour: 18,
      saturdayStartHour: 9,
      saturdayEndHour: 14,
      slotDurationHours: 2
    }
  });

  try {
    const availability = coordinator.listAvailability({ urgency: "active_leak" });
    assert.equal(availability.ok, true, "listAvailability should succeed");
    assert.ok(availability.windows.length >= 1, "expected at least one available window");

    const selected = availability.windows[0];
    const booking = coordinator.createAppointment({
      args: {
        name: "Taylor Reed",
        phone: "914-555-0191",
        address: "22 Maple Avenue Rye Brook NY 10573",
        issue: "leak",
        urgency: "active_leak",
        window_start: selected.window_start,
        window_end: selected.window_end,
        notes: "Architecture smoke test"
      }
    });

    assert.equal(booking.ok, true, "createAppointment should succeed");
    assert.equal(typeof booking.appointment_id, "number");
    assert.equal(typeof booking.confirmation_sms_id, "number");
    assert.equal(typeof booking.quote_sms_id, "number");

    const fallbackNextWindowStart = DateTime.fromISO(selected.window_start, { zone: "utc" })
      .plus({ hours: 2 })
      .toISO();
    const fallbackNextWindowEnd = DateTime.fromISO(selected.window_end, { zone: "utc" })
      .plus({ hours: 2 })
      .toISO();
    const nextWindow = availability.windows[1];
    const nextWindowStart = nextWindow?.window_start ?? fallbackNextWindowStart;
    const nextWindowEnd = nextWindow?.window_end ?? fallbackNextWindowEnd;

    assert.ok(nextWindowStart && nextWindowEnd, "expected valid next window timestamps");

    const moved = coordinator.rescheduleAppointment({
      args: {
        appointment_id: booking.appointment_id!,
        new_window_start: nextWindowStart!,
        new_window_end: nextWindowEnd!,
        reason: "Need later slot"
      }
    });

    assert.equal(moved.ok, true, "rescheduleAppointment should succeed");

    const cancelled = coordinator.cancelAppointment({
      args: {
        appointment_id: booking.appointment_id!,
        reason: "Customer cancelled"
      }
    });

    assert.equal(cancelled.ok, true, "cancelAppointment should succeed");

    const followUp = coordinator.createOfficeFollowUp({
      callbackPhone: "914-555-0191",
      note: "Customer requested human callback for final quote.",
      details: {
        source: "test",
        issue: "leak"
      }
    });

    assert.equal(followUp.ok, true, "createOfficeFollowUp should succeed");
    assert.equal(typeof followUp.follow_up_task_id, "number");

    const registry = coordinator.getAgentRegistry();
    assert.ok(registry.includes("dotty_intake"), "registry should include dotty intake agent");
    assert.ok(registry.includes("scheduling"), "registry should include scheduling agent");
    assert.ok(registry.includes("quote_followup"), "registry should include quote follow-up agent");
    assert.ok(registry.includes("callback_ops"), "registry should include callback ops agent");
  } finally {
    coordinator.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error("[TEST ERROR]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
