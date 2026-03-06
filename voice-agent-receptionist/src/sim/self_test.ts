import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentSession } from "../agent";
import { loadRuntimeConfig } from "./call_simulator";

interface Scenario {
  name: string;
  turns: string[];
  expectOutcome: string;
  expectAppointments: number;
  expectSms: number;
  expectAddress?: string;
  approveWhenPending: boolean;
}

function readCounts(dbPath: string): { appointments: number; sms: number; outcome: string; bookedAddress?: string } {
  const db = new DatabaseSync(dbPath);
  const appointments = Number((db.prepare("SELECT COUNT(*) as count FROM appointments WHERE status = 'BOOKED'").get() as any).count);
  const sms = Number((db.prepare("SELECT COUNT(*) as count FROM sms_messages").get() as any).count);
  const outcome = String((db.prepare("SELECT outcome FROM call_sessions ORDER BY id DESC LIMIT 1").get() as any).outcome || "");
  const bookedRow = db
    .prepare("SELECT address FROM appointments WHERE status = 'BOOKED' ORDER BY id DESC LIMIT 1")
    .get() as { address?: string } | undefined;
  db.close();
  return {
    appointments,
    sms,
    outcome,
    bookedAddress: bookedRow?.address
  };
}

async function runScenario(index: number, scenario: Scenario): Promise<boolean> {
  const dbPath = path.resolve(process.cwd(), `data/selftest-${index}.sqlite`);
  rmSync(dbPath, { force: true });

  const env = loadRuntimeConfig({
    dbPath,
    forceLocalPlanner: true,
    openaiApiKey: undefined,
    approvalMode: true
  });

  const session = createAgentSession({
    openaiApiKey: env.openaiApiKey,
    textModel: env.textModel,
    realtimeModel: env.realtimeModel,
    realtimeVoice: env.realtimeVoice,
    approvalMode: env.approvalMode,
    operatorEmail: env.operatorEmail,
    dbPath: env.dbPath,
    schemaPath: env.schemaPath,
    forceLocalPlanner: env.forceLocalPlanner,
    calendarConfig: {
      timezone: env.businessTimezone,
      workdayStartHour: env.workdayStartHour,
      workdayEndHour: env.workdayEndHour,
      saturdayStartHour: env.saturdayStartHour,
      saturdayEndHour: env.saturdayEndHour,
      slotDurationHours: env.slotDurationHours
    }
  });

  session.startSession("text");

  try {
    for (const turn of scenario.turns) {
      const result = await session.handleTextTurn(turn);
      console.log(`[CALLER] ${turn}`);
      console.log(`[AGENT] ${result.reply}`);

      if (scenario.approveWhenPending && session.getPendingBooking()) {
        const approval = await session.approvePendingBooking();
        console.log(`[OPERATOR] approve`);
        console.log(`[AGENT] ${approval.message}`);
      }
    }
  } finally {
    session.endSession();
  }

  const counts = readCounts(dbPath);

  const pass =
    counts.outcome === scenario.expectOutcome &&
    counts.appointments === scenario.expectAppointments &&
    counts.sms === scenario.expectSms &&
    (scenario.expectAddress === undefined || counts.bookedAddress === scenario.expectAddress);

  console.log(
    `[SELFTEST] ${scenario.name}: ${pass ? "PASS" : "FAIL"} ` +
      `(outcome=${counts.outcome}, appointments=${counts.appointments}, sms=${counts.sms}, address=${counts.bookedAddress ?? "n/a"})`
  );

  return pass;
}

async function main(): Promise<void> {
  const scenarios: Scenario[] = [
    {
      name: "Non-urgent booking",
      turns: [
        "Hi, my name is Jane Miller. Address is 123 Main Street Brooklyn NY 11201. Callback 917-555-0101.",
        "The kitchen sink is clogged.",
        "It is routine, not urgent.",
        "No safety risk.",
        "1"
      ],
      expectOutcome: "BOOKED",
      expectAppointments: 1,
      expectSms: 2,
      expectAddress: "123 Main Street Brooklyn NY 11201",
      approveWhenPending: true
    },
    {
      name: "Urgent but schedulable",
      turns: [
        "This is Mark Davis. Address 88 Water Street New York NY 10005. Phone 646-555-0199.",
        "I have an active leak under the sink.",
        "This is urgent and flooding a little.",
        "No gas smell and no electrical hazard.",
        "1"
      ],
      expectOutcome: "BOOKED",
      expectAppointments: 1,
      expectSms: 2,
      expectAddress: "88 Water Street New York NY 10005",
      approveWhenPending: true
    },
    {
      name: "Safety risk no scheduling",
      turns: [
        "My name is Luis. Address 14 Pine Street Queens NY 11101. Phone 347-555-0111.",
        "I smell gas by the water heater and I am worried."
      ],
      expectOutcome: "SAFETY_ESCALATED",
      expectAppointments: 0,
      expectSms: 0,
      approveWhenPending: false
    }
  ];

  let passCount = 0;

  for (let i = 0; i < scenarios.length; i += 1) {
    const passed = await runScenario(i + 1, scenarios[i]);
    if (passed) {
      passCount += 1;
    }
    console.log("-");
  }

  if (passCount !== scenarios.length) {
    throw new Error(`Self-test failed: ${passCount}/${scenarios.length} scenarios passed.`);
  }

  console.log(`[SELFTEST] All scenarios passed (${passCount}/${scenarios.length}).`);
}

main().catch((error) => {
  console.error("[ERROR]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
