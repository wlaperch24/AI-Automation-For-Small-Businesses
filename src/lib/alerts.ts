import nodemailer from "nodemailer";
import { config } from "../config";

function getTransport() {
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });
}

export async function sendAlertEmail(subject: string, textBody: string): Promise<void> {
  const to = config.alertEmailTo;
  const from = config.alertEmailFrom;

  if (!to || !from) {
    console.warn("Alert email skipped. ALERT_EMAIL_TO or ALERT_EMAIL_FROM is not configured.");
    return;
  }

  const transport = getTransport();
  if (!transport) {
    console.warn("Alert email skipped. SMTP settings are not fully configured.");
    return;
  }

  await transport.sendMail({
    from,
    to,
    subject,
    text: textBody
  });
}
