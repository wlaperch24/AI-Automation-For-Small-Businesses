import { VercelRequest } from "@vercel/node";
import { config } from "../config";

export async function readRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === "string") {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req
      .on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      })
      .on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

export function isAuthorizedCronRequest(req: VercelRequest): boolean {
  const expected = config.cronSecret;
  if (expected) {
    const authorization = req.headers.authorization;
    return authorization === `Bearer ${expected}`;
  }

  const vercelCronHeader = req.headers["x-vercel-cron"];
  if (typeof vercelCronHeader === "string") {
    return vercelCronHeader === "1";
  }

  return process.env.VERCEL_ENV !== "production";
}
