import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CalendarRepository } from "./repository";
import { CalendarError, CalendarService } from "./service";
import { CourseCalendarService, type CourseSeriesInput } from "./courses";

const TIME_ZONE = "Asia/Shanghai";

function series(overrides: Partial<CourseSeriesInput> = {}): CourseSeriesInput {
  return {
    title: "Linear Algebra",
    dayOfWeek: 2,
    localStart: "10:00",
    localEnd: "11:30",
    timeZone: TIME_ZONE,
    termStart: "2026-01-05",
    termEnd: "2026-02-01",
    week1StartsOn: "2026-01-05",
    teachingWeeks: [1, 3],
    importKey: "math-101",
    ...overrides
  };
}

function course(ownerId = "owner-a") {
  const database = new DatabaseSync(":memory:");
  return { database, service: new CourseCalendarService(database, ownerId) };
}

function allEvents(service: CourseCalendarService) {
  return service.calendar.listEvents("2026-01-04T16:00:00Z", "2026-02-02T16:00:00Z").events;
}

function startsAt(event: ReturnType<typeof allEvents>[number]) {
  assert.equal(event.time.kind, "interval");
  return event.time.startsAt;
}

function endsAt(event: ReturnType<typeof allEvents>[number]) {
  assert.equal(event.time.kind, "interval");
  return event.time.endsAt;
}

function weeklyIcs() {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Calendar//EN",
    "BEGIN:VEVENT",
    "UID:ics-math-101",
    "DTSTAMP:20251201T000000Z",
    "DTSTART;TZID=Asia/Shanghai:20260106T100000",
    "DTEND;TZID=Asia/Shanghai:20260106T113000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:ICS Mathematics",
    "LOCATION:Room 101",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

function weeklyIcsWithOverride() {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Calendar//EN",
    "BEGIN:VEVENT",
    "UID:ics-override",
    "DTSTAMP:20251201T000000Z",
    "DTSTART;TZID=Asia/Shanghai:20260106T100000",
    "DTEND;TZID=Asia/Shanghai:20260106T113000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:ICS Override",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:ics-override",
    "DTSTAMP:20251201T000000Z",
    "RECURRENCE-ID;TZID=Asia/Shanghai:20260113T100000",
    "DTSTART;TZID=Asia/Shanghai:20260113T120000",
    "DTEND;TZID=Asia/Shanghai:20260113T133000",
    "SUMMARY:ICS Override",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

function weeklyIcsWithCancellation() {
  return weeklyIcsWithOverride()
    .replace(
      "RECURRENCE-ID;TZID=Asia/Shanghai:20260113T100000\r\nDTSTART;TZID=Asia/Shanghai:20260113T120000\r\nDTEND;TZID=Asia/Shanghai:20260113T133000",
      "RECURRENCE-ID;TZID=Asia/Shanghai:20260113T100000\r\nDTSTART;TZID=Asia/Shanghai:20260113T100000\r\nDTEND;TZID=Asia/Shanghai:20260113T113000\r\nSTATUS:CANCELLED"
    );
}

function weeklyIcsWithDst() {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Calendar//EN",
    "BEGIN:VEVENT",
    "UID:ics-dst",
    "DTSTAMP:20251201T000000Z",
    "DTSTART;TZID=America/New_York:20260303T100000",
    "DTEND;TZID=America/New_York:20260303T110000",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "SUMMARY:DST Course",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

test("expands only the selected teaching weeks and stays inside the term", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("weeks-1", [series({ id: "client-supplied-id" })]);
    assert.equal(imported.created, 1);
    assert.notEqual(imported.series[0].id, "client-supplied-id");
    assert.equal(imported.occurrences, 2);
    assert.equal(imported.createdOccurrences, 2);
    assert.deepEqual(allEvents(service).map((event) => event.time.kind === "interval" ? event.time.startsAt : ""), [
      "2026-01-06T02:00:00Z",
      "2026-01-20T02:00:00Z"
    ]);
    assert.equal(allEvents(service).every((event) => event.kind === "course" && event.status === "confirmed"), true);
  } finally {
    database.close();
  }
});

test("does not materialize occurrences outside the term even when a teaching week points beyond it", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("range-1", [series({ termEnd: "2026-01-10", teachingWeeks: "every_week" })]);
    assert.equal(imported.occurrences, 1);
    assert.equal(allEvents(service).length, 1);
    assert.equal(endsAt(allEvents(service)[0]), "2026-01-06T03:30:00Z");
  } finally {
    database.close();
  }
});

test("allows week one to begin before a term whose first date is mid-week", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("midweek-term", [series({
      termStart: "2026-01-07",
      termEnd: "2026-01-20",
      week1StartsOn: "2026-01-05",
      teachingWeeks: [1, 2]
    })]);
    assert.equal(imported.occurrences, 1);
    assert.equal(startsAt(allEvents(service)[0]), "2026-01-13T02:00:00Z");
  } finally {
    database.close();
  }
});

test("reimporting the same import key is idempotent and does not duplicate events", () => {
  const { database, service } = course();
  try {
    const input = series();
    service.importSeries("same-1", [input]);
    const replay = service.importSeries("same-2", [input]);
    assert.equal(replay.created, 0);
    assert.equal(replay.changed, 0);
    assert.equal(replay.createdOccurrences, 0);
    assert.equal(allEvents(service).length, 2);
    assert.equal(service.importSeries("same-1", [input]).created, 1);
    assert.equal(allEvents(service).length, 2);
  } finally {
    database.close();
  }
});

test("changed imports create a pending proposal and leave the active series and events unchanged", () => {
  const { database, service } = course();
  try {
    service.importSeries("change-1", [series()]);
    const changed = service.importSeries("change-2", [series({ localStart: "11:00", localEnd: "12:30" })]);
    assert.equal(changed.created, 0);
    assert.equal(changed.changed, 1);
    assert.equal(changed.proposals.length, 1);
    assert.equal(service.listSeries()[0].localStart, "10:00");
    assert.equal(startsAt(allEvents(service)[0]), "2026-01-06T02:00:00Z");
    assert.equal(service.listImportProposals("pending").length, 1);
  } finally {
    database.close();
  }
});

test("accepting a series proposal is atomic, versioned, and preserves manual occurrence edits", () => {
  const { database, service } = course();
  try {
    const first = service.importSeries("accept-1", [series()]);
    const manuallyEdited = allEvents(service).find((event) => event.sources[0].ref.endsWith("2026-01-20"))!;
    service.calendar.updateEvent(manuallyEdited.id, manuallyEdited.version, "manual-title-edit", { title: "本人修改的课程名" });
    const changed = service.importSeries("accept-2", [series({
      localStart: "11:00", localEnd: "12:30", location: "Room 202", teachingWeeks: [2, 3]
    })]);
    const proposal = changed.proposals[0];
    const applied = service.resolveImportProposal(proposal.id, "approve", "accept-proposal");
    assert.equal(applied.state, "applied");
    assert.equal(service.listSeries()[0].localStart, "11:00");

    const events = allEvents(service);
    const removed = events.find((event) => event.sources[0].ref.endsWith("2026-01-06"));
    const added = events.find((event) => event.sources[0].ref.endsWith("2026-01-13"));
    const preserved = events.find((event) => event.sources[0].ref.endsWith("2026-01-20"));
    assert.equal(removed?.status, "cancelled");
    assert.equal(startsAt(added!), "2026-01-13T03:00:00Z");
    assert.equal(preserved?.title, "本人修改的课程名");
    assert.equal(startsAt(preserved!), "2026-01-20T02:00:00Z");
    assert.deepEqual(service.resolveImportProposal(proposal.id, "approve", "accept-proposal"), applied);
    assert.equal(allEvents(service).length, 3);
    assert.equal(first.series[0].id, applied.proposed.id);
  } finally {
    database.close();
  }
});

test("rejecting a proposal is retained and the same candidate does not become pending again", () => {
  const { database, service } = course();
  try {
    service.importSeries("reject-1", [series()]);
    const changed = series({ localStart: "11:00", localEnd: "12:30" });
    const pending = service.importSeries("reject-2", [changed]).proposals[0];
    const rejected = service.resolveImportProposal(pending.id, "reject", "reject-proposal");
    assert.equal(rejected.state, "rejected");
    const replay = service.importSeries("reject-3", [changed]);
    assert.equal(replay.rejected, 1);
    assert.equal(replay.proposals[0].state, "rejected");
    assert.equal(service.listImportProposals("pending").length, 0);
    assert.equal(service.listImportProposals("rejected").length, 1);
    assert.equal(service.listSeries()[0].localStart, "10:00");
  } finally {
    database.close();
  }
});

test("accepting an old proposal is blocked after the series version advances", () => {
  const { database, service } = course();
  try {
    service.importSeries("stale-1", [series()]);
    const first = service.importSeries("stale-2", [series({ localStart: "11:00", localEnd: "12:30" })]).proposals[0];
    const second = service.importSeries("stale-3", [series({ localStart: "12:00", localEnd: "13:30" })]).proposals[0];
    service.resolveImportProposal(second.id, "approve", "stale-approve-new");
    assert.throws(
      () => service.resolveImportProposal(first.id, "approve", "stale-approve-old"),
      (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
    );
    assert.equal(service.listSeries()[0].localStart, "12:00");
    assert.equal(service.listImportProposals("stale").length, 1);
    assert.equal(allEvents(service).filter((event) => event.status === "confirmed").length, 2);
  } finally {
    database.close();
  }
});

test("a legacy proposal without an expected version fails closed and must be reimported", () => {
  const { database, service } = course();
  try {
    service.importSeries("legacy-version-1", [series()]);
    const proposal = service.importSeries("legacy-version-2", [series({ localStart: "11:00", localEnd: "12:30" })]).proposals[0];
    const row = service.store.db.prepare("SELECT data FROM calendar_course_import_proposals WHERE ownerId = ? AND id = ?").get(service.ownerId, proposal.id) as { data: string };
    const legacy = JSON.parse(row.data) as Record<string, unknown>;
    delete legacy.expectedVersion;
    service.store.db.prepare("UPDATE calendar_course_import_proposals SET data = ? WHERE ownerId = ? AND id = ?").run(JSON.stringify(legacy), service.ownerId, proposal.id);
    assert.throws(
      () => service.resolveImportProposal(proposal.id, "approve", "legacy-version-approve"),
      (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
    );
    assert.equal(service.listSeries()[0].localStart, "10:00");
    assert.equal(service.listImportProposals("stale").length, 1);
  } finally {
    database.close();
  }
});

test("failed proposal application rolls back the series and keeps the proposal pending", () => {
  const { database, service } = course();
  try {
    service.importSeries("rollback-1", [series()]);
    const changed = service.importSeries("rollback-2", [series({ localStart: "11:00", localEnd: "12:30" })]).proposals[0];
    const instance = service.store.getInstance(service.ownerId, changed.seriesId, "2026-01-06");
    assert.ok(instance);
    service.store.db.prepare("DELETE FROM calendar_events WHERE ownerId = ? AND id = ?").run(service.ownerId, instance.eventId);
    assert.throws(() => service.resolveImportProposal(changed.id, "approve", "rollback-approve"));
    assert.equal(service.listSeries()[0].localStart, "10:00");
    assert.equal(service.listImportProposals("pending").length, 1);
  } finally {
    database.close();
  }
});

test("accepting a later series proposal does not resurrect a manually cancelled occurrence", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("manual-cancel-series-1", [series()]);
    const occurrence = allEvents(service).find((event) => event.sources[0].ref.endsWith("2026-01-06"))!;
    service.calendar.cancelEvent(occurrence.id, occurrence.version, "manual-cancel-occurrence");
    const proposal = service.importSeries("manual-cancel-series-2", [series({ localStart: "11:00", localEnd: "12:30" })]).proposals[0];
    service.resolveImportProposal(proposal.id, "approve", "manual-cancel-approve");
    const after = allEvents(service).find((event) => event.sources[0].ref.endsWith("2026-01-06"));
    assert.equal(after?.status, "cancelled");
    assert.equal(after?.version, occurrence.version + 1);
    assert.equal(imported.series[0].id, proposal.seriesId);
  } finally {
    database.close();
  }
});

test("a cancellation exception affects one occurrence and remains a tombstone after reimport", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("cancel-1", [series()]);
    const canceledDate = "2026-01-06";
    const result = service.setOccurrenceException("cancel-exception-1", imported.series[0].id, canceledDate, "cancel", 1);
    assert.equal(result.exception.action, "cancel");
    assert.equal(result.event?.status, "cancelled");
    assert.equal(allEvents(service).filter((event) => event.status === "confirmed").length, 1);
    assert.equal(allEvents(service).find((event) => event.sources[0].ref.endsWith(canceledDate))?.status, "cancelled");
    service.importSeries("cancel-2", [series()]);
    assert.equal(allEvents(service).find((event) => event.sources[0].ref.endsWith(canceledDate))?.status, "cancelled");
  } finally {
    database.close();
  }
});

test("a move exception changes only one occurrence", () => {
  const { database, service } = course();
  try {
    const imported = service.importSeries("move-1", [series()]);
    const moved = service.setOccurrenceException("move-exception-1", imported.series[0].id, "2026-01-06", {
      localStart: "13:00",
      localEnd: "14:30",
      location: "Room 202"
    }, 1);
    assert.equal(moved.event && startsAt(moved.event), "2026-01-06T05:00:00Z");
    assert.equal(moved.event?.location, "Room 202");
    assert.throws(
      () => service.setOccurrenceException("move-stale", imported.series[0].id, "2026-01-06", {
        localStart: "15:00",
        localEnd: "16:30"
      }, 1),
      (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
    );
    const untouched = allEvents(service).find((event) => event.sources[0].ref.endsWith("2026-01-20"));
    assert.equal(untouched && startsAt(untouched), "2026-01-20T02:00:00Z");
  } finally {
    database.close();
  }
});

test("course series and exceptions are isolated by owner", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = new CourseCalendarService(database, "owner-a");
    const other = new CourseCalendarService(database, "owner-b");
    const imported = owner.importSeries("owner-1", [series()]);
    assert.equal(other.listSeries().length, 0);
    assert.throws(
      () => other.setOccurrenceException("owner-exception", imported.series[0].id, "2026-01-06", "cancel", 1),
      (error: unknown) => error instanceof CalendarError && error.code === "NOT_FOUND"
    );
    assert.equal(owner.calendar.listEvents("2026-01-04T16:00:00Z", "2026-02-02T16:00:00Z").events.length, 2);
  } finally {
    database.close();
  }
});

test("reusing an owner-bound CalendarService keeps course rows and events under the same owner", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const calendar = new CalendarService(new CalendarRepository(database), "owner-bound");
    const service = new CourseCalendarService(calendar);
    const imported = service.importSeries("bound-1", [series()]);
    assert.equal(service.ownerId, "owner-bound");
    assert.equal(imported.series[0].ownerId, "owner-bound");
    assert.equal(allEvents(service).every((event) => event.ownerId === "owner-bound"), true);
  } finally {
    database.close();
  }
});

test("imports a simple weekly ICS event and replays the operation", () => {
  const { database, service } = course();
  try {
    const options = { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" };
    const imported = service.importIcs("ics-1", weeklyIcs(), options);
    assert.equal(imported.sourceEvents, 1);
    assert.equal(imported.created, 1);
    assert.equal(imported.occurrences, 3);
    assert.equal(imported.createdOccurrences, 3);
    assert.equal(imported.series[0].title, "ICS Mathematics");
    assert.deepEqual(allEvents(service).map((event) => event.sources[0].ref), [
      "course:ics:ics-math-101:2026-01-06",
      "course:ics:ics-math-101:2026-01-13",
      "course:ics:ics-math-101:2026-01-20"
    ]);
    const replay = service.importIcs("ics-1", weeklyIcs(), options);
    assert.deepEqual(replay, imported);
    assert.equal(allEvents(service).length, 3);
  } finally {
    database.close();
  }
});

test("a later ICS import cannot overwrite a manual exception on the same occurrence", () => {
  const { database, service } = course();
  try {
    const options = { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" };
    const first = service.importIcs("ics-override-1", weeklyIcsWithOverride(), options);
    const seriesId = first.series[0].id;
    const manual = service.setOccurrenceException("manual-after-ics", seriesId, "2026-01-13", {
      localStart: "13:00",
      localEnd: "14:30"
    }, 2);
    assert.equal(manual.exception.origin, "manual");
    assert.equal(startsAt(manual.event!), "2026-01-13T05:00:00Z");

    service.importIcs("ics-override-2", weeklyIcsWithOverride(), options);
    const event = allEvents(service).find((item) => item.sources[0].ref.endsWith("2026-01-13"));
    assert.equal(event && startsAt(event), "2026-01-13T05:00:00Z");
    assert.equal(service.listExceptions(seriesId)[0].origin, "manual");
    assert.equal(service.listExceptions(seriesId)[0].version, 2);
  } finally {
    database.close();
  }
});

test("a web event edit after an imported exception is preserved by a later changed ICS import", () => {
  const { database, service } = course();
  try {
    const options = { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" };
    const first = service.importIcs("ics-web-edit-1", weeklyIcsWithOverride(), options);
    const original = allEvents(service).find((item) => item.sources[0].ref.endsWith("2026-01-13"))!;
    const edited = service.calendar.updateEvent(original.id, original.version, "web-edit-1", { title: "本人修改" });
    assert.equal(edited.version, original.version + 1);
    const changedIcs = weeklyIcsWithOverride()
      .replace("DTSTART;TZID=Asia/Shanghai:20260106T100000\r\nDTEND;TZID=Asia/Shanghai:20260106T113000", "DTSTART;TZID=Asia/Shanghai:20260106T110000\r\nDTEND;TZID=Asia/Shanghai:20260106T123000")
      .replace("DTSTART;TZID=Asia/Shanghai:20260113T120000", "DTSTART;TZID=Asia/Shanghai:20260113T130000")
      .replace("DTEND;TZID=Asia/Shanghai:20260113T133000", "DTEND;TZID=Asia/Shanghai:20260113T143000");
    service.importIcs("ics-web-edit-2", changedIcs, options);
    const after = allEvents(service).find((item) => item.sources[0].ref.endsWith("2026-01-13"))!;
    assert.equal(after.title, "本人修改");
    assert.equal(startsAt(after), "2026-01-13T04:00:00Z");
    assert.equal(first.series[0].localStart, "10:00");
  } finally {
    database.close();
  }
});

test("pending series changes prevent ICS occurrence exceptions from being applied", () => {
  const { database, service } = course();
  try {
    const options = { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" };
    service.importIcs("ics-pending-1", weeklyIcsWithOverride(), options);
    const changedIcs = weeklyIcsWithOverride()
      .replace("DTSTART;TZID=Asia/Shanghai:20260106T100000\r\nDTEND;TZID=Asia/Shanghai:20260106T113000", "DTSTART;TZID=Asia/Shanghai:20260106T110000\r\nDTEND;TZID=Asia/Shanghai:20260106T123000");
    const result = service.importIcs("ics-pending-2", changedIcs, options);
    assert.equal(result.proposals.length, 1);
    assert.equal(startsAt(allEvents(service).find((item) => item.sources[0].ref.endsWith("2026-01-06"))!), "2026-01-06T02:00:00Z");
  } finally {
    database.close();
  }
});

test("ICS cancelled overrides leave a cancelled tombstone for only that week", () => {
  const { database, service } = course();
  try {
    const result = service.importIcs("ics-cancelled", weeklyIcsWithCancellation(), {
      termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05"
    });
    assert.equal(result.errors.length, 0);
    const events = allEvents(service);
    assert.equal(events.filter((event) => event.status === "confirmed").length, 2);
    assert.equal(events.find((event) => event.sources[0].ref.endsWith("2026-01-13"))?.status, "cancelled");
    assert.equal(service.listExceptions(result.series[0].id)[0].action, "cancel");
    assert.equal(service.listExceptions(result.series[0].id)[0].origin, "import");
  } finally {
    database.close();
  }
});

test("unsupported multi-day and cross-date ICS recurrences are rejected explicitly", () => {
  const { database, service } = course();
  try {
    const multiDay = service.importIcs("ics-multiday", weeklyIcs().replace(
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4"
    ), { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" });
    assert.equal(multiDay.created, 0);
    assert.equal(multiDay.rejected, 1);
    assert.match(multiDay.errors[0].message, /multi-day/);

    const crossDate = service.importIcs("ics-cross-date", weeklyIcsWithOverride()
      .replace("DTSTART;TZID=Asia/Shanghai:20260113T120000", "DTSTART;TZID=Asia/Shanghai:20260114T120000")
      .replace("DTEND;TZID=Asia/Shanghai:20260113T133000", "DTEND;TZID=Asia/Shanghai:20260114T133000"), {
        termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05"
      });
    assert.equal(crossDate.created, 0);
    assert.equal(crossDate.rejected, 1);
    assert.match(crossDate.errors[0].message, /cross-date/);

    const multiTime = service.importIcs("ics-multitime", weeklyIcs().replace(
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "RRULE:FREQ=WEEKLY;BYHOUR=10,12;COUNT=4"
    ), { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" });
    assert.equal(multiTime.created, 0);
    assert.equal(multiTime.rejected, 1);
    assert.match(multiTime.errors[0].message, /multiple times/);
    const shifted = service.importIcs("ics-shifted-hour", weeklyIcs().replace(
      "RRULE:FREQ=WEEKLY;COUNT=3", "RRULE:FREQ=WEEKLY;BYHOUR=12;COUNT=3"
    ), { termStart: "2026-01-05", termEnd: "2026-01-25", week1StartsOn: "2026-01-05" });
    assert.equal(shifted.created, 0);
    assert.equal(shifted.rejected, 1);
    assert.match(shifted.errors[0].message, /changes weekday or time/);
  } finally {
    database.close();
  }
});

test("ICS timezone takes precedence over the fallback and preserves local time across DST", () => {
  const { database, service } = course();
  try {
    const result = service.importIcs("ics-dst", weeklyIcsWithDst(), {
      termStart: "2026-03-02", termEnd: "2026-03-15", week1StartsOn: "2026-03-02", timeZone: TIME_ZONE
    });
    assert.equal(result.series[0].timeZone, "America/New_York");
    const starts = service.calendar.listEvents("2026-03-01T00:00:00Z", "2026-03-16T00:00:00Z").events.map(startsAt);
    assert.deepEqual(starts, ["2026-03-03T15:00:00Z", "2026-03-10T14:00:00Z"]);
  } finally {
    database.close();
  }
});
