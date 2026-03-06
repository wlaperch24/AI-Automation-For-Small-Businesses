import { CalendarConfig, LocalCalendarTool } from "../tools/calendar";
import { SqliteLogger } from "../tools/logging";
import { SimulatedSmsTool } from "../tools/sms";
import { QuoteService } from "../services/quote";
import { SafetyService } from "../services/safety";

export interface MultiAgentRuntime {
  db: SqliteLogger;
  calendar: LocalCalendarTool;
  sms: SimulatedSmsTool;
  quoteService: QuoteService;
  safetyService: SafetyService;
  operatorEmail: string;
}

export interface MultiAgentRuntimeConfig {
  dbPath: string;
  schemaPath: string;
  operatorEmail: string;
  calendarConfig: CalendarConfig;
}

export function createMultiAgentRuntime(config: MultiAgentRuntimeConfig): MultiAgentRuntime {
  const db = new SqliteLogger(config.dbPath, config.schemaPath);
  const calendar = new LocalCalendarTool(db, config.calendarConfig);
  const sms = new SimulatedSmsTool(db);
  const quoteService = new QuoteService();
  const safetyService = new SafetyService();

  return {
    db,
    calendar,
    sms,
    quoteService,
    safetyService,
    operatorEmail: config.operatorEmail
  };
}

