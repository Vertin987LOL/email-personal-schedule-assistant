import { sendWeclawDirectImage, type WeclawInboundText } from "../weclaw/manager";
import { wechatTaskSourceRef } from "./agent-tasks";
import { CalendarError } from "./service";
import type { CalendarAgentRuntime } from "./agent-runtime";
import {
  parseWeekScheduleCommand,
  renderWeekSchedulePng,
  resolveWeekBounds
} from "./week-image";

export interface CalendarWechatCommandOptions {
  sendImage?: (recipientId: string, image: Buffer) => Promise<unknown>;
  anchorDate?: string | Date;
  now?: string | Date;
}

/** Explicit transport command; natural language and model text never constitute approval. */
export function resolveCalendarWechatCommand(
  runtime: CalendarAgentRuntime,
  message: WeclawInboundText,
  options?: CalendarWechatCommandOptions
): boolean | Promise<boolean> {
  const text = message.text.trim();
  const command = /^(确认|拒绝)\s+([\w-]+)\s+([\w-]+)\s+([a-f0-9]{12,64})\s*$/u.exec(text);
  if (command) {
    const [, verb, taskId, proposalId, digest] = command;
    const task = runtime.tasks.get(taskId);
    if (!task || task.sourceKind !== "wechat" || task.sourceRef !== wechatTaskSourceRef(message.botId, message.senderId)) {
      throw new CalendarError("FORBIDDEN", "confirmation does not belong to this binding", 403);
    }
    const item = runtime.proposals(taskId).find((entry) => entry.proposal.id === proposalId);
    if (!item || !item.digest.startsWith(digest)) {
      throw new CalendarError("VERSION_CONFLICT", "confirmation content changed", 409);
    }
    runtime.resolve(taskId, proposalId, item.digest, verb === "确认" ? "approve" : "reject");
    return true;
  }

  const scheduleCmd = parseWeekScheduleCommand(text);
  if (scheduleCmd.matched) {
    const sendImage = options?.sendImage ?? ((recipientId: string, image: Buffer) => sendWeclawDirectImage(recipientId, image));
    return (async () => {
      const bounds = resolveWeekBounds({
        weekOffset: scheduleCmd.weekOffset,
        anchorDate: options?.anchorDate,
        now: options?.now
      });
      const { events } = runtime.calendar.listEvents(bounds.weekStartIso, bounds.weekEndIso);
      const pngBuffer = await renderWeekSchedulePng(events, {
        weekOffset: scheduleCmd.weekOffset,
        anchorDate: options?.anchorDate,
        now: options?.now,
        onlyConfirmed: scheduleCmd.onlyConfirmed
      });
      await sendImage(message.senderId, pngBuffer);
      return true;
    })();
  }

  return false;
}
