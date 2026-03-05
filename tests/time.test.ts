import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { rankSlotsByPreference, toSlotOptions } from "../src/lib/time";

describe("slot ranking", () => {
  it("prioritizes preferred hour", () => {
    const base = DateTime.fromISO("2026-02-23T13:00:00", { zone: "America/New_York" });
    const slots = [
      base.set({ hour: 10 }),
      base.set({ hour: 14 }),
      base.set({ hour: 16 })
    ];

    const ranked = rankSlotsByPreference(slots, "2pm");
    const options = toSlotOptions(ranked, 15);

    expect(options[0].label.toLowerCase()).toContain("2:00 pm");
  });
});
