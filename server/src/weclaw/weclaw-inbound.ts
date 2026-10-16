import {
  setWeclawInboundTextHandler,
  type WeclawInboundText,
  type WeclawInboundTextHandler
} from "./manager";
import {
  CalendarTaskError,
  CalendarTaskStore,
  wechatTaskKey,
  wechatTaskSourceRef
} from "../calendar/agent-tasks";

export type WeclawInboundTaskHandlerOptions = {
  botId: string;
  recipientId: string;
  onCommand?: (message: WeclawInboundText) => boolean | Promise<boolean>;
  onQueued?: () => void | Promise<void>;
};

function supplementCommand(text: string) {
  const match = /^\s*补充\s+(\S+)(?:\s+([\s\S]*?))?\s*$/u.exec(text);
  if (!match || !match[2]?.trim()) return undefined;
  return { taskId: match[1], text: match[2].trim() };
}

function explicitCommand(text: string) {
  return /^\s*(?:确认|拒绝|补充)(?:\s|$)/u.test(text);
}

function rejectionCode(error: unknown) {
  if (error instanceof CalendarTaskError) return `inbound_rejected:${error.code}`;
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown } | undefined;
  const code = value && (value.code ?? value.statusCode ?? value.status);
  const normalized = String(code ?? "").trim().toUpperCase();
  if (normalized === "403" || normalized === "FORBIDDEN") return "inbound_rejected:forbidden";
  if (normalized === "409" || normalized === "CONFLICT") return "inbound_rejected:conflict";
  if (normalized === "400" || normalized === "INVALID_INPUT") return "inbound_rejected:invalid_input";
  if (normalized === "404" || normalized === "NOT_FOUND") return "inbound_rejected:not_found";
  return undefined;
}

async function persistRejectedTask(
  store: CalendarTaskStore,
  message: WeclawInboundText,
  sourceRef: string,
  error: unknown
) {
  const sourceKey = wechatTaskKey(message.botId, message.senderId, `${message.messageId}:rejected`);
  const task = store.create({
    sourceKey,
    sourceKind: "wechat",
    sourceRef,
    text: message.text
  });
  store.update(task.id, {
    state: "failed",
    error: rejectionCode(error) ?? "inbound_rejected:command"
  });
}

function boundSourceRef(message: WeclawInboundText) {
  return wechatTaskSourceRef(message.botId, message.senderId);
}

async function queueIfNeeded(options: WeclawInboundTaskHandlerOptions, wasNew: boolean) {
  if (wasNew) await options.onQueued?.();
}

export function createCalendarWeclawInboundHandler(
  store: CalendarTaskStore,
  options: WeclawInboundTaskHandlerOptions
): WeclawInboundTextHandler {
  return async (message) => {
    if (message.botId !== options.botId || message.senderId !== options.recipientId) return;
    const sourceRef = boundSourceRef(message);
    try {
      if (options.onCommand && await options.onCommand(message)) return;

      const supplement = supplementCommand(message.text);
      if (supplement) {
        const current = store.get(supplement.taskId);
        if (!current) throw new CalendarTaskError("NOT_FOUND", "task does not exist");
        if (current.sourceRef !== sourceRef) {
          throw new CalendarTaskError("OWNER_MISMATCH", "task belongs to another WeChat binding");
        }
        const inputKey = wechatTaskKey(message.botId, message.senderId, message.messageId);
        const updated = store.addInput(current.id, { inputKey, text: supplement.text });
        if (updated && updated.inputs.length > current.inputs.length) {
          await queueIfNeeded(options, true);
        }
        return;
      }

      if (explicitCommand(message.text)) {
        throw new CalendarTaskError("INVALID_INPUT", "unsupported or incomplete command");
      }

      const sourceKey = wechatTaskKey(message.botId, message.senderId, message.messageId);
      const existing = store.getBySourceKey(sourceKey);
      store.create({
        sourceKey,
        sourceKind: "wechat",
        sourceRef,
        text: message.text
      });
      await queueIfNeeded(options, !existing);
    } catch (error) {
      if (!rejectionCode(error)) throw error;
      await persistRejectedTask(store, message, sourceRef, error);
    }
  };
}

export function bindCalendarWeclawInboundTaskStore(
  store: CalendarTaskStore,
  options: WeclawInboundTaskHandlerOptions
) {
  const handler = createCalendarWeclawInboundHandler(store, options);
  setWeclawInboundTextHandler(handler);
  return handler;
}

// Short alias for callers wiring the local WeChat task channel.
export const createWeclawInboundTaskHandler = createCalendarWeclawInboundHandler;

