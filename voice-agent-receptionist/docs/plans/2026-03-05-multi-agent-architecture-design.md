# Multi-Agent Architecture Design (Voice Agent Receptionist)

## Goal
Refactor the MVP so each business workflow is isolated in its own agent module, while one manager coordinates everything through shared tools and data.

## Options Considered

1. **Single large orchestrator (status quo plus cleanup)**
- Pros: fast to ship, fewer files
- Cons: hard to scale, one change can break unrelated behavior

2. **Plugin-style agents with one manager (chosen)**
- Pros: modular, easier testing, clean path to n8n/VPS orchestration
- Cons: more files and contracts to maintain

3. **Event bus + independent worker services**
- Pros: highest scale and resilience
- Cons: overkill for current MVP, higher ops complexity

## Chosen Design

Use a **manager + specialist agents** model:

- `dotty_intake`: persona + intake requirements
- `scheduling`: availability, booking, cancel, reschedule
- `quote_followup`: confirmation and quote SMS behavior
- `callback_ops`: human follow-up task creation
- `manager` coordinator: delegates to specialists and returns unified results

All specialists share one runtime context (SQLite logger, calendar tool, SMS tool, quote service, safety service), so data stays consistent and every workflow can access the same state.

## Why This Is Best For This Project

- Keeps current Retell endpoints stable (no dashboard rewiring required).
- Makes each workflow independently replaceable later (Google Calendar, Twilio, n8n workers, etc.).
- Supports your long-term “team of agents” goal without requiring microservices now.

## Validation Plan

- Type-level validation: `npm run typecheck`
- Existing behavior validation: `npm run selftest`
- New architecture validation: `npm run test:multi-agent`
