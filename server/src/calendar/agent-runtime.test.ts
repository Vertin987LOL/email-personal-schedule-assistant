import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CalendarService } from "./service";
import { CalendarAgentRuntime, type CalendarExecutorFactory } from "./agent-runtime";
import type { CalendarEventInput } from "./types";
import { resolveCalendarWechatCommand } from "./agent-wechat";

const course: CalendarEventInput = { title: "线性代数", kind: "course", status: "confirmed", sources: [{ kind: "course", ref: "fixture" }],
  time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: "Asia/Shanghai" } };
const lecture = { title: "科研讲座", kind: "activity", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: "Asia/Shanghai" } };
const range = { from: "2026-10-20T00:00:00+08:00", to: "2026-10-21T00:00:00+08:00" };
function setup() { return new CalendarService(new DatabaseSync(":memory:")); }
function executor(run: () => void | Promise<void>): ReturnType<CalendarExecutorFactory> {
  return { async run(input) { await input.onThread?.("thread-fixture"); await input.onTurn?.("turn-fixture"); await run(); return { threadId: "thread-fixture", turnId: "turn-fixture", status: "completed", text: "已提出安排，等待确认。" }; }, cancel() {}, close() {} };
}

test("host consumes conflict, continues to slots and proposal, and confirms exactly once", async () => {
  const calendar = setup(); calendar.createEvent("course", course);
  let token = "";
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => {
    token = input.capabilityToken;
    return executor(() => {
      const conflict = runtime.invoke(token, "calendar.preview", { event: lecture, requireFree: true });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, "TIME_CONFLICT");
      const slots = runtime.invoke(token, "calendar.find_slots", { ...range, durationMinutes: 120, timeZone: "Asia/Shanghai", dayStart: "16:30", dayEnd: "22:00" });
      assert.equal(slots.ok, true);
      const proposal = runtime.invoke(token, "calendar.propose", { action: "create", event: { ...lecture, title: "复习", time: { ...lecture.time, startsAt: "2026-10-20T16:30:00+08:00", endsAt: "2026-10-20T18:30:00+08:00" } }, evidence: "本人要求找两小时空档", requireFree: true });
      assert.equal(proposal.ok, true);
    });
  });
  const task = runtime.tasks.create({ sourceKey: "instruction-1", sourceKind: "manual", text: "周五前找两小时复习" });
  await runtime.drain();
  assert.equal(runtime.tasks.get(task.id)?.state, "awaiting_confirmation");
  assert.equal(calendar.listEvents(range.from, range.to).events.length, 1);
  const [item] = runtime.proposals(task.id);
  runtime.resolve(task.id, item.proposal.id, item.digest, "approve");
  runtime.resolve(task.id, item.proposal.id, item.digest, "approve");
  assert.equal(calendar.listEvents(range.from, range.to).events.length, 2);
  assert.equal(runtime.tasks.get(task.id)?.state, "succeeded");
  assert.throws(() => runtime.resolve(task.id, item.proposal.id, item.digest, "reject"), /resolved/);
  assert.equal(runtime.invoke(token, "calendar.list", range).ok, false);
  await runtime.close();
});

test("repeated business error revokes the capability before any later proposal", async () => {
  const calendar = setup(); calendar.createEvent("course", course);
  let interrupted = false;
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => ({
    ...executor(() => {
      for (let i = 0; i < 2; i++) runtime.invoke(input.capabilityToken, "calendar.preview", { event: lecture, requireFree: true });
      const blocked = runtime.invoke(input.capabilityToken, "calendar.propose", { action: "create", event: lecture, evidence: "重复失败后不能写" });
      assert.equal(blocked.ok, false);
    }), cancel() { interrupted = true; }
  }));
  const task = runtime.tasks.create({ sourceKey: "repeated", sourceKind: "manual", text: "安排复习" });
  await runtime.drain();
  assert.equal(runtime.tasks.get(task.id)?.error, "REPEATED_ERROR");
  assert.equal(interrupted, true);
  assert.equal(calendar.listProposals().length, 0);
  await runtime.close();
});

test("deadline is checked by the tool gateway even before the timer runs", async () => {
  let now = 1000;
  const calendar = setup();
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => executor(() => {
    now = 2000;
    assert.equal(runtime.invoke(input.capabilityToken, "calendar.propose", { action: "create", event: lecture, evidence: "已过期" }).ok, false);
  }), { calls: 12, milliseconds: 500 }, () => now);
  const task = runtime.tasks.create({ sourceKey: "timeout", sourceKind: "manual", text: "加个活动" });
  await runtime.drain();
  assert.equal(runtime.tasks.get(task.id)?.state, "failed");
  assert.equal(calendar.listProposals().length, 0);
  await runtime.close();
});

test("missing details pause durably and user input resumes the same thread", async () => {
  const calendar = setup(); let attempt = 0;
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => ({
    async run(params) {
      attempt++;
      await params.onThread?.("same-thread");
      await params.onTurn?.(`turn-${attempt}`);
      if (attempt === 1) runtime.invoke(input.capabilityToken, "calendar.request_input", { question: "具体哪一天？", missing: ["date"] });
      else { assert.equal(params.threadId, "same-thread"); assert.match(params.text, /10月20日/); runtime.invoke(input.capabilityToken, "calendar.list", range); }
      return { threadId: "same-thread", turnId: `turn-${attempt}`, status: "completed", text: "查询完成" };
    }, cancel() {}, close() {}
  }));
  const task = runtime.tasks.create({ sourceKey: "question", sourceKind: "manual", text: "那天下午有什么课？" });
  await runtime.drain();
  assert.equal(runtime.tasks.get(task.id)?.state, "needs_input");
  runtime.tasks.addInput(task.id, { inputKey: "answer", text: "10月20日" });
  await runtime.drain();
  assert.equal(runtime.tasks.get(task.id)?.state, "succeeded");
  assert.equal(attempt, 2);
  await runtime.close();
});

test("input received during a turn runs in a following turn without concurrent execution", async () => {
  const calendar = setup(); let attempts = 0; let running = 0;
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => executor(async () => {
    running++; assert.equal(running, 1); attempts++;
    if (attempts === 1) runtime.tasks.addInput(input.task.id, { inputKey: "second", text: "也看一下晚上" });
    runtime.invoke(input.capabilityToken, "calendar.list", range);
    await Promise.resolve(); running--;
  }));
  const task = runtime.tasks.create({ sourceKey: "concurrent-input", sourceKind: "manual", text: "看看明天" });
  await runtime.drain();
  assert.equal(attempts, 2);
  assert.equal(runtime.tasks.get(task.id)?.inputs.length, 1);
  assert.equal(runtime.tasks.get(task.id)?.state, "succeeded");
  await runtime.close();
});

test("disabled executor keeps instructions queued and recovering never blindly replays", async () => {
  const calendar = setup();
  const runtime = new CalendarAgentRuntime(calendar);
  const task = runtime.tasks.create({ sourceKey: "disabled", sourceKind: "manual", text: "明天加讲座" });
  await runtime.drain(); assert.equal(runtime.tasks.get(task.id)?.state, "queued");
  runtime.tasks.update(task.id, { state: "running" }); runtime.recover();
  assert.equal(runtime.tasks.get(task.id)?.state, "interrupted");
  assert.equal(runtime.status.enabled, false);
  await runtime.close();
});

test("a hung executor cannot keep the worker busy past its deadline", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const calendar = setup(); let calls = 0;
    const runtime = new CalendarAgentRuntime(calendar, () => ({
      async run() { calls++; return await new Promise<never>(() => {}); }, cancel() {}, close() {}
    }), { calls: 12, milliseconds: 20 });
    const a = runtime.tasks.create({ sourceKey: "hung-a", sourceKind: "manual", text: "第一个" });
    const b = runtime.tasks.create({ sourceKey: "hung-b", sourceKind: "manual", text: "第二个" });
    await runtime.drain();
    assert.equal(calls, 2);
    assert.equal(runtime.tasks.get(a.id)?.error, "TIMEOUT");
    assert.equal(runtime.tasks.get(b.id)?.error, "TIMEOUT");
    assert.equal(runtime.status.running, false);
    await runtime.close();
  } finally { clearTimeout(keepAlive); }
});

test("a newly occupied slot blocks approval and a forged content digest is refused", async () => {
  const calendar = setup();
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => executor(() => {
    assert.equal(runtime.invoke(input.capabilityToken, "calendar.propose", { action: "create", event: lecture, evidence: "请找空档", requireFree: true }).ok, true);
  }));
  const task = runtime.tasks.create({ sourceKey: "approval-check", sourceKind: "manual", text: "找空档加讲座" });
  await runtime.drain();
  const [item] = runtime.proposals(task.id);
  calendar.createEvent("new-course", course);
  assert.throws(() => runtime.resolve(task.id, item.proposal.id, "0".repeat(64), "approve"), /changed/);
  assert.throws(() => runtime.resolve(task.id, item.proposal.id, item.digest, "approve"), /overlap/);
  assert.equal(calendar.listEvents(range.from, range.to).events.length, 1);
  assert.equal(calendar.listProposals()[0].state, "pending");
  await runtime.close();
});

test("explicit WeChat approval is bound to the sender and exact proposal", async () => {
  const calendar = setup();
  const runtime: CalendarAgentRuntime = new CalendarAgentRuntime(calendar, input => executor(() => {
    runtime.invoke(input.capabilityToken, "calendar.propose", { action: "create", event: lecture, evidence: "本人新增" });
  }));
  const task = runtime.tasks.create({ sourceKey: "wechat-approval", sourceKind: "wechat", sourceRef: "wechat:bot:me", text: "加讲座" });
  await runtime.drain();
  const [item] = runtime.proposals(task.id);
  const inbound = { botId: "bot", senderId: "stranger", messageId: "confirmation", receivedAt: "2026-10-16T00:00:00Z", text: `确认 ${task.id} ${item.proposal.id} ${item.digest.slice(0, 12)}` };
  assert.throws(() => resolveCalendarWechatCommand(runtime, inbound), /binding/);
  assert.equal(calendar.listEvents(range.from, range.to).events.length, 0);
  assert.equal(resolveCalendarWechatCommand(runtime, { ...inbound, senderId: "me" }), true);
  assert.equal(resolveCalendarWechatCommand(runtime, { ...inbound, senderId: "me" }), true);
  assert.equal(calendar.listEvents(range.from, range.to).events.length, 1);
  await runtime.close();
});
