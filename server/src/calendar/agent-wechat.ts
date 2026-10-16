import type { WeclawInboundText } from "../weclaw/manager";
import { wechatTaskSourceRef } from "./agent-tasks";
import { CalendarError } from "./service";
import type { CalendarAgentRuntime } from "./agent-runtime";

/** Explicit transport command; natural language and model text never constitute approval. */
export function resolveCalendarWechatCommand(runtime: CalendarAgentRuntime, message: WeclawInboundText) {
  const command = /^(确认|拒绝)\s+([\w-]+)\s+([\w-]+)\s+([a-f0-9]{12,64})\s*$/u.exec(message.text.trim());
  if (!command) return false;
  const [, verb, taskId, proposalId, digest] = command;
  const task = runtime.tasks.get(taskId);
  if (!task || task.sourceKind !== "wechat" || task.sourceRef !== wechatTaskSourceRef(message.botId, message.senderId)) {
    throw new CalendarError("FORBIDDEN", "confirmation does not belong to this binding", 403);
  }
  const item = runtime.proposals(taskId).find(entry => entry.proposal.id === proposalId);
  if (!item || !item.digest.startsWith(digest)) throw new CalendarError("VERSION_CONFLICT", "confirmation content changed", 409);
  runtime.resolve(taskId, proposalId, item.digest, verb === "确认" ? "approve" : "reject");
  return true;
}
