# Missed-Call SMS Booking (Vercel + OpenPhone + Google Calendar + Google Sheets)

This project automatically:

1. Sends an instant apology text when you miss a call.
2. Collects name + issue + callback availability by SMS.
3. Checks Google Calendar for open 15-minute slots.
4. Offers callback times and books the selected slot.
5. Sends a 15-minute reminder before the callback.
6. Sends one 15-minute no-reply follow-up.
7. Escalates to manual handling after 6 messages.
8. Sends fallback text + email alert if processing fails.

## Project Endpoints

- `POST /api/webhooks/openphone`
- `GET /api/cron/follow-up`
- `GET /api/cron/pre-call-reminders`
- `GET /api/cron/retries`
- `GET /api/health`

## Quick Setup (Non-Technical Checklist)

## 1) Create Google Sheet for state

1. Create one Google Sheet.
2. Copy the Sheet ID from the URL.
3. Add your Google service account email to the sheet as **Editor**.

The app auto-creates tabs:

- `conversations`
- `event_dedupe`
- `audit_log`
- `alerts`

## 2) Prepare Google Service Account JSON

1. In Google Cloud, create a service account.
2. Enable APIs:
   - Google Sheets API
   - Google Calendar API
3. Create a JSON key and keep it secure.
4. In Google Calendar settings, share your callback calendar (or primary calendar) with the service account email and give it **Make changes to events** permission.

## 3) Configure OpenPhone

1. Keep your business number in OpenPhone.
2. In OpenPhone webhook settings, add:
   - URL: `https://YOUR-VERCEL-DOMAIN/api/webhooks/openphone`
   - Events:
     - `call.completed`
     - `message.received`
3. Copy webhook signing secret (base64 key).

## 4) Set Environment Variables (Vercel)

Use `.env.example` as the template. Required values:

- `OPENPHONE_API_KEY`
- `OPENPHONE_WEBHOOK_SIGNING_SECRET`
- `OPENPHONE_DEFAULT_FROM_NUMBER`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_CALENDAR_ID` (`primary` is fine)
- `CRON_SECRET`
- `ALERT_EMAIL_TO`
- `ALERT_EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

Defaults already match your plan:

- Timezone: `America/New_York`
- Hours: Mon-Fri 9-5
- Duration: 15 minutes
- Follow-up: 15 minutes
- Escalate after 6 messages

## 5) Deploy to Vercel

1. Import this project to Vercel.
2. Add environment variables.
3. Deploy.
4. Open `https://YOUR-VERCEL-DOMAIN/api/health` and confirm `ok: true`.

## 6) Confirm Cron Jobs

`vercel.json` already includes:

- every 5 min: `/api/cron/follow-up`
- every 5 min: `/api/cron/pre-call-reminders`
- every 5 min: `/api/cron/retries`

Vercel runs these automatically after deploy.

## Go-Live Test Script

Run each test once before turning on real traffic:

1. Miss a call -> confirm apology SMS in under 60s.
2. Reply with name/issue/availability -> confirm 3 slot options.
3. Reply `1` -> confirm booking text and Calendar event.
4. Wait near appointment -> confirm 15-minute reminder SMS.
5. Start a conversation then stop replying -> confirm 15-minute follow-up SMS.
6. Reply `STOP` -> confirm opt-out text and no further auto texts.
7. Send same webhook twice -> confirm no duplicate SMS.

## Message Templates

Initial missed-call text:

`Sorry I missed your call. I can book a callback by text right now. Please reply with: 1) your name 2) what issue you need help with 3) times you are available today or next business day (ET). I will confirm a 15-minute slot. Reply STOP to opt out.`

## Notes

- This project is intentionally simple for low monthly cost and low maintenance.
- If you outgrow this setup, you can swap Google Sheets for Supabase later.
