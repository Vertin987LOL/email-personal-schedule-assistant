import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createSessionToken } from "../auth-crypto";
import { readSettings } from "../store";
import { CalendarRepository } from "./repository";
import { CalendarService } from "./service";
import { createCalendarRouter } from "./routes";
import { CourseCalendarService, type CourseSeriesInput } from "./courses";
import { CalendarEmailAnalysisService, renderEmailCalendarAnalysis, validateEmailCalendarExtraction, type EmailCalendarInput } from "./email-analysis";
import type { CalendarEventInput } from "./types";

const ZONE = "Asia/Shanghai";

function calendar() {
  return new CalendarService(new CalendarRepository(new DatabaseSync(":memory:")));
}

function existing(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    title: "课程",
    kind: "course",
    time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: ZONE },
    status: "confirmed",
    sources: [{ kind: "course", ref: "course-1" }],
    ...overrides
  };
}

function mail(overrides: Partial<EmailCalendarInput> = {}): EmailCalendarInput {
  return {
    emailId: "email-1", sourceKey: "mail-1", subject: "活动通知", bodyText: "讲座 ext-1 将于本周举行。",
    fromAddress: "organizer@example.com", modelText: JSON.stringify({ summaryZh: "讲座", activities: [{ key: "a", title: "讲座", kind: "activity", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE }, evidence: "讲座 ext-1", externalEventId: "ext-1" }] }),
    ...overrides
  };
}

function activity(overrides: Record<string, unknown> = {}) {
  return { key: "a", title: "讲座", kind: "activity", evidence: "讲座", ...overrides };
}

test("N1: exact lecture/course overlap is reported as 60 minutes", () => {
  const target = calendar();
  target.createEvent("course", existing());
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ modelText: JSON.stringify({ summaryZh: "通知", activities: [activity({ time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } })] }) }));
  assert.equal(result.status, "ok");
  assert.equal(result.activities[0].overlaps[0].overlapMinutes, 60);
  assert.equal(result.activities[0].overlaps[0].status, "confirmed");
  assert.equal(target.listEvents("2026-10-20T00:00:00+08:00", "2026-10-21T00:00:00+08:00").events.filter((event) => event.sources[0].kind === "email")[0].status, "tentative");
});

test("N2: adjacent intervals do not conflict", () => {
  const target = calendar();
  target.createEvent("course", existing({ time: { kind: "interval", startsAt: "2026-10-20T16:00:00+08:00", endsAt: "2026-10-20T17:00:00+08:00", timeZone: ZONE } }));
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ modelText: JSON.stringify({ summaryZh: "通知", activities: [activity({ time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } })] }) }));
  assert.deepEqual(result.activities[0].overlaps, []);
});

test("N3: one email reports two lectures independently", () => {
  const target = calendar();
  target.createEvent("course", existing());
  const result = new CalendarEmailAnalysisService(target).finalize(mail({
    emailId: "email-two-lectures", sourceKey: "mail-two-lectures",
    bodyText: "lecture A and lecture B",
    modelText: JSON.stringify({ summaryZh: "notice", activities: [
      activity({ key: "lecture-a", title: "lecture A", evidence: "lecture A", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } }),
      activity({ key: "lecture-b", title: "lecture B", evidence: "lecture B", time: { kind: "interval", startsAt: "2026-10-20T17:00:00+08:00", endsAt: "2026-10-20T18:00:00+08:00", timeZone: ZONE } })
    ] })
  }));
  assert.equal(result.activities.length, 2);
  assert.equal(result.activities[0].overlaps.length, 1);
  assert.equal(result.activities[0].overlaps[0].overlapMinutes, 60);
  assert.deepEqual(result.activities[1].overlaps, []);
});

test("E8: one email activity reports both overlapping events", () => {
  const target = calendar();
  target.createEvent("first", existing({ time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T15:00:00+08:00", timeZone: ZONE } }));
  target.createEvent("second", existing({ title: "???", time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T17:00:00+08:00", timeZone: ZONE } }));
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ modelText: JSON.stringify({ summaryZh: "??", activities: [activity({ time: { kind: "interval", startsAt: "2026-10-20T14:30:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } })] }) }));
  assert.equal(result.activities[0].overlaps.length, 2);
});

test("N4: replaying one email three times creates one result and one event", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  const input = mail();
  const first = service.finalize(input);
  assert.equal(service.finalize(input).checkedAt, first.checkedAt);
  assert.equal(service.finalize(input).checkedAt, first.checkedAt);
  assert.equal(target.repository.listEvents(target.ownerId).filter((event) => event.sources[0].kind === "email").length, 1);
  assert.equal(service.get(input.emailId)?.emailId, input.emailId);
});

test("N5: a one-week course cancellation suppresses only that week's conflict", () => {
  const target = calendar();
  const courses = new CourseCalendarService(target);
  const courseSeries: CourseSeriesInput = {
    title: "Linear Algebra", dayOfWeek: 2, localStart: "15:00", localEnd: "16:30", timeZone: ZONE,
    week1StartsOn: "2026-09-28", termStart: "2026-10-01", termEnd: "2026-10-31", teachingWeeks: "every_week", importKey: "math-weekly"
  };
  const imported = courses.importSeries("import-weekly-course", [courseSeries]);
  const thisWeek = target.listEvents("2026-10-20T00:00:00+08:00", "2026-10-21T00:00:00+08:00").events.find((event) => event.kind === "course");
  assert.ok(thisWeek);
  courses.setOccurrenceException("cancel-week-4", imported.series[0].id, "2026-10-20", "cancel", thisWeek.version);

  const service = new CalendarEmailAnalysisService(target);
  const thisWeekResult = service.finalize(mail({
    emailId: "email-week-4", sourceKey: "mail-week-4",
    modelText: JSON.stringify({ summaryZh: "??", activities: [activity({ key: "week-4", time: { kind: "interval", startsAt: "2026-10-20T15:30:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } })] })
  }));
  const nextWeekResult = service.finalize(mail({
    emailId: "email-week-5", sourceKey: "mail-week-5",
    modelText: JSON.stringify({ summaryZh: "??", activities: [activity({ key: "week-5", time: { kind: "interval", startsAt: "2026-10-27T15:30:00+08:00", endsAt: "2026-10-27T16:00:00+08:00", timeZone: ZONE } })] })
  }));
  assert.deepEqual(thisWeekResult.activities[0].overlaps, []);
  assert.equal(nextWeekResult.activities[0].overlaps.length, 1);
  assert.equal(nextWeekResult.activities[0].overlaps[0].overlapMinutes, 30);
});

test("E7: a later cancellation is a versioned proposal and leaves the tentative event", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  service.finalize(mail());
  const result = service.finalize(mail({ emailId: "email-cancel", sourceKey: "mail-cancel", modelText: JSON.stringify({ summaryZh: "??", activities: [activity({ action: "cancel", externalEventId: "ext-1", evidence: "ext-1" })] }) }));
  assert.equal(result.activities[0].status, "proposed");
  assert.equal(target.listProposals()[0].action, "cancel");
  const event = target.listEvents("2026-10-20T00:00:00+08:00", "2026-10-21T00:00:00+08:00").events.find((item) => item.sources.some((source) => source.kind === "email"));
  assert.equal(event?.status, "tentative");
  assert.equal(event?.sources.some((source) => source.ref === "mail-cancel"), true);
  assert.equal(target.listProposals()[0].expectedVersion, event?.version);
});

test("N6: date deadline is materialized, while an activity with only a start needs details", () => {
  const target = calendar();
  target.createEvent("course-start", existing({ time: { kind: "interval", startsAt: "2026-10-22T13:00:00+08:00", endsAt: "2026-10-22T15:00:00+08:00", timeZone: ZONE } }));
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ emailId: "email-details", sourceKey: "mail-details", bodyText: "截止日期和讲座开始时间", modelText: JSON.stringify({ summaryZh: "通知", activities: [
    activity({ key: "deadline", title: "提交截止", kind: "deadline", time: { kind: "date", onDate: "2026-10-22", timeZone: ZONE }, evidence: "截止日期" }),
    activity({ key: "start", title: "讲座", knownStart: { at: "2026-10-22T14:00:00+08:00", timeZone: ZONE }, evidence: "讲座开始时间" })
  ] }) }));
  assert.equal(result.activities[0].status, "created");
  assert.equal(result.activities[1].status, "needs_details");
  assert.equal(result.activities[1].eventId, undefined);
  assert.equal(result.activities[1].overlaps[0].overlapMinutes, 0);
  assert.match(renderEmailCalendarAnalysis(result), /2026-10-22 14:00.*结束时间未知/);
  assert.doesNotMatch(renderEmailCalendarAnalysis(result), /0 分钟/);
});

test("N7: analysis never claims the calendar is free", () => {
  const target = calendar();
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ emailId: "email-coverage", sourceKey: "mail-coverage", modelText: JSON.stringify({ summaryZh: "我有空", activities: [activity({ time: { kind: "interval", startsAt: "2026-10-23T14:00:00+08:00", endsAt: "2026-10-23T16:00:00+08:00", timeZone: ZONE } })] }) }));
  assert.equal(result.activities[0].coverage, "unverified");
  assert.doesNotMatch(renderEmailCalendarAnalysis(result), /有空|空闲|free/i);
});

test("N8: reliable external ID update stores a proposal without overwriting the event", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  const first = service.finalize(mail());
  const eventId = first.activities[0].eventId!;
  const result = service.finalize(mail({ emailId: "email-update", sourceKey: "mail-update", bodyText: "ext-1 改期", modelText: JSON.stringify({ summaryZh: "改期", activities: [activity({ title: "改期讲座", action: "update", externalEventId: "ext-1", evidence: "ext-1 改期", time: { kind: "interval", startsAt: "2026-10-20T17:00:00+08:00", endsAt: "2026-10-20T19:00:00+08:00", timeZone: ZONE } })] }) }));
  assert.equal(result.activities[0].status, "proposed");
  assert.equal(target.getEvent(eventId).title, "讲座");
  assert.equal(target.listProposals()[0].expectedVersion, target.getEvent(eventId).version);
});

test("email proposal approval rechecks conflicts and generic resolution cannot bypass policy", async () => {
  const target = calendar();
  const analysis = new CalendarEmailAnalysisService(target);
  const first = analysis.finalize(mail());
  const eventId = first.activities[0].eventId!;
  const revised = analysis.finalize(mail({ emailId: "email-review-update", sourceKey: "mail-review-update", bodyText: "讲座 ext-1 改至17点", modelText: JSON.stringify({ summaryZh: "改期", activities: [activity({ title: "讲座", action: "update", externalEventId: "ext-1", evidence: "ext-1 改至17点", time: { kind: "interval", startsAt: "2026-10-20T17:00:00+08:00", endsAt: "2026-10-20T19:00:00+08:00", timeZone: ZONE } })] }) }));
  const proposalId = revised.activities[0].proposalId!;
  target.createEvent("blocking-event", existing({ title: "已有安排", time: { kind: "interval", startsAt: "2026-10-20T18:00:00+08:00", endsAt: "2026-10-20T19:00:00+08:00", timeZone: ZONE } }));
  const app = express();
  app.use(express.json());
  app.use("/api/calendar", createCalendarRouter(target));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/calendar`;
  const headers = { "content-type": "application/json", cookie: `auto_mail_session=${createSessionToken(readSettings().auth)}` };
  try {
    const listed = await fetch(`${base}/proposals`, { headers });
    const list = await listed.json() as { emailReviews: Record<string, { subject: string; target: { id: string } }> };
    assert.equal(list.emailReviews[proposalId]?.subject, "活动通知");
    assert.equal(list.emailReviews[proposalId]?.target.id, eventId);
    const generic = await fetch(`${base}/proposals/${proposalId}/resolve`, { method: "POST", headers, body: JSON.stringify({ decision: "approve", operationKey: "unsafe-generic" }) });
    assert.equal(generic.status, 403);
    const conflicted = await fetch(`${base}/email-proposals/${proposalId}/resolve`, { method: "POST", headers, body: JSON.stringify({ decision: "approve", operationKey: "email-approve", expectedVersion: target.getEvent(eventId).version }) });
    assert.equal(conflicted.status, 409);
    assert.equal(target.getEvent(eventId).title, "讲座");
    assert.equal(target.listProposals()[0].state, "pending");
    const rejected = await fetch(`${base}/email-proposals/${proposalId}/resolve`, { method: "POST", headers, body: JSON.stringify({ decision: "reject", operationKey: "email-reject", expectedVersion: target.getEvent(eventId).version }) });
    assert.equal(rejected.status, 200);
    assert.equal(target.listProposals()[0].state, "rejected");
    const safeChange = analysis.finalize(mail({ emailId: "email-review-safe", sourceKey: "mail-review-safe", bodyText: "讲座 ext-1 改至20点", modelText: JSON.stringify({ summaryZh: "改期", activities: [activity({ title: "讲座", action: "update", externalEventId: "ext-1", evidence: "ext-1 改至20点", time: { kind: "interval", startsAt: "2026-10-20T20:00:00+08:00", endsAt: "2026-10-20T21:00:00+08:00", timeZone: ZONE } })] }) }));
    const safeId = safeChange.activities[0].proposalId!;
    const safeVersion = target.getEvent(eventId).version;
    const approved = await fetch(`${base}/email-proposals/${safeId}/resolve`, { method: "POST", headers, body: JSON.stringify({ decision: "approve", operationKey: "email-safe-approve", expectedVersion: safeVersion }) });
    assert.equal(approved.status, 200);
    const appliedTime = target.getEvent(eventId).time;
    assert.equal(appliedTime.kind, "interval");
    if (appliedTime.kind === "interval") assert.equal(appliedTime.startsAt, "2026-10-20T20:00:00+08:00");
    const replay = await fetch(`${base}/email-proposals/${safeId}/resolve`, { method: "POST", headers, body: JSON.stringify({ decision: "approve", operationKey: "email-safe-approve", expectedVersion: safeVersion }) });
    assert.equal(replay.status, 200);
    assert.equal(target.getEvent(eventId).version, safeVersion + 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    target.repository.db.close();
  }
});

test("N9: an email cannot forge a deletion without a module-owned external match", () => {
  const target = calendar();
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ emailId: "email-forged", sourceKey: "mail-forged", bodyText: "删除 fake-id", modelText: JSON.stringify({ summaryZh: "删除", activities: [activity({ action: "cancel", externalEventId: "fake-id", evidence: "fake-id" })] }) }));
  assert.equal(result.activities[0].status, "needs_review");
  assert.equal(target.listProposals().length, 0);
  assert.equal(target.repository.listEvents(target.ownerId).length, 0);
});

test("E1: supplied taskId is used for tool checks and proposal policy", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  service.finalize(mail({ taskId: "runtime-create-task" }));
  const check = target.repository.db.prepare("SELECT taskId FROM calendar_tool_checks ORDER BY createdAt DESC LIMIT 1").get() as { taskId: string };
  assert.equal(check.taskId, "runtime-create-task");
  const result = service.finalize(mail({
    taskId: "runtime-update-task", emailId: "email-task-update", sourceKey: "mail-task-update", bodyText: "ext-1 改期",
    modelText: JSON.stringify({ summaryZh: "改期", activities: [activity({ title: "改期讲座", action: "update", externalEventId: "ext-1", evidence: "ext-1 改期", time: { kind: "interval", startsAt: "2026-10-20T17:00:00+08:00", endsAt: "2026-10-20T19:00:00+08:00", timeZone: ZONE } })] })
  }));
  assert.equal(result.activities[0].status, "proposed");
  const policy = target.repository.db.prepare("SELECT taskId FROM calendar_tool_proposal_policies ORDER BY createdAt DESC LIMIT 1").get() as { taskId: string };
  assert.equal(policy.taskId, "runtime-update-task");
});

test("E2: overlap status distinguishes a tentative event and the renderer labels it", () => {
  const target = calendar();
  target.createEvent("tentative", existing({ title: "暂定安排", status: "tentative", time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } }));
  const result = new CalendarEmailAnalysisService(target).finalize(mail({ emailId: "email-tentative-overlap", sourceKey: "mail-tentative-overlap", modelText: JSON.stringify({ summaryZh: "通知", activities: [activity({ time: { kind: "interval", startsAt: "2026-10-20T14:30:00+08:00", endsAt: "2026-10-20T15:30:00+08:00", timeZone: ZONE } })] }) }));
  assert.equal(result.activities[0].overlaps[0].status, "tentative");
  assert.match(renderEmailCalendarAnalysis(result), /暂定/);
});

test("E3: same-time similar title from another email is saved for review without insertion", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  const model = JSON.stringify({ summaryZh: "通知", activities: [activity({ externalEventId: undefined, evidence: "讲座", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: ZONE } })] });
  service.finalize(mail({ emailId: "email-duplicate-one", sourceKey: "mail-duplicate-one", modelText: model }));
  const result = service.finalize(mail({ emailId: "email-duplicate-two", sourceKey: "mail-duplicate-two", modelText: model }));
  assert.equal(result.activities[0].status, "needs_review");
  assert.ok(result.activities[0].missing?.includes("possible_duplicate"));
  assert.equal(target.repository.listEvents(target.ownerId).filter((event) => event.sources[0].kind === "email").length, 1);
});

test("E4: mapped existing event is rechecked for current overlaps and gains the source", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  service.finalize(mail());
  target.createEvent("other-event", existing({ title: "另一安排", time: { kind: "interval", startsAt: "2026-10-20T14:30:00+08:00", endsAt: "2026-10-20T15:30:00+08:00", timeZone: ZONE } }));
  const result = service.finalize(mail({ emailId: "email-rematch", sourceKey: "mail-rematch" }));
  assert.equal(result.activities[0].status, "existing");
  assert.equal(result.activities[0].overlaps.length, 1);
  assert.equal(result.activities[0].overlaps[0].title, "另一安排");
  const event = target.getEvent(result.activities[0].eventId!);
  assert.equal(event.sources.some((source) => source.ref === "mail-rematch"), true);
  assert.equal(event.status, "tentative");
  assert.match(renderEmailCalendarAnalysis(result), /另一安排/);
});

test("E5: attachSource is versioned, reminder-safe, and duplicate-source idempotent", () => {
  const target = calendar();
  const event = target.createEvent("attach-base", existing({ status: "ignored", reminder: { enabled: true, minutesBefore: 15 } }));
  const attached = target.attachSource(event.id, event.version, "attach-source", { kind: "email", ref: "mail-1" });
  assert.equal(attached.version, event.version + 1);
  assert.equal(attached.status, "ignored");
  assert.deepEqual(attached.time, event.time);
  assert.deepEqual(attached.reminder, event.reminder);
  const replay = target.attachSource(attached.id, event.version, "attach-source", { kind: "email", ref: "mail-1" });
  assert.equal(replay.version, attached.version);
  const duplicate = target.attachSource(attached.id, attached.version, "attach-source-2", { kind: "email", ref: "mail-1" });
  assert.equal(duplicate.version, attached.version);
  assert.equal(duplicate.sources.filter((source) => source.kind === "email" && source.ref === "mail-1").length, 1);
});

test("E6: a cancelled mapped event keeps the user decision while adding a later source", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  const first = service.finalize(mail());
  const cancellation = service.finalize(mail({ emailId: "email-cancel-apply", sourceKey: "mail-cancel-apply", modelText: JSON.stringify({ summaryZh: "取消", activities: [activity({ action: "cancel", externalEventId: "ext-1", evidence: "ext-1" })] }) }));
  const proposal = target.listProposals()[0];
  target.resolveProposal(proposal.id, "approve", "apply-cancel", proposal.expectedVersion);
  const followUp = service.finalize(mail({ emailId: "email-after-cancel", sourceKey: "mail-after-cancel" }));
  const event = target.getEvent(first.activities[0].eventId!);
  assert.equal(cancellation.activities[0].status, "proposed");
  assert.equal(followUp.activities[0].status, "ignored");
  assert.equal(event.status, "cancelled");
  assert.equal(event.sources.some((source) => source.ref === "mail-after-cancel"), true);
});

test("strict model JSON and evidence failures are durably recorded", () => {
  const target = calendar();
  const service = new CalendarEmailAnalysisService(target);
  const malformed = service.finalize(mail({ emailId: "bad-json", modelText: "{not-json}" }));
  assert.equal(malformed.status, "failed");
  const forgedEvidence = service.finalize(mail({ emailId: "bad-evidence", modelText: JSON.stringify({ summaryZh: "x", activities: [activity({ evidence: "not in email" })] }) }));
  assert.equal(forgedEvidence.status, "failed");
});

test("extraction validation reports recoverable evidence errors without persistence", () => {
  const modelText = JSON.stringify({ summaryZh: "讲座", activities: [activity({ externalEventId: "ext-1", evidence: "讲座" })] });
  assert.deepEqual(validateEmailCalendarExtraction(modelText, "讲座 ext-1 将于本周举行", "通知"), {
    ok: false,
    message: "activities[0].externalEventId is not in evidence"
  });
  assert.deepEqual(validateEmailCalendarExtraction("{not-json}", "", ""), {
    ok: false,
    message: "modelText must be strict JSON"
  });
  assert.deepEqual(validateEmailCalendarExtraction(mail().modelText, mail().bodyText, mail().subject), { ok: true });
});
