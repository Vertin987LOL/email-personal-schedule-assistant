import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CalendarTaskError,
  CalendarTaskStore,
  parseWechatTaskSourceRef,
  wechatTaskSourceRef
} from "./agent-tasks";

function store(ownerId = "local-owner") {
  return new CalendarTaskStore(new DatabaseSync(":memory:"), ownerId);
}

test("tasks are durable, owner scoped, and source-key idempotent", () => {
  const database = new DatabaseSync(":memory:");
  const first = new CalendarTaskStore(database, "owner-a");
  const second = new CalendarTaskStore(database, "owner-b");
  const created = first.create({ sourceKey: "wechat-message-1", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "安排会议" });
  const replay = first.create({ sourceKey: "wechat-message-1", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "安排会议" });

  assert.equal(replay.id, created.id);
  assert.equal(second.get(created.id), undefined);
  assert.equal(first.list().length, 1);
  assert.throws(
    () => first.create({ sourceKey: "wechat-message-1", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "换一件事" }),
    (error: unknown) => error instanceof CalendarTaskError && error.code === "SOURCE_KEY_CONFLICT"
  );
});

test("inputs append once, queue new work, and replay does not restart success", () => {
  const target = store();
  const created = target.create({ sourceKey: "manual-1", sourceKind: "manual", text: "建立课程" });
  const first = target.addInput(created.id, { inputKey: "wechat-message-2", text: "周五下午" });
  assert.equal(first?.state, "queued");
  assert.equal(first?.inputs.length, 1);
  const completed = target.update(created.id, { state: "succeeded", result: { eventId: "event-1" } });
  assert.deepEqual(completed?.result, { eventId: "event-1" });
  const replay = target.addInput(created.id, { inputKey: "wechat-message-2", text: "周五下午" });
  assert.equal(replay?.state, "succeeded");
  assert.equal(replay?.inputs.length, 1);
  const followUp = target.addInput(created.id, { inputKey: "wechat-message-3", text: "改成周六" });
  assert.equal(followUp?.state, "queued");
  assert.equal(followUp?.inputs.length, 2);
  assert.throws(
    () => target.addInput(created.id, { inputKey: "wechat-message-2", text: "恶意改写" }),
    (error: unknown) => error instanceof CalendarTaskError && error.code === "INPUT_KEY_CONFLICT"
  );
});

test("new input during a running turn stays running for serial follow-up", () => {
  const target = store();
  const created = target.create({ sourceKey: "running-1", sourceKind: "manual", text: "执行" });
  target.update(created.id, { state: "running" });
  const updated = target.addInput(created.id, { inputKey: "input-1", text: "补充条件" });
  assert.equal(updated?.state, "running");
});

test("update uses a whitelist and can clear optional JSON results", () => {
  const target = store();
  const created = target.create({ sourceKey: "manual-2", sourceKind: "manual", text: "任务" });
  const running = target.update(created.id, { state: "running", threadId: "thread-1", result: { ok: true } });
  assert.equal(running?.state, "running");
  assert.deepEqual(running?.result, { ok: true });
  const cleared = target.update(created.id, { result: undefined });
  assert.equal(cleared?.result, undefined);
  assert.throws(
    () => target.update(created.id, { ownerId: "owner-b" } as never),
    (error: unknown) => error instanceof CalendarTaskError && error.code === "INVALID_INPUT"
  );
});

test("recovery only interrupts this owner's running tasks", () => {
  const database = new DatabaseSync(":memory:");
  const first = new CalendarTaskStore(database, "owner-a");
  const second = new CalendarTaskStore(database, "owner-b");
  const firstTask = first.create({ sourceKey: "a", sourceKind: "manual", text: "A" });
  const secondTask = second.create({ sourceKey: "b", sourceKind: "manual", text: "B" });
  first.update(firstTask.id, { state: "running" });
  second.update(secondTask.id, { state: "running" });
  assert.equal(first.recoverInterrupted(), 1);
  assert.equal(first.get(firstTask.id)?.state, "interrupted");
  assert.equal(second.get(secondTask.id)?.state, "running");
});

test("nested task transactions use a savepoint and preserve the outer transaction", () => {
  const database = new DatabaseSync(":memory:");
  const target = new CalendarTaskStore(database);
  const withTransaction = (target as unknown as { withTransaction<T>(work: () => T): T }).withTransaction.bind(target);

  database.exec("BEGIN IMMEDIATE");
  assert.throws(
    () => withTransaction(() => {
      target.create({ sourceKey: "nested-rollback", sourceKind: "manual", text: "inner" });
      throw new Error("nested failure");
    }),
    /nested failure/
  );
  assert.equal(database.isTransaction, true);
  assert.equal(target.getBySourceKey("nested-rollback"), undefined);

  target.create({ sourceKey: "outer-commit", sourceKind: "manual", text: "outer" });
  database.exec("COMMIT");
  assert.equal(target.getBySourceKey("outer-commit")?.text, "outer");
});

test("wechat task source references are structured and stable", () => {
  const ref = wechatTaskSourceRef("bot-1", "user-1");
  assert.equal(ref, "wechat:bot-1:user-1");
  assert.deepEqual(parseWechatTaskSourceRef(ref), { botId: "bot-1", senderId: "user-1" });
  assert.equal(parseWechatTaskSourceRef("manual:one"), undefined);
});
