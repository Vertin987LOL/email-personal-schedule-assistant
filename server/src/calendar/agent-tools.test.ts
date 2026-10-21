import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CalendarRepository } from "./repository";
import { CalendarService } from "./service";
import { CalendarToolService, type CalendarToolContext, type ToolResult } from "./agent-tools";
import type { CalendarEventInput } from "./types";

const ZONE = "Asia/Shanghai";

function makeCalendar(ownerId = "owner") {
  return new CalendarService(new CalendarRepository(new DatabaseSync(":memory:")), ownerId);
}

function context(taskId = "task-1", active: () => boolean = () => true): CalendarToolContext {
  return { taskId, source: { kind: "manual", ref: "agent-test" }, isActive: active };
}

function event(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    title: "event",
    kind: "activity",
    time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE },
    status: "confirmed",
    sources: [{ kind: "manual", ref: "test" }],
    ...overrides
  };
}

function data(result: ToolResult): any {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.data;
}

function error(result: ToolResult, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a failed tool result");
  assert.equal(result.error.code, code);
  return result.error;
}

test("preview reports exact overlap and adjacent intervals are free", () => {
  const calendar = makeCalendar();
  calendar.createEvent("course", event({
    title: "course",
    kind: "course",
    time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: ZONE }
  }));
  const tools = new CalendarToolService(calendar);
  const overlap = data(tools.invoke("calendar.preview", {
    event: { title: "lecture", kind: "activity", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } },
    requireFree: false
  }, context()));
  assert.equal(overlap.overlaps[0].overlapMinutes, 60);
  const blocked = tools.invoke("calendar.preview", {
    event: { title: "lecture", kind: "activity", time: { kind: "interval", startsAt: "2026-10-20T16:30:00+08:00", endsAt: "2026-10-20T17:30:00+08:00", timeZone: ZONE } },
    requireFree: true
  }, context());
  assert.equal(data(blocked).overlaps.length, 0);
});

test("slots honor status and ignore point/date/cancelled events", () => {
  const calendar = makeCalendar();
  calendar.createEvent("confirmed", event({ time: { kind: "interval", startsAt: "2026-10-20T08:00:00+08:00", endsAt: "2026-10-20T09:00:00+08:00", timeZone: ZONE } }));
  calendar.createEvent("tentative", event({ title: "tentative", status: "tentative", time: { kind: "interval", startsAt: "2026-10-20T09:00:00+08:00", endsAt: "2026-10-20T10:00:00+08:00", timeZone: ZONE } }));
  calendar.createEvent("cancelled", event({ title: "cancelled", status: "cancelled", time: { kind: "interval", startsAt: "2026-10-20T10:00:00+08:00", endsAt: "2026-10-20T11:00:00+08:00", timeZone: ZONE } }));
  calendar.createEvent("point", event({ title: "point", time: { kind: "point", at: "2026-10-20T11:00:00+08:00", timeZone: ZONE } }));
  calendar.createEvent("date", event({ title: "date", kind: "deadline", time: { kind: "date", onDate: "2026-10-20", timeZone: ZONE } }));
  const tools = new CalendarToolService(calendar);
  const slots = data(tools.invoke("calendar.find_slots", {
    from: "2026-10-20T08:00:00+08:00", to: "2026-10-20T12:00:00+08:00", durationMinutes: 60, timeZone: ZONE, dayStart: "08:00", dayEnd: "12:00"
  }, context()));
  assert.deepEqual(slots.map((item: any) => item.startsAt), ["2026-10-20T02:00:00Z", "2026-10-20T03:00:00Z"]);
});

test("preview ignores its update target and persists a check", () => {
  const calendar = makeCalendar();
  const target = calendar.createEvent("target", event({ title: "target" }));
  const tools = new CalendarToolService(calendar);
  const result = data(tools.invoke("calendar.preview", {
    targetId: target.id,
    expectedVersion: 1,
    patch: { title: "renamed" },
    requireFree: true
  }, context()));
  assert.equal(result.overlaps.length, 0);
  const row = calendar.repository.db.prepare("SELECT taskId FROM calendar_tool_checks WHERE checkId = ?").get(result.checkId) as { taskId: string };
  assert.equal(row.taskId, "task-1");
});

test("propose is replay-safe, injects source, and binds operation to task", () => {
  const calendar = makeCalendar();
  const tools = new CalendarToolService(calendar);
  const args = {
    action: "create",
    evidence: "mail evidence",
    event: { title: "new", kind: "activity", time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  };
  const first = data(tools.invoke("calendar.propose", args, { ...context(), source: { kind: "email", ref: "mail-1" } }));
  const replay = data(tools.invoke("calendar.propose", args, { ...context(), source: { kind: "email", ref: "mail-1" } }));
  assert.equal(replay.proposal.id, first.proposal.id);
  error(tools.invoke("calendar.propose", { ...args, requireFree: true }, { ...context(), source: { kind: "email", ref: "mail-1" } }), "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(first.proposal.event.sources, [{ kind: "email", ref: "mail-1" }]);
  const operation = data(tools.invoke("calendar.get_operation", { operationId: first.operationId }, context()));
  assert.equal(operation.result.id, first.proposal.id);
  assert.deepEqual(tools.getProposalPolicy(first.proposal.id), { requireFree: false });
  error(tools.invoke("calendar.get_operation", { operationId: first.operationId }, context("other-task")), "OPERATION_FORBIDDEN");
});

test("source policy keeps email proposals tentative and out of course or mutation paths", () => {
  const calendar = makeCalendar();
  const tools = new CalendarToolService(calendar);
  const email = { ...context("email-task"), source: { kind: "email" as const, ref: "message-1" } };
  const created = data(tools.invoke("calendar.propose", {
    action: "create", evidence: "mail text",
    event: { title: "mail event", kind: "activity", status: "confirmed", time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  }, email));
  assert.equal(created.proposal.event.status, "tentative");
  error(tools.invoke("calendar.propose", {
    action: "update", targetId: "missing", expectedVersion: 1, patch: { title: "changed" }, evidence: "mail text"
  }, email), "SOURCE_POLICY");
  error(tools.invoke("calendar.propose", {
    action: "create", evidence: "mail text",
    event: { title: "course", kind: "course", time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  }, email), "SOURCE_POLICY");
  error(tools.invoke("calendar.propose", {
    action: "create", evidence: "manual text",
    event: { title: "course", kind: "course", time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  }, context("manual-course")), "SOURCE_POLICY");
});

test("forged fields and inactive tasks cannot write", () => {
  const calendar = makeCalendar();
  const tools = new CalendarToolService(calendar);
  error(tools.invoke("calendar.propose", {
    action: "create", evidence: "x", ownerId: "other", operationKey: "fake",
    event: { title: "bad", kind: "activity", source: { kind: "email", ref: "fake" }, time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  }, context()), "INVALID_INPUT");
  let active = true;
  const result = tools.invoke("calendar.propose", {
    action: "create", evidence: "x",
    event: { title: "blocked", kind: "activity", time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } }
  }, context("inactive", () => active));
  assert.equal(result.ok, true);
  active = false;
  error(tools.invoke("calendar.propose", {
    action: "create", evidence: "x",
    event: { title: "must not write", kind: "activity", time: { kind: "interval", startsAt: "2026-10-22T10:00:00+08:00", endsAt: "2026-10-22T11:00:00+08:00", timeZone: ZONE } }
  }, context("inactive", () => active)), "TASK_INACTIVE");
  assert.equal(calendar.listProposals().length, 1);
});

test("personal reminder proposals preview and await confirmation while mail cannot enable sending", () => {
  const calendar = makeCalendar(); const tools = new CalendarToolService(calendar);
  const candidate = { title: "读书", kind: "activity", status: "confirmed", reminder: { enabled: true, minutesBefore: 15 },
    time: { kind: "interval", startsAt: "2026-10-21T10:00:00+08:00", endsAt: "2026-10-21T11:00:00+08:00", timeZone: ZONE } };
  data(tools.invoke("calendar.preview", { event: candidate }, context()));
  const proposed = data(tools.invoke("calendar.propose", { action: "create", event: candidate, evidence: "本人要求提前15分钟提醒" }, context()));
  assert.equal(proposed.proposal.event.reminder.minutesBefore, 15);
  assert.equal(calendar.repository.listEvents(calendar.ownerId).length, 0);
  error(tools.invoke("calendar.propose", { action: "create", event: candidate, evidence: "邮件请求" }, { ...context("email-reminder"), source: { kind: "email", ref: "mail" } }), "SOURCE_POLICY");
});

test("DST local-day iteration returns real one-hour instants", () => {
  const calendar = makeCalendar();
  const tools = new CalendarToolService(calendar);
  const slots = data(tools.invoke("calendar.find_slots", {
    from: "2026-03-08T06:00:00Z", to: "2026-03-08T10:00:00Z", durationMinutes: 60,
    timeZone: "America/New_York", dayStart: "01:00", dayEnd: "05:00", limit: 10
  }, context()));
  assert.ok(slots.length > 0);
  for (const slot of slots) assert.equal(Date.parse(slot.endsAt) - Date.parse(slot.startsAt), 60 * 60 * 1000);
});

test("mail.list_recent returns structured email summaries and filters categories", () => {
  const calendar = makeCalendar();
  const sampleEmails = [
    {
      id: "mail-1",
      mailboxId: "mb-1",
      externalUid: "101",
      subject: "辅导预约",
      fromName: "Language Center",
      fromAddress: "center@example.edu",
      receivedAt: "2026-10-20T09:55:00+08:00",
      processedAt: "2026-10-20T09:56:00+08:00",
      category: "secondary" as const,
      summaryZh: "一对一口语辅导预约",
      reasonZh: "活动邀请",
      actionItemsZh: ["通过 Portal 提交预约"],
      originalText: "正文材料",
      readMarked: false
    },
    {
      id: "mail-2",
      mailboxId: "mb-1",
      externalUid: "102",
      subject: "社保卡通知",
      fromName: "FAO",
      fromAddress: "office@example.edu",
      receivedAt: "2026-10-19T18:00:00+08:00",
      processedAt: "2026-10-19T18:01:00+08:00",
      category: "important" as const,
      summaryZh: "办理金融社保卡",
      reasonZh: "重要通知",
      actionItemsZh: ["携带身份证原件"],
      originalText: "正文材料2",
      readMarked: false
    }
  ];

  let lastQueryOptions: any;
  const mockMailQuery = (opts: any) => {
    lastQueryOptions = opts;
    return {
      items: sampleEmails,
      total: sampleEmails.length,
      offset: 0,
      limit: opts.limit ?? 5,
      hasMoreBefore: false,
      hasMoreAfter: false
    };
  };

  const tools = new CalendarToolService(calendar, { mailQuery: mockMailQuery as any });
  const result = data(tools.invoke("mail.list_recent", {}, context()));
  assert.equal(result.total, 2);
  assert.equal(result.emails.length, 2);
  assert.deepEqual(result.emails[0], {
    id: "mail-1",
    subject: "辅导预约",
    from: "center@example.edu",
    receivedAt: "2026-10-20 09:55",
    category: "secondary",
    summaryZh: "一对一口语辅导预约",
    actionItems: ["通过 Portal 提交预约"]
  });
  assert.equal(lastQueryOptions.limit, 5);
  assert.equal(lastQueryOptions.excludeCategory, "ignore");

  data(tools.invoke("mail.list_recent", { limit: 10, category: "important" }, context()));
  assert.equal(lastQueryOptions.limit, 10);
  assert.equal(lastQueryOptions.category, "important");

  error(tools.invoke("mail.list_recent", { limit: 20 }, context()), "INVALID_INPUT");
  error(tools.invoke("mail.list_recent", { category: "invalid" }, context()), "INVALID_INPUT");
});

test("mail.search queries keywords and returns results", () => {
  const calendar = makeCalendar();
  let lastSearchOptions: any;
  const mockMailQuery = (opts: any) => {
    lastSearchOptions = opts;
    return {
      items: [
        {
          id: "mail-2",
          mailboxId: "mb-1",
          externalUid: "102",
          subject: "社保卡通知",
          fromName: "FAO",
          fromAddress: "office@example.edu",
          receivedAt: "2026-10-19T18:00:00+08:00",
          processedAt: "2026-10-19T18:01:00+08:00",
          category: "important" as const,
          summaryZh: "办理金融社保卡",
          reasonZh: "重要通知",
          actionItemsZh: ["携带身份证原件"],
          originalText: "正文材料2",
          readMarked: false
        }
      ],
      total: 1,
      offset: 0,
      limit: opts.limit ?? 5,
      hasMoreBefore: false,
      hasMoreAfter: false
    };
  };

  const tools = new CalendarToolService(calendar, { mailQuery: mockMailQuery as any });
  const result = data(tools.invoke("mail.search", { query: "社保卡", limit: 3 }, context()));
  assert.equal(result.query, "社保卡");
  assert.equal(result.count, 1);
  assert.equal(result.emails[0].id, "mail-2");
  assert.equal(lastSearchOptions.q, "社保卡");
  assert.equal(lastSearchOptions.limit, 3);
  assert.equal(lastSearchOptions.excludeCategory, "ignore");

  error(tools.invoke("mail.search", {}, context()), "INVALID_INPUT");
  error(tools.invoke("mail.search", { query: " " }, context()), "INVALID_INPUT");
});

