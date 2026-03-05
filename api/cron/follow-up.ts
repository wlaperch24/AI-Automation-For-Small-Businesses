import { VercelRequest, VercelResponse } from "@vercel/node";
import { getConversationEngine } from "../../src/lib/conversation-engine";
import { isAuthorizedCronRequest } from "../../src/lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!isAuthorizedCronRequest(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const engine = getConversationEngine();
  await engine.initialize();

  const result = await engine.runNoReplyFollowUpJob();
  res.status(200).json({ ok: true, ...result });
}
