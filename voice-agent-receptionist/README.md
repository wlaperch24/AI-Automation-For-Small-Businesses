# Voice Agent Receptionist (Plumbing MVP)

Local MVP that simulates a plumbing receptionist with:

- OpenAI agent orchestration + tool calling
- Local business calendar (SQLite)
- Simulated SMS confirmations + quote follow-up SMS
- Approval mode (`approve` required before booking/SMS when enabled)
- Full call/tool logging in SQLite
- Text and voice simulator modes
- Voice call budget guardrails (wrap-up + hard stop timer)
- Multi-agent manager architecture (shared runtime + specialist agents)

## What This MVP Does

1. Greets caller and collects name, full address, callback number.
2. Qualifies issue, urgency, and safety risk.
3. Stops scheduling for safety-risk cases (gas smell/immediate danger).
4. Pulls available 2-hour windows from local calendar rules.
5. Books selected window (with approval gate if enabled).
6. Sends simulated SMS confirmation + quote follow-up.
7. Logs sessions, turns, tools, appointments, and SMS in SQLite.

## Prerequisites

- Node.js 20+
- npm
- For voice mode: SoX installed

macOS SoX install:

```bash
brew install sox
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Run Commands

- Interactive mode selector:

```bash
npm run dev
```

- Text simulator only:

```bash
npm run dev:text
```

- Voice simulator (mic + speaker):

```bash
npm run dev:voice
```

- Retell bridge server (webhook + tool endpoints):

```bash
npm run dev:retell
```

- Self-test scenarios:

```bash
npm run selftest
```

- Multi-agent architecture smoke test:

```bash
npm run test:multi-agent
```

- Type check:

```bash
npm run typecheck
```

## Environment Variables

See `.env.example`.

Key fields:

- `OPENAI_API_KEY`
- `OPENAI_TEXT_MODEL`
- `OPENAI_REALTIME_MODEL`
- `OPENAI_REALTIME_VOICE`
- `APPROVAL_MODE=true|false`
- `BUSINESS_TIMEZONE`
- `WORKDAY_START_HOUR`, `WORKDAY_END_HOUR`
- `SATURDAY_START_HOUR`, `SATURDAY_END_HOUR`
- `SLOT_DURATION_HOURS`
- `DB_PATH`
- `VOICE_WRAPUP_SECONDS` (default `212` = 3:32)
- `VOICE_HARD_MAX_SECONDS` (default `288` = 4:48)
- `RETELL_API_KEY`
- `RETELL_WEBHOOK_SECRET`
- `RETELL_AGENT_ID`
- `RETELL_PORT` (default `3001`)

Future stubs (not wired in Phase A):

- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`
- `OPERATOR_ALERT_EMAIL`

## Retell Integration (ASAP Path)

1. Add Retell keys in `.env`:
   - `RETELL_API_KEY`
   - `RETELL_WEBHOOK_SECRET`
   - `RETELL_AGENT_ID`
2. Start the bridge:
   - `npm run dev:retell`
3. Expose local server:
   - `ngrok http 3001`
4. In Retell dashboard, configure function/tool URLs:
   - `POST {YOUR_URL}/retell/tools/listAvailability`
   - `POST {YOUR_URL}/retell/tools/createAppointment`
   - `POST {YOUR_URL}/retell/tools/cancelAppointment`
   - `POST {YOUR_URL}/retell/tools/rescheduleAppointment`
   - `POST {YOUR_URL}/retell/tools/getCallTimer`
5. Configure webhook URL:
   - `POST {YOUR_URL}/retell/webhook`
6. Health check endpoint:
   - `GET {YOUR_URL}/health`

## Approval Mode Behavior

If `APPROVAL_MODE=true`:

- Agent proposes booking details first.
- CLI waits for operator command:
  - `approve` to create appointment + send confirmation and quote SMS
  - `reject` to decline booking

## Multi-Agent Architecture

The project now uses a manager + specialist agent structure:

- `dotty_intake` (persona + intake requirements)
- `scheduling` (availability, booking, cancel, reschedule)
- `quote_followup` (confirmation and quote SMS)
- `callback_ops` (office manager follow-up task creation)
- `manager` coordinator (delegates tasks across agents)

Code location:

- `/Users/williamlaperch/Documents/GitHub/AI Automation for Small Business/voice-agent-receptionist/src/agents`

Why this matters:

- You can add future agents without rewriting the whole call flow.
- If one workflow changes (for example quotes), scheduling logic stays isolated.
- This maps cleanly to future n8n/VPS orchestration.

## Voice Call Time Limits

- At `3:32` (default), the agent shifts to wrap-up mode and prioritizes:
  - identifying issue
  - locking an appointment
  - collecting missing critical details
- At `4:48` (default), the call is forcibly ended.
- If booking/details are still incomplete at hard stop, the app creates a follow-up callback task for the office manager in SQLite (`follow_up_tasks` table).
- Retell bridge exposes `getCallTimer`, which returns:
  - `elapsed_seconds`
  - `should_wrap`
  - `should_end`
  so your Retell prompt can make deterministic wrap/end decisions.
- Optional request arg for timer resets:
  - `checkpoint` values: `first_turn`, `call_start`, or `reset`
  - When provided, timer baseline is reset for that call id.

## Text Mode Operator Commands

- `/help`
- `/appointments`
- `/cancel <appointment_id>`
- `/rebook <appointment_id>`
- `/rebook <appointment_id> <option_number>`

## SQLite Data

Database file defaults to `./data/receptionist.sqlite`.

Tables:

- `call_sessions`
- `call_turns`
- `tool_events`
- `appointments`
- `sms_messages`

## Example Conversations

### 1) Non-urgent booking

- Caller: "My name is Jane... 123 Main Street... 917-555-0101"
- Agent: collects details + asks issue/urgency/safety
- Caller picks slot `1`
- Operator types `approve`
- Agent confirms booking + confirmation+quote SMS simulated and logged

### 2) Urgent but schedulable

- Caller: active leak/flooding, no safety risk
- Agent offers earliest windows
- Caller picks slot
- Operator approves
- Booking + confirmation+quote SMS logged with urgent metadata

### 3) Safety-risk gas smell

- Caller mentions gas smell/immediate danger
- Agent advises emergency services/gas company
- No appointment is created

## Notes for Phase B (Phone Integration)

This MVP is adapter-friendly:

- Keep calendar logic behind `src/tools/calendar.ts`
- Keep SMS behind `src/tools/sms.ts`
- Keep orchestration in `src/agent.ts`

To move to phone calls later:

1. Add telephony transport (Twilio media streams, SIP, or managed platform).
2. Replace simulated SMS with Twilio in `src/tools/sms.ts`.
3. Swap local calendar with Google Calendar adapter while preserving tool contracts.
