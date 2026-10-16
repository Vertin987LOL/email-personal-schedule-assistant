import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ProcessedEmail } from "../types";
import { CalendarService } from "./service";
import { CalendarAgentRuntime, type CalendarExecutorFactory } from "./agent-runtime";
import { CalendarEmailBridge } from "./email-bridge";

const email: ProcessedEmail = { id: "mail-1", mailboxId: "box-1", externalUid: "1:7", subject: "讲座邀请", processedAt: "2026-10-16T00:00:00Z",
  category: "important", summaryZh: "讲座摘要", reasonZh: "学校通知", actionItemsZh: [], originalText: "讲座：2026年10月20日14:00—16:00，活动编号L123。", readMarked: false };
const extraction = JSON.stringify({ summaryZh: "讲座", activities: [{ key: "lecture", title: "科研讲座", kind: "activity", evidence: email.originalText,
  externalEventId: "L123", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: "Asia/Shanghai" } }] });

function fixture(text: string | ((attempt: number) => string) = extraction, enabled = true) {
  let now = Date.parse("2026-10-16T00:00:00Z");
  const calendar = new CalendarService(new DatabaseSync(":memory:"));
  calendar.createEvent("fixture", { title: "线性代数", kind: "course", status: "confirmed", sources: [{ kind: "course", ref: "fictional" }],
    time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: "Asia/Shanghai" } });
  const mails = new Map([[email.id, structuredClone(email)]]);
  let bridge!: CalendarEmailBridge;
  let attempts = 0;
  const factory: CalendarExecutorFactory = () => ({ async run() { attempts++; return { threadId: "t", turnId: "r", status: "completed", text: typeof text === "function" ? text(attempts) : text }; }, cancel() {}, close() {} });
  const runtime = new CalendarAgentRuntime(calendar, enabled ? factory : undefined, undefined, () => now, task => bridge.settle(task));
  bridge = new CalendarEmailBridge(runtime, { readEmail: id => mails.get(id), updateCalendar: (id, analysis) => {
    const current = mails.get(id); if (!current) return undefined;
    const updated = { ...current, calendarAnalysis: analysis }; mails.set(id, updated); return updated;
  }, now: () => now });
  return { calendar, runtime, bridge, mails, advance: () => { now += 250_000; } };
}

test("mail extraction settles without model tools, host computes 60 minutes and keeps a single task/event on replay", async () => {
  const f = fixture();
  const pending = f.bridge.enqueue(email);
  assert.equal(pending.calendarAnalysis?.state, "pending");
  assert.equal((await f.bridge.prepare(pending)).ready, false);
  await f.runtime.drain();
  // prepare may have started the pump first; wait for its durable result rather than assuming drain owns it.
  for (let i = 0; i < 20 && f.mails.get(email.id)?.calendarAnalysis?.state === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const ready = await f.bridge.prepare(f.mails.get(email.id)!);
  assert.equal(ready.ready, true); assert.equal(ready.email.summaryZh, "讲座摘要");
  assert.equal(ready.email.calendarAnalysis?.state, "ready");
  assert.match(ready.email.calendarAnalysis!.notes!, /线性代数.*60 分钟/);
  const report = f.bridge.analysis.get(email.id)!;
  assert.equal(report.activities[0].overlaps[0].overlapMinutes, 60);
  assert.equal(f.calendar.getEvent(report.activities[0].eventId!).status, "tentative");
  f.bridge.enqueue(ready.email); f.bridge.settle(f.runtime.tasks.get(pending.calendarAnalysis!.taskId!)!);
  assert.equal(f.runtime.tasks.list().length, 1);
  assert.equal(f.calendar.listEvents("2026-10-20T00:00:00+08:00", "2026-10-21T00:00:00+08:00").events.length, 2);
  await f.runtime.close(); f.calendar.repository.db.close();
});

test("disabled executor does not block the original notification or claim no conflict", async () => {
  const f = fixture(extraction, false);
  const result = await f.bridge.prepare(f.bridge.enqueue(email));
  assert.equal(result.ready, true); assert.equal(result.email.calendarAnalysis?.state, "skipped");
  assert.match(result.email.calendarAnalysis!.notes!, /未完成课表核对/); assert.equal(f.runtime.tasks.list().length, 0);
  await f.runtime.close(); f.calendar.repository.db.close();
});

test("invalid extraction is retained as failure without losing the summary or creating an event", async () => {
  const f = fixture("not JSON"); const pending = f.bridge.enqueue(email);
  await f.runtime.drain();
  const result = await f.bridge.prepare(f.mails.get(email.id)!);
  assert.equal(result.ready, true); assert.equal(result.email.calendarAnalysis?.state, "failed");
  assert.equal(result.email.summaryZh, email.summaryZh);
  assert.equal(f.runtime.tasks.get(pending.calendarAnalysis!.taskId!)?.state, "failed");
  assert.equal(f.runtime.tasks.get(pending.calendarAnalysis!.taskId!)?.inputs.length, 1);
  assert.equal(f.calendar.listEvents("2026-10-20T00:00:00+08:00", "2026-10-21T00:00:00+08:00").events.length, 1);
  await f.runtime.close(); f.calendar.repository.db.close();
});

test("one durable validation repair resumes extraction before writing an activity", async () => {
  const f = fixture(attempt => attempt === 1 ? "not JSON" : extraction);
  const pending = f.bridge.enqueue(email);
  await f.runtime.drain();
  const task = f.runtime.tasks.get(pending.calendarAnalysis!.taskId!)!;
  assert.equal(task.state, "succeeded"); assert.equal(task.inputs.length, 1);
  assert.match(task.inputs[0].text, /宿主校验未通过/);
  assert.equal(f.mails.get(email.id)?.calendarAnalysis?.state, "ready");
  assert.equal(f.bridge.analysis.get(email.id)?.activities.length, 1);
  await f.runtime.close(); f.calendar.repository.db.close();
});

test("queued analysis timeout is bounded and late tasks cannot insert after the original notice is released", async () => {
  const f = fixture(); const pending = f.bridge.enqueue(email); f.advance();
  const result = await f.bridge.prepare(pending);
  assert.equal(result.ready, true); assert.equal(result.email.calendarAnalysis?.state, "failed");
  await f.runtime.drain();
  assert.equal(f.runtime.tasks.get(pending.calendarAnalysis!.taskId!)?.state, "cancelled");
  assert.equal(f.bridge.analysis.get(email.id)?.status, "failed");
  await f.runtime.close(); f.calendar.repository.db.close();
});
