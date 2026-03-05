import { z } from "zod";

const envSchema = z.object({
  OPENPHONE_API_KEY: z.string().optional(),
  OPENPHONE_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  OPENPHONE_DEFAULT_FROM_NUMBER: z.string().optional(),
  OPENPHONE_API_BASE_URL: z.string().default("https://api.openphone.com/v1"),

  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  BUSINESS_TIMEZONE: z.string().default("America/New_York"),
  BUSINESS_HOUR_START: z.string().default("9"),
  BUSINESS_HOUR_END: z.string().default("17"),
  CALL_DURATION_MINUTES: z.string().default("15"),
  FOLLOW_UP_AFTER_MINUTES: z.string().default("15"),
  ESCALATE_AFTER_MESSAGES: z.string().default("6"),
  SLOT_LOOKAHEAD_DAYS: z.string().default("7"),

  CRON_SECRET: z.string().optional(),
  ALLOW_UNSIGNED_WEBHOOKS: z.string().default("false"),
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.string().default("300"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default("587"),
  SMTP_SECURE: z.string().default("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),

  APP_BASE_URL: z.string().optional()
});

const parsed = envSchema.parse(process.env);

export const config = {
  openPhoneApiKey: parsed.OPENPHONE_API_KEY,
  openPhoneWebhookSigningSecret: parsed.OPENPHONE_WEBHOOK_SIGNING_SECRET,
  openPhoneDefaultFromNumber: parsed.OPENPHONE_DEFAULT_FROM_NUMBER,
  openPhoneApiBaseUrl: parsed.OPENPHONE_API_BASE_URL,

  googleSheetId: parsed.GOOGLE_SHEET_ID,
  googleCalendarId: parsed.GOOGLE_CALENDAR_ID,
  googleServiceAccountJson: parsed.GOOGLE_SERVICE_ACCOUNT_JSON,

  businessTimezone: parsed.BUSINESS_TIMEZONE,
  businessHourStart: Number(parsed.BUSINESS_HOUR_START),
  businessHourEnd: Number(parsed.BUSINESS_HOUR_END),
  callDurationMinutes: Number(parsed.CALL_DURATION_MINUTES),
  followUpAfterMinutes: Number(parsed.FOLLOW_UP_AFTER_MINUTES),
  escalateAfterMessages: Number(parsed.ESCALATE_AFTER_MESSAGES),
  slotLookaheadDays: Number(parsed.SLOT_LOOKAHEAD_DAYS),

  cronSecret: parsed.CRON_SECRET,
  allowUnsignedWebhooks: parsed.ALLOW_UNSIGNED_WEBHOOKS.toLowerCase() === "true",
  webhookTimestampToleranceSeconds: Number(parsed.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS),

  smtpHost: parsed.SMTP_HOST,
  smtpPort: Number(parsed.SMTP_PORT),
  smtpSecure: parsed.SMTP_SECURE.toLowerCase() === "true",
  smtpUser: parsed.SMTP_USER,
  smtpPass: parsed.SMTP_PASS,
  alertEmailFrom: parsed.ALERT_EMAIL_FROM,
  alertEmailTo: parsed.ALERT_EMAIL_TO,

  appBaseUrl: parsed.APP_BASE_URL
};

export function requireConfigValue(value: string | undefined, keyName: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${keyName}`);
  }
  return value;
}
