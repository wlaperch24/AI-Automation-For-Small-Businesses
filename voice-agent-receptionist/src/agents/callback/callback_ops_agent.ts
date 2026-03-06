import { SqliteLogger } from "../../tools/logging";
import { AgentDescriptor } from "../contracts";

export interface CallbackTaskInput {
  sessionId?: number;
  callbackPhone?: string;
  note: string;
  details: Record<string, unknown>;
  assignee?: string;
}

export class CallbackOpsAgent {
  readonly descriptor: AgentDescriptor = {
    id: "callback_ops",
    name: "Callback Operations Agent",
    purpose: "Owns office follow-up task creation for human-in-the-loop callbacks.",
    owns: ["follow_up_tasks", "manual_handoff"]
  };

  constructor(private readonly db: SqliteLogger, private readonly defaultAssignee: string) {}

  createOfficeFollowUp(input: CallbackTaskInput): { ok: true; follow_up_task_id: number } {
    const followUpTaskId = this.db.createFollowUpTask({
      sessionId: input.sessionId,
      taskType: "CALLBACK_REQUIRED",
      status: "OPEN",
      assignee: input.assignee ?? this.defaultAssignee,
      callbackPhone: input.callbackPhone,
      note: input.note,
      detailsJson: JSON.stringify(input.details),
      dueAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

    return {
      ok: true,
      follow_up_task_id: followUpTaskId
    };
  }
}

