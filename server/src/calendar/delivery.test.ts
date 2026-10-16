import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CalendarTaskStore } from "./agent-tasks";
import type { CalendarTask } from "./agent-tasks";
import { calendarProposalDigest } from "./agent-runtime";
import { CalendarRepository } from "./repository";
import { CalendarService } from "./service";
import { CalendarDeliveryService } from "./delivery";
import type { CalendarEventInput } from "./types";

function eventInput(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    title: "复习",
    kind: "activity",
    time: { kind: "interval", startsAt: "2026-10-20T10:00:00+08:00", endsAt: "2026-10-20T11:00:00+08:00", timeZone: "Asia/Shanghai" },
    status: "confirmed",
    sources: [{ kind: "manual", ref: "delivery-test" }],
    ...overrides,
  };
}

function calendar(db = new DatabaseSync(":memory:")) {
  return new CalendarService(new CalendarRepository(db));
}

function taskStore(db: DatabaseSync) {
  return new CalendarTaskStore(db);
}

test("enqueueTask is WeChat-bound, idempotent, and includes exact proposal commands", async () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const tasks = taskStore(db);
  const sent: Array<{ recipient: string | undefined; text: string }> = [];
  const delivery = new CalendarDeliveryService(service, {
    taskRecipient: () => "wechat-user",
    send: async (recipient, text) => { sent.push({ recipient, text }); },
  });
  const created = tasks.create({ sourceKey: "wechat-delivery", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "安排复习" });
  const proposal = service.createProposal({
    operationKey: "delivery-proposal",
    action: "create",
    event: eventInput(),
    evidence: "本人要求复习",
  });
  const task = tasks.update(created.id, { state: "awaiting_confirmation", result: { text: "已生成待确认变更" }, proposalIds: [proposal.id] });
  assert.ok(task);
  const first = delivery.enqueueTask(task!, [proposal]);
  const replay = delivery.enqueueTask(task!, [proposal]);
  assert.ok(first);
  assert.equal(replay?.id, first?.id);
  const digest = calendarProposalDigest(proposal);
  assert.match(first!.text ?? "", new RegExp(`确认 ${task!.id} ${proposal.id} ${digest.slice(0, 12)}`));
  assert.match(first!.text ?? "", new RegExp(`拒绝 ${task!.id} ${proposal.id} ${digest.slice(0, 12)}`));
  const emailTask = tasks.create({ sourceKey: "email-delivery", sourceKind: "email", sourceRef: "mail-1", text: "邮件任务" });
  assert.equal(delivery.enqueueTask(emailTask), undefined);
  await delivery.tick();
  await delivery.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, "wechat-user");
  assert.equal(delivery.list().filter(item => item.kind === "task").length, 1);
  db.close();
});

test("proposal delivery previews concrete update and cancellation details", () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const tasks = taskStore(db);
  const target = service.createEvent("proposal-preview-target", eventInput({
    title: "旧课程",
    location: "旧教室",
  }));
  const update = service.createProposal({
    operationKey: "proposal-preview-update",
    action: "update",
    targetId: target.id,
    expectedVersion: target.version,
    patch: {
      title: "新课程",
      time: { kind: "interval", startsAt: "2026-10-20T12:00:00+08:00", endsAt: "2026-10-20T13:00:00+08:00", timeZone: "Asia/Shanghai" },
      location: "新教室",
    },
    evidence: "预览更新",
  });
  const cancel = service.createProposal({
    operationKey: "proposal-preview-cancel",
    action: "cancel",
    targetId: target.id,
    expectedVersion: target.version,
    evidence: "预览取消",
  });
  const created = tasks.create({ sourceKey: "proposal-preview-task", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "请确认变更" });
  const awaiting = tasks.update(created.id, { state: "awaiting_confirmation", proposalIds: [update.id, cancel.id] });
  assert.ok(awaiting);
  const delivery = new CalendarDeliveryService(service, { taskRecipient: () => "wechat-user", send: async () => undefined });
  const row = delivery.enqueueTask(awaiting!);
  assert.ok(row);
  const text = row!.text ?? "";
  assert.match(text, /更新；标题：旧课程 → 新课程/);
  assert.match(text, /时间：2026-10-20 10:00.*2026-10-20 12:00/);
  assert.match(text, /地点：旧教室 → 新教室/);
  assert.match(text, /取消「旧课程」；取消时间：2026-10-20 10:00 至 2026-10-20 11:00/);
  assert.match(text, new RegExp(`确认 ${awaiting!.id} ${update.id} [0-9a-f]{12}`));
  assert.match(text, new RegExp(`拒绝 ${awaiting!.id} ${cancel.id} [0-9a-f]{12}`));
  db.close();
});

test("reminders survive a restart and accepted records are not resent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-delivery-"));
  const filename = join(directory, "calendar.sqlite");
  let now = Date.parse("2026-10-20T01:50:00Z");
  const sent: string[] = [];
  try {
    const firstDb = new DatabaseSync(filename);
    const firstCalendar = calendar(firstDb);
    const event = firstCalendar.createEvent("delivery-event", eventInput({ reminder: { enabled: true, minutesBefore: 5 } }));
    const first = new CalendarDeliveryService(firstCalendar, { now: () => now, send: async (_recipient, text) => { sent.push(text); } });
    first.syncReminders();
    assert.equal(first.list().filter(item => item.state === "pending").length, 1);
    now = Date.parse("2026-10-20T01:55:00Z");
    await first.tick();
    assert.equal(sent.length, 1);
    firstDb.close();

    const secondDb = new DatabaseSync(filename);
    const secondCalendar = calendar(secondDb);
    const second = new CalendarDeliveryService(secondCalendar, { now: () => now, send: async () => { sent.push("unexpected"); } });
    second.syncReminders();
    assert.equal(second.list().filter(item => item.kind === "reminder").length, 1);
    assert.equal(second.list().find(item => item.kind === "reminder")?.state, "accepted");
    await second.tick();
    assert.equal(sent.length, 1);
    assert.equal(secondCalendar.getEvent(event.id).id, event.id);
    secondDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reschedule, cancellation, and disabled reminders invalidate only pending old schedules", () => {
  let now = Date.parse("2026-10-20T01:00:00Z");
  const service = calendar();
  const event = service.createEvent("reminder-change", eventInput({ reminder: { enabled: true } }));
  const delivery = new CalendarDeliveryService(service, { now: () => now, send: async () => undefined });
  delivery.syncReminders();
  const first = delivery.list().find(item => item.eventId === event.id);
  assert.equal(first?.state, "pending");

  const moved = service.updateEvent(event.id, event.version, "move-reminder", {
    time: { kind: "interval", startsAt: "2026-10-20T12:00:00+08:00", endsAt: "2026-10-20T13:00:00+08:00", timeZone: "Asia/Shanghai" },
  });
  delivery.syncReminders();
  assert.equal(delivery.list().find(item => item.id === first?.id)?.state, "invalidated");
  const second = delivery.list().find(item => item.eventId === event.id && item.id !== first?.id);
  assert.equal(second?.state, "pending");

  service.updateEvent(event.id, moved.version, "disable-reminder", { reminder: { enabled: false } });
  delivery.syncReminders();
  assert.equal(delivery.list().find(item => item.id === second?.id)?.state, "invalidated");
  now += 60_000;
});

test("same reminder schedule does not duplicate when only the event source/version changes", () => {
  const service = calendar();
  const event = service.createEvent("source-change", eventInput({ reminder: { enabled: true, minutesBefore: 0 } }));
  const delivery = new CalendarDeliveryService(service, { send: async () => undefined });
  delivery.syncReminders();
  const renamed = service.updateEvent(event.id, event.version, "rename-without-reschedule", { title: "改名后的复习", location: "图书馆" });
  delivery.syncReminders();
  const refreshed = delivery.list().find(item => item.eventId === event.id);
  assert.equal(refreshed?.state, "pending");
  assert.match(refreshed?.text ?? "", /改名后的复习/);
  assert.match(refreshed?.text ?? "", /地点：图书馆/);
  service.attachSource(event.id, renamed.version, "attach-source", { kind: "manual", ref: "another-source" });
  delivery.syncReminders();
  assert.equal(delivery.list().filter(item => item.eventId === event.id).length, 1);
});

test("a pending task delivery is invalidated when the persisted task advances", async () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const tasks = taskStore(db);
  let sends = 0;
  const delivery = new CalendarDeliveryService(service, {
    taskRecipient: () => "wechat-user",
    send: async () => { sends++; },
  });
  const created = tasks.create({ sourceKey: "task-recheck", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "查一下" });
  const finished = tasks.update(created.id, { state: "succeeded", result: { text: "旧结果" } });
  assert.ok(finished);
  delivery.enqueueTask(finished!);
  tasks.update(created.id, { state: "needs_input", question: "哪一天？" });
  await delivery.tick();
  assert.equal(sends, 0);
  assert.equal(delivery.list().find(item => item.taskId === created.id)?.state, "invalidated");
  db.close();
});

test("task deliveries expire from the persisted task update time", async () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const tasks = taskStore(db);
  const now = Date.parse("2026-10-20T02:00:00Z");
  let sends = 0;
  const delivery = new CalendarDeliveryService(service, {
    now: () => now,
    taskRecipient: () => "wechat-user",
    send: async () => { sends++; },
  });
  const created = tasks.create({ sourceKey: "old-task", sourceKind: "wechat", sourceRef: "wechat:bot:user", text: "旧任务" });
  const finished = tasks.update(created.id, { state: "succeeded", result: { text: "旧结果" } });
  assert.ok(finished);
  const queued = delivery.enqueueTask(finished!);
  assert.ok(queued);
  // Keep the outbox row fresh while making the persisted task result stale.
  db.prepare("UPDATE calendar_agent_tasks SET updatedAt = ? WHERE ownerId = ? AND id = ?")
    .run("2026-10-20T00:00:00.000Z", service.ownerId, created.id);
  await delivery.tick();
  assert.equal(sends, 0);
  assert.equal(delivery.list().find(item => item.id === queued!.id)?.state, "expired");
  db.close();
});

test("a task delivery fails closed when the task table is unavailable", async () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const task: CalendarTask = {
    id: "missing-task",
    ownerId: service.ownerId,
    sourceKey: "missing-task-source",
    sourceKind: "wechat",
    sourceRef: "wechat:bot:user",
    text: "缺失任务表",
    inputs: [],
    state: "succeeded",
    result: { text: "结果" },
    proposalIds: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
  let sends = 0;
  const delivery = new CalendarDeliveryService(service, {
    taskRecipient: () => "wechat-user",
    send: async () => { sends++; },
  });
  const queued = delivery.enqueueTask(task);
  assert.ok(queued);
  await delivery.tick();
  assert.equal(sends, 0);
  assert.equal(delivery.list().find(item => item.id === queued!.id)?.state, "invalidated");
  db.close();
});

test("paused candidates do not consume the five-send batch", async () => {
  const db = new DatabaseSync(":memory:");
  const service = calendar(db);
  const tasks = taskStore(db);
  const now = Date.now() + 6_000;
  const sent: string[] = [];
  const delivery = new CalendarDeliveryService(service, {
    now: () => now,
    taskRecipient: task => task.sourceRef?.endsWith(":ready") ? "ready" : "paused",
    isReady: recipient => recipient === "ready",
    send: async (recipient) => { sent.push(recipient ?? ""); },
  });
  const records: Array<{ id: string; taskId: string }> = [];
  for (let index = 0; index < 6; index++) {
    const suffix = index < 5 ? `paused-${index}` : "ready";
    const created = tasks.create({ sourceKey: `batch-${index}`, sourceKind: "wechat", sourceRef: `wechat:bot:${suffix}`, text: `批量任务${index}` });
    const finished = tasks.update(created.id, { state: "succeeded", result: { text: `结果${index}` } });
    assert.ok(finished);
    const record = delivery.enqueueTask(finished!);
    assert.ok(record);
    records.push({ id: record!.id, taskId: created.id });
    db.prepare("UPDATE calendar_delivery_outbox SET createdAt = ? WHERE ownerId = ? AND id = ?")
      .run(new Date(now - (6 - index) * 1_000).toISOString(), service.ownerId, record!.id);
    if (index < 5) {
      db.prepare("UPDATE calendar_delivery_outbox SET state = 'paused' WHERE ownerId = ? AND id = ?")
        .run(service.ownerId, record!.id);
    }
  }
  await delivery.tick();
  assert.deepEqual(sent, ["ready"]);
  assert.equal(delivery.list().find(item => item.taskId === records[5].taskId)?.state, "accepted");
  assert.equal(delivery.list().filter(item => item.state === "paused").length, 5);
  db.close();
});

test("point reminders use at, while date reminders require an explicit instant", () => {
  const service = calendar();
  const point = service.createEvent("point-reminder", eventInput({
    time: { kind: "point", at: "2026-10-20T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    reminder: { enabled: true },
  }));
  const dateWithoutAt = service.createEvent("date-without-at", eventInput({
    time: { kind: "date", onDate: "2026-10-20", timeZone: "Asia/Shanghai" },
    reminder: { enabled: true },
  }));
  const dateWithAt = service.createEvent("date-with-at", eventInput({
    time: { kind: "date", onDate: "2026-10-20", timeZone: "Asia/Shanghai" },
    reminder: { enabled: true, at: "2026-10-20T09:00:00+08:00" },
  }));
  const delivery = new CalendarDeliveryService(service, { send: async () => undefined });
  delivery.syncReminders();
  const reminders = delivery.list().filter(item => item.kind === "reminder");
  assert.deepEqual(reminders.map(item => item.eventId).sort(), [dateWithAt.id, point.id].sort());
  assert.equal(reminders.find(item => item.eventId === point.id)?.fireAt, "2026-10-20T02:00:00.000Z");
  assert.equal(reminders.find(item => item.eventId === dateWithAt.id)?.fireAt, "2026-10-20T01:00:00.000Z");
  assert.equal(delivery.list().some(item => item.eventId === dateWithoutAt.id), false);
});

test("point reminders remain sendable for one hour after an on-time fire", async () => {
  let now = Date.parse("2026-10-20T02:00:05Z");
  const service = calendar();
  const sent: string[] = [];
  const delivery = new CalendarDeliveryService(service, {
    now: () => now,
    send: async (_recipient, text) => { sent.push(text); },
  });
  const recent = service.createEvent("point-recent", eventInput({
    time: { kind: "point", at: "2026-10-20T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    reminder: { enabled: true, minutesBefore: 0 },
  }));
  await delivery.tick();
  assert.equal(sent.length, 1);
  assert.equal(delivery.list().find(item => item.eventId === recent.id)?.state, "accepted");

  now = Date.parse("2026-10-20T03:00:01Z");
  const stale = service.createEvent("point-stale", eventInput({
    time: { kind: "point", at: "2026-10-20T10:00:00+08:00", timeZone: "Asia/Shanghai" },
    reminder: { enabled: true, minutesBefore: 0 },
  }));
  await delivery.tick();
  assert.equal(sent.length, 1);
  assert.equal(delivery.list().find(item => item.eventId === stale.id)?.state, "expired");
});

test("offline reminders pause, unknown send outcomes never retry, and ticks are serialized", async () => {
  let now = Date.parse("2026-10-20T02:00:00Z");
  const service = calendar();
  const event = service.createEvent("offline", eventInput({ reminder: { enabled: true } }));
  let ready = false;
  let sendCalls = 0;
  const delivery = new CalendarDeliveryService(service, {
    now: () => now,
    isReady: () => ready,
    send: async () => { sendCalls++; throw new Error("network down"); },
  });
  delivery.syncReminders();
  await delivery.tick();
  assert.equal(delivery.list().find(item => item.eventId === event.id)?.state, "paused");
  ready = true;
  await delivery.tick();
  assert.equal(delivery.list().find(item => item.eventId === event.id)?.state, "pending");
  await delivery.tick();
  assert.equal(sendCalls, 1);
  assert.equal(delivery.list().find(item => item.eventId === event.id)?.state, "unknown");
  await delivery.tick();
  assert.equal(sendCalls, 1);
  now += 1;
});

test("a restarted outbox turns sending into unknown and does not retry it", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-delivery-sending-"));
  const filename = join(directory, "calendar.sqlite");
  try {
    const firstDb = new DatabaseSync(filename);
    const firstCalendar = calendar(firstDb);
    const event = firstCalendar.createEvent("sending", eventInput({ reminder: { enabled: true } }));
    const first = new CalendarDeliveryService(firstCalendar, { send: async () => undefined });
    first.syncReminders();
    firstDb.prepare("UPDATE calendar_delivery_outbox SET state = 'sending' WHERE eventId = ?").run(event.id);
    firstDb.close();
    const secondDb = new DatabaseSync(filename);
    const second = new CalendarDeliveryService(calendar(secondDb), { send: async () => { throw new Error("must not retry"); } });
    assert.equal(second.list().find(item => item.eventId === event.id)?.state, "unknown");
    secondDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("old reminders expire after one hour offline or after the event ends", async () => {
  let now = Date.parse("2026-10-20T01:00:00Z");
  const service = calendar();
  const event = service.createEvent("stale", eventInput({ reminder: { enabled: true } }));
  const delivery = new CalendarDeliveryService(service, { now: () => now, send: async () => { throw new Error("must not send"); } });
  delivery.syncReminders();
  now = Date.parse("2026-10-20T03:00:01Z");
  await delivery.tick();
  assert.equal(delivery.list().find(item => item.eventId === event.id)?.state, "expired");
});
