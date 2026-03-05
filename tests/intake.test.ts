import { describe, expect, it } from "vitest";
import { parseInboundMessage } from "../src/lib/intake";

describe("parseInboundMessage", () => {
  it("extracts command STOP", () => {
    const parsed = parseInboundMessage("STOP");
    expect(parsed.command).toBe("STOP");
  });

  it("extracts slot choice", () => {
    const parsed = parseInboundMessage("2");
    expect(parsed.slotChoice).toBe(2);
  });

  it("extracts rough intake fields", () => {
    const parsed = parseInboundMessage("My name is Alex. I need help with payroll setup. Tomorrow at 2pm works best.");
    expect(parsed.extraction.leadName).toBeTruthy();
    expect(parsed.extraction.issueSummary).toContain("payroll");
    expect(parsed.extraction.preferredTimeText).toContain("Tomorrow");
  });
});
