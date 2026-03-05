import { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../src/config";

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  res.status(200).json({
    ok: true,
    service: "missed-call-sms-booking",
    timezone: config.businessTimezone,
    calendarConfigured: Boolean(config.googleCalendarId),
    sheetConfigured: Boolean(config.googleSheetId),
    webhookSigningConfigured: Boolean(config.openPhoneWebhookSigningSecret),
    unsignedWebhookAllowed: config.allowUnsignedWebhooks
  });
}
