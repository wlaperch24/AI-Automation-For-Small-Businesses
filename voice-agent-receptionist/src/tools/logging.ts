import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SessionMode = "text" | "voice";

export interface CreateCallSessionInput {
  mode: SessionMode;
  callerPhone?: string;
  approvalMode: boolean;
}

export interface CreateAppointmentInput {
  name: string;
  phone: string;
  address: string;
  issue: string;
  urgency: string;
  windowStart: string;
  windowEnd: string;
  notes: string;
}

export interface AppointmentRecord {
  id: number;
  name: string;
  phone: string;
  address: string;
  issue: string;
  urgency: string;
  window_start: string;
  window_end: string;
  notes: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateFollowUpTaskInput {
  sessionId?: number;
  taskType: string;
  status: string;
  assignee?: string;
  callbackPhone?: string;
  note: string;
  detailsJson: string;
  dueAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

export class SqliteLogger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, schemaPath: string) {
    const normalizedDbPath = normalizePath(dbPath);
    mkdirSync(path.dirname(normalizedDbPath), { recursive: true });

    this.db = new DatabaseSync(normalizedDbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");

    const schemaSql = readFileSync(normalizePath(schemaPath), "utf8");
    this.db.exec(schemaSql);
  }

  close(): void {
    this.db.close();
  }

  createCallSession(input: CreateCallSessionInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO call_sessions (mode, caller_phone, started_at, approval_mode)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(input.mode, input.callerPhone ?? "", nowIso(), input.approvalMode ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  endCallSession(sessionId: number, outcome: string): void {
    const stmt = this.db.prepare(`
      UPDATE call_sessions
      SET ended_at = ?, outcome = ?
      WHERE id = ?
    `);

    stmt.run(nowIso(), outcome, sessionId);
  }

  logTurn(sessionId: number, speaker: "caller" | "agent" | "system", content: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO call_turns (session_id, speaker, content, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(sessionId, speaker, content, nowIso());
  }

  logToolEvent(input: {
    sessionId?: number;
    toolName: string;
    argumentsJson: string;
    resultJson: string;
    status: "ok" | "error";
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_events (session_id, tool_name, arguments_json, result_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(input.sessionId ?? null, input.toolName, input.argumentsJson, input.resultJson, input.status, nowIso());
  }

  logSms(sessionId: number | undefined, to: string, message: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO sms_messages (session_id, to_number, message, created_at)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(sessionId ?? null, to, message, nowIso());
    return Number(result.lastInsertRowid);
  }

  createFollowUpTask(input: CreateFollowUpTaskInput): number {
    const createdAt = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO follow_up_tasks (
        session_id,
        task_type,
        status,
        assignee,
        callback_phone,
        note,
        details_json,
        due_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.sessionId ?? null,
      input.taskType,
      input.status,
      input.assignee ?? null,
      input.callbackPhone ?? null,
      input.note,
      input.detailsJson,
      input.dueAt ?? null,
      createdAt,
      createdAt
    );

    return Number(result.lastInsertRowid);
  }

  hasAppointmentConflict(windowStart: string, windowEnd: string, excludeAppointmentId?: number): boolean {
    if (excludeAppointmentId) {
      const stmt = this.db.prepare(`
        SELECT id
        FROM appointments
        WHERE status = 'BOOKED'
          AND id != ?
          AND window_start < ?
          AND window_end > ?
        LIMIT 1
      `);
      return Boolean(stmt.get(excludeAppointmentId, windowEnd, windowStart));
    }

    const stmt = this.db.prepare(`
      SELECT id
      FROM appointments
      WHERE status = 'BOOKED'
        AND window_start < ?
        AND window_end > ?
      LIMIT 1
    `);

    return Boolean(stmt.get(windowEnd, windowStart));
  }

  createAppointment(input: CreateAppointmentInput): AppointmentRecord {
    const createdAt = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO appointments (
        name,
        phone,
        address,
        issue,
        urgency,
        window_start,
        window_end,
        notes,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED', ?, ?)
      RETURNING id, name, phone, address, issue, urgency, window_start, window_end, notes, status, created_at, updated_at
    `);

    return stmt.get(
      input.name,
      input.phone,
      input.address,
      input.issue,
      input.urgency,
      input.windowStart,
      input.windowEnd,
      input.notes,
      createdAt,
      createdAt
    ) as unknown as AppointmentRecord;
  }

  getAppointmentById(appointmentId: number): AppointmentRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, name, phone, address, issue, urgency, window_start, window_end, notes, status, created_at, updated_at
      FROM appointments
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(appointmentId) as AppointmentRecord | undefined) ?? null;
  }

  cancelAppointment(appointmentId: number): AppointmentRecord | null {
    const stmt = this.db.prepare(`
      UPDATE appointments
      SET status = 'CANCELLED', updated_at = ?
      WHERE id = ?
      RETURNING id, name, phone, address, issue, urgency, window_start, window_end, notes, status, created_at, updated_at
    `);

    return (stmt.get(nowIso(), appointmentId) as AppointmentRecord | undefined) ?? null;
  }

  rescheduleAppointment(appointmentId: number, newWindowStart: string, newWindowEnd: string): AppointmentRecord | null {
    const stmt = this.db.prepare(`
      UPDATE appointments
      SET window_start = ?, window_end = ?, status = 'BOOKED', updated_at = ?
      WHERE id = ?
      RETURNING id, name, phone, address, issue, urgency, window_start, window_end, notes, status, created_at, updated_at
    `);

    return (stmt.get(newWindowStart, newWindowEnd, nowIso(), appointmentId) as AppointmentRecord | undefined) ?? null;
  }

  listAppointments(): AppointmentRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, name, phone, address, issue, urgency, window_start, window_end, notes, status, created_at, updated_at
      FROM appointments
      ORDER BY id ASC
    `);

    return stmt.all() as unknown as AppointmentRecord[];
  }
}
