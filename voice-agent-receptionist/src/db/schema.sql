PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS call_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  caller_phone TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  approval_mode INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  to_number TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  issue TEXT NOT NULL,
  urgency TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BOOKED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  callback_phone TEXT,
  note TEXT NOT NULL,
  details_json TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_window ON appointments(window_start, window_end, status);
CREATE INDEX IF NOT EXISTS idx_call_turns_session ON call_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_messages_session ON sms_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_session ON follow_up_tasks(session_id, created_at);
