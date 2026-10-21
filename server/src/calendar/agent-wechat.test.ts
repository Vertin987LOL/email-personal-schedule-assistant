import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CalendarService } from "./service";
import { CalendarAgentRuntime } from "./agent-runtime";
import { resolveCalendarWechatCommand } from "./agent-wechat";
import { createCalendarWeclawInboundHandler } from "../weclaw/weclaw-inbound";

test("M2-02: WeChat schedule image command renders week PNG and sends directly without queueing an Agent task", async () => {
  const calendar = new CalendarService(new DatabaseSync(":memory:"));
  calendar.createEvent("wed-ai", {
    title: "UCAI1003 人工智能素养",
    kind: "course",
    status: "confirmed",
    location: "T29-401",
    sources: [{ kind: "course", ref: "s1" }],
    time: {
      kind: "interval",
      startsAt: "2026-10-21T08:00:00+08:00",
      endsAt: "2026-10-21T09:50:00+08:00",
      timeZone: "Asia/Shanghai"
    }
  });

  const runtime = new CalendarAgentRuntime(calendar);
  const sentImages: Array<{ recipientId: string; buffer: Buffer }> = [];

  const handler = createCalendarWeclawInboundHandler(runtime.tasks, {
    botId: "bot-1",
    recipientId: "user-1",
    onCommand: (message) =>
      resolveCalendarWechatCommand(runtime, message, {
        anchorDate: "2026-10-19T12:00:00+08:00",
        now: "2026-10-19T12:00:00+08:00",
        sendImage: async (recipientId, buffer) => {
          sentImages.push({ recipientId, buffer });
        }
      })
  });

  await handler({
    botId: "bot-1",
    senderId: "user-1",
    messageId: "msg-schedule-1",
    receivedAt: "2026-10-19T12:00:00Z",
    text: "本周课表"
  });

  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].recipientId, "user-1");
  assert.equal(sentImages[0].buffer.subarray(0, 4).toString("hex"), "89504e47");
  assert.equal(runtime.tasks.listQueued(10).length, 0, "must not enqueue an LLM task for image shortcut");

  await handler({
    botId: "bot-1",
    senderId: "user-1",
    messageId: "msg-nl-1",
    receivedAt: "2026-10-19T12:01:00Z",
    text: "帮我看看周四下午有没有空"
  });

  assert.equal(sentImages.length, 1);
  assert.equal(runtime.tasks.listQueued(10).length, 1, "natural language must still enqueue an Agent task");
  await runtime.close();
  calendar.repository.db.close();
});
