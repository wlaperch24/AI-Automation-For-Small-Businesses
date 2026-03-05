import { google } from "googleapis";
import { config, requireConfigValue } from "../config";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

function getCredentials(): ServiceAccountCredentials {
  const raw = requireConfigValue(config.googleServiceAccountJson, "GOOGLE_SERVICE_ACCOUNT_JSON");
  const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key
  };
}

function buildAuth(scopes: string[]) {
  const creds = getCredentials();
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes
  });
}

export function getSheetsClient() {
  return google.sheets({
    version: "v4",
    auth: buildAuth([SHEETS_SCOPE])
  });
}

export function getCalendarClient() {
  return google.calendar({
    version: "v3",
    auth: buildAuth([CALENDAR_SCOPE])
  });
}
