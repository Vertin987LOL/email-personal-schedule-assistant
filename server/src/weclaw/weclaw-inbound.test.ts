import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CalendarTaskStore } from "../calendar/agent-tasks";
import {
  createCalendarWeclawInboundHandler,
  type WeclawInboundTaskHandlerOptions
} from "./weclaw-inbound";
import {
  deriveWeclawInboundMessageId,
  processWeclawInboundBatch,
  type WeclawInboundText
} from "./manager";

function message(overrides: Record<string, unknown> = {}) {
  return {
    message_type: 1,
    message_state: 2,
    from_user_id: "user-1",
    item_list: [{ type: 1, text_item: { text: "安排会议" } }],
    ...overrides
  };
}

test("inbound batch filters strangers and gives ID-less messages a stable identity", async () => {
  const events: WeclawInboundText[] = [];
  const input = message();
  const first = await processWeclawInboundBatch(
    [input, { ...input }, message({ from_user_id: "stranger" }), message({ message_state: 1 })],
    { botId: "bot-1", recipientId: "user-1" },
    async (event) => { events.push(event); }
  );

  assert.equal(first.length, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0].messageId, events[1].messageId);
  assert.match(events[0].messageId, /^sha256:/u);
  assert.equal(deriveWeclawInboundMessageId(input, "bot-1", "user-1", "安排会议"), events[0].messageId);
  const differentTime = await processWeclawInboundBatch(
    [message({ create_time: 100 }), message({ create_time: 101 })],
    { botId: "bot-1", recipientId: "user-1" },
    async (event) => { events.push(event); }
  );
  assert.notEqual(differentTime[0].messageId, differentTime[1].messageId);
});

test("a failing inbound persistence handler aborts the batch before later messages", async () => {
  const seen: string[] = [];
  await assert.rejects(
    processWeclawInboundBatch(
      [message(), message({ item_list: [{ type: 1, text_item: { text: "第二条" } }] })],
      { botId: "bot-1", recipientId: "user-1" },
      async (event) => {
        seen.push(event.text);
        if (seen.length === 1) throw new Error("storage unavailable");
      }
    ),
    /storage unavailable/u
  );
  assert.deepEqual(seen, ["安排会议"]);
});

test("bound WeChat input creates and supplements owner-bound tasks idempotently", async () => {
  const store = new CalendarTaskStore(new DatabaseSync(":memory:"));
  let queued = 0;
  const options: WeclawInboundTaskHandlerOptions = {
    botId: "bot-1",
    recipientId: "user-1",
    onQueued: () => { queued += 1; }
  };
  const handler = createCalendarWeclawInboundHandler(store, options);
  const first: WeclawInboundText = {
    botId: "bot-1", senderId: "user-1", messageId: "message-1", text: "建立课程", receivedAt: "2026-10-16T00:00:00.000Z"
  };
  await handler(first);
  await handler(first);
  assert.equal(store.list().length, 1);
  assert.equal(queued, 1);
  const task = store.list()[0];
  assert.equal(task.sourceRef, "wechat:bot-1:user-1");

  await handler({ ...first, messageId: "message-2", text: `补充 ${task.id} 周五下午` });
  assert.equal(store.get(task.id)?.inputs.length, 1);
  assert.equal(queued, 2);
});

test("message source keys isolate the same protocol ID across bindings", async () => {
  const store = new CalendarTaskStore(new DatabaseSync(":memory:"));
  const first = createCalendarWeclawInboundHandler(store, { botId: "bot-1", recipientId: "user-1" });
  const second = createCalendarWeclawInboundHandler(store, { botId: "bot-2", recipientId: "user-1" });
  const input = { botId: "bot-1", senderId: "user-1", messageId: "same-id", text: "相同内容", receivedAt: "2026-10-16T00:00:00.000Z" };
  await first(input);
  await second({ ...input, botId: "bot-2" });
  const tasks = store.list();
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].sourceKey, tasks[1].sourceKey);
});

test("supplement cannot cross a WeChat binding and commands can be consumed by the root", async () => {
  const store = new CalendarTaskStore(new DatabaseSync(":memory:"));
  const task = store.create({ sourceKey: "seed", sourceKind: "wechat", sourceRef: "wechat:bot-1:user-1", text: "原任务" });
  const handler = createCalendarWeclawInboundHandler(store, {
    botId: "bot-1",
    recipientId: "user-2"
  });
  await handler({ botId: "bot-1", senderId: "user-2", messageId: "message-3", text: `补充 ${task.id} 越权`, receivedAt: "2026-10-16T00:00:00.000Z" });
  assert.equal(store.list().filter((item) => item.state === "failed").length, 1);

  let commands = 0;
  const commandHandler = createCalendarWeclawInboundHandler(store, {
    botId: "bot-1",
    recipientId: "user-1",
    onCommand: () => { commands += 1; return true; }
  });
  await commandHandler({ botId: "bot-1", senderId: "user-1", messageId: "command-1", text: "确认 proposal digest", receivedAt: "2026-10-16T00:00:00.000Z" });
  assert.equal(commands, 1);
  assert.equal(store.get("command-1"), undefined);
});

test("invalid commands become failed records without blocking later messages", async () => {
  const store = new CalendarTaskStore(new DatabaseSync(":memory:"));
  let queued = 0;
  const handler = createCalendarWeclawInboundHandler(store, {
    botId: "bot-1",
    recipientId: "user-1",
    onCommand: (message) => {
      if (message.text.startsWith("确认")) {
        const error = Object.assign(new Error("confirmation conflict"), { code: 409 });
        throw error;
      }
      return false;
    },
    onQueued: () => { queued += 1; }
  });
  await handler({ botId: "bot-1", senderId: "user-1", messageId: "bad-command", text: "确认 p digest", receivedAt: "2026-10-16T00:00:00.000Z" });
  await handler({ botId: "bot-1", senderId: "user-1", messageId: "bad-supplement", text: "补充 missing 内容", receivedAt: "2026-10-16T00:00:01.000Z" });
  await handler({ botId: "bot-1", senderId: "user-1", messageId: "good-message", text: "新任务", receivedAt: "2026-10-16T00:00:02.000Z" });

  const tasks = store.list();
  assert.equal(tasks.filter((task) => task.state === "failed").length, 2);
  assert.equal(tasks.filter((task) => task.state === "queued").length, 1);
  assert.equal(queued, 1);
});

test("database failures still reject inbound processing", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new CalendarTaskStore(database);
  const handler = createCalendarWeclawInboundHandler(store, { botId: "bot-1", recipientId: "user-1" });
  database.close();
  await assert.rejects(
    async () => { await handler({ botId: "bot-1", senderId: "user-1", messageId: "db-failure", text: "任务", receivedAt: "2026-10-16T00:00:00.000Z" }); },
    /closed|database/iu
  );
});
