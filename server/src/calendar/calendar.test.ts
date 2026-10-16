import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { createSessionToken } from "../auth-crypto";
import { readSettings } from "../store";
import { CalendarRepository } from "./repository";
import { CalendarError, CalendarService } from "./service";
import { createCalendarRouter } from "./routes";
import type { CalendarEventInput } from "./types";

const FROM = "2026-10-16T00:00:00+08:00";
const TO = "2026-10-23T00:00:00+08:00";

function intervalEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    title: "讲座",
    kind: "activity",
    time: {
      kind: "interval",
      startsAt: "2026-10-20T10:00:00+08:00",
      endsAt: "2026-10-20T11:00:00+08:00",
      timeZone: "Asia/Shanghai"
    },
    status: "confirmed",
    sources: [{ kind: "manual", ref: "test" }],
    ...overrides
  };
}

function service(ownerId = "local-owner") {
  return new CalendarService(new CalendarRepository(new DatabaseSync(":memory:")), ownerId);
}

test("create is durable, source-linked, versioned, and replaying after cancel never resurrects it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "calendar-test-"));
  const filename = path.join(directory, "calendar.sqlite");
  try {
    const firstDb = new DatabaseSync(filename);
    const first = new CalendarService(new CalendarRepository(firstDb));
    const created = first.createEvent("create-1", intervalEvent());
    const replay = first.createEvent("create-1", intervalEvent());
    assert.equal(replay.id, created.id);
    assert.equal(replay.version, 1);
    const cancelled = first.cancelEvent(created.id, 1, "cancel-1");
    assert.equal(cancelled.status, "cancelled");
    const replayAfterCancel = first.createEvent("create-1", intervalEvent());
    assert.equal(replayAfterCancel.id, created.id);
    assert.equal(replayAfterCancel.status, "cancelled");
    firstDb.close();

    const secondDb = new DatabaseSync(filename);
    const second = new CalendarService(new CalendarRepository(secondDb));
    assert.equal(second.getEvent(created.id).status, "cancelled");
    assert.equal(second.getEvent(created.id).sources[0].ref, "test");
    secondDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("different operations can intentionally create same-title events, but reused keys conflict", () => {
  const calendar = service();
  const first = calendar.createEvent("create-a", intervalEvent());
  const second = calendar.createEvent("create-b", intervalEvent());
  assert.notEqual(first.id, second.id);
  assert.throws(
    () => calendar.createEvent("create-a", intervalEvent({ title: "changed" })),
    (error: unknown) => error instanceof CalendarError && error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("owner scope, invalid times, optimistic versions, and interval-only overlap advisory are enforced", () => {
  const database = new DatabaseSync(":memory:");
  const repository = new CalendarRepository(database);
  const owner = new CalendarService(repository, "owner-a");
  const other = new CalendarService(repository, "owner-b");
  const first = owner.createEvent("one", intervalEvent());
  assert.throws(() => other.getEvent(first.id), (error: unknown) => error instanceof CalendarError && error.code === "NOT_FOUND");
  assert.throws(
    () => owner.createEvent("bad", intervalEvent({
      time: { kind: "interval", startsAt: "2026-10-20T11:00:00", endsAt: "2026-10-20T10:00:00Z", timeZone: "Asia/Shanghai" }
    })),
    (error: unknown) => error instanceof CalendarError && error.code === "INVALID_TIME"
  );
  assert.throws(
    () => owner.createEvent("bad-date", intervalEvent({
      time: { kind: "point", at: "2026-02-30T10:00:00+08:00", timeZone: "Asia/Shanghai" }
    })),
    (error: unknown) => error instanceof CalendarError && error.code === "INVALID_TIME"
  );
  const point = owner.createEvent("point", intervalEvent({
    time: { kind: "point", at: "2026-10-20T10:30:00+08:00", timeZone: "Asia/Shanghai" }
  }));
  const overlap = owner.createEvent("overlap", intervalEvent({
    time: { kind: "interval", startsAt: "2026-10-20T10:30:00+08:00", endsAt: "2026-10-20T11:30:00+08:00", timeZone: "Asia/Shanghai" }
  }));
  const listed = owner.listEvents(FROM, TO);
  assert.equal(listed.events.some((event) => event.id === point.id), true);
  assert.deepEqual(listed.conflicts, [{ eventId: first.id, otherEventId: overlap.id, reason: "overlap" }]);
  assert.throws(() => owner.updateEvent(first.id, 99, "stale", { title: "new" }), (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT");
  database.close();
});

test("proposal approval is version-checked, stale proposals stay stale, and repeated approval is idempotent", () => {
  const calendar = service();
  const original = calendar.createEvent("create", intervalEvent());
  const proposal = calendar.createProposal({
    operationKey: "proposal-1",
    action: "update",
    targetId: original.id,
    expectedVersion: 1,
    patch: { title: "改期讲座" },
    evidence: "manual review"
  });
  calendar.updateEvent(original.id, 1, "direct-change", { location: "Room 1" });
  assert.throws(
    () => calendar.resolveProposal(proposal.id, "approve", "resolve-1"),
    (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
  );
  assert.equal(calendar.listProposals("stale")[0].state, "stale");

  const fresh = calendar.createProposal({
    operationKey: "proposal-2",
    action: "update",
    targetId: original.id,
    expectedVersion: 2,
    patch: { title: "最终标题" },
    evidence: "manual review"
  });
  const applied = calendar.resolveProposal(fresh.id, "approve", "resolve-2");
  const repeated = calendar.resolveProposal(fresh.id, "approve", "resolve-2");
  assert.equal(applied.proposal.state, "applied");
  assert.equal(repeated.proposal.resultEventId, applied.proposal.resultEventId);
  assert.equal(calendar.getEvent(original.id).title, "最终标题");
  assert.equal(calendar.getEvent(original.id).version, 3);
});

test("proposal approval cannot override its stored version and cancelled events cannot be revived", () => {
  const calendar = service();
  const original = calendar.createEvent("create", intervalEvent());
  const proposal = calendar.createProposal({
    operationKey: "proposal-cancelled",
    action: "update",
    targetId: original.id,
    expectedVersion: 1,
    patch: { title: "不会应用" },
    evidence: "manual review"
  });
  assert.throws(
    () => calendar.resolveProposal(proposal.id, "approve", "resolve-wrong-version", 2),
    (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
  );
  calendar.cancelEvent(original.id, 1, "cancel");
  assert.throws(
    () => calendar.resolveProposal(proposal.id, "approve", "resolve-cancelled"),
    (error: unknown) => error instanceof CalendarError && error.code === "VERSION_CONFLICT"
  );
  assert.equal(calendar.getEvent(original.id).status, "cancelled");
  assert.throws(
    () => calendar.createProposal({ operationKey: "unsupported", action: "plan", evidence: "test" }),
    (error: unknown) => error instanceof CalendarError && error.code === "INVALID_INPUT"
  );
});

test("date-only events use their IANA timezone when filtering an instant range", () => {
  const calendar = service();
  const event = calendar.createEvent("date", {
    title: "截止日",
    kind: "deadline",
    time: { kind: "date", onDate: "2026-10-20", timeZone: "Asia/Shanghai" },
    status: "confirmed",
    sources: [{ kind: "manual", ref: "date-test" }]
  });
  const result = calendar.listEvents("2026-10-19T16:00:00Z", "2026-10-20T16:00:00Z");
  assert.equal(result.events.some((item) => item.id === event.id), true);
});

test("replayed extraction preserves ignored and confirmed decisions and cannot replace a candidate source", () => {
  const calendar = service();
  const input = {
    id: "mail-candidate", title: "讲座", source: { kind: "email", ref: "mail-1:1" },
    evidence: "邮件原文", state: "ignored", missing: [], kind: "activity",
    time: { kind: "interval", startsAt: "2026-10-20T10:00:00+08:00", endsAt: "2026-10-20T11:00:00+08:00", timeZone: "Asia/Shanghai" }
  };
  calendar.upsertCandidate(input);
  assert.equal(calendar.upsertCandidate({ ...input, state: "ready" }).state, "ignored");
  assert.throws(
    () => calendar.upsertCandidate({ ...input, source: { kind: "email", ref: "mail-2:1" } }),
    (error: unknown) => error instanceof CalendarError && error.code === "IDEMPOTENCY_CONFLICT"
  );
  const confirmed = calendar.confirmCandidate(input.id, "explicit-confirm");
  assert.ok(confirmed.event);
  const replayed = calendar.upsertCandidate({ ...input, title: "旧提取结果", state: "ready" });
  assert.equal(replayed.state, "confirmed");
  assert.equal(replayed.title, confirmed.candidate.title);
  assert.equal(calendar.listEvents(FROM, TO).events.length, 1);
});

test("HTTP router requires auth and returns the documented wrapped event/list shapes", async () => {
  const database = new DatabaseSync(":memory:");
  const app = express();
  app.use(express.json());
  app.use("/api/calendar", createCalendarRouter(database));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthenticated = await fetch(`${base}/api/calendar/events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    assert.equal(unauthenticated.status, 401);
    const cookie = `auto_mail_session=${createSessionToken(readSettings().auth)}`;
    const createdResponse = await fetch(`${base}/api/calendar/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ operationKey: "http-create", event: intervalEvent() })
    });
    assert.equal(createdResponse.status, 201);
    const createdBody = await createdResponse.json() as { event: { id: string } };
    const listedResponse = await fetch(`${base}/api/calendar/events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, { headers: { cookie } });
    assert.equal(listedResponse.status, 200);
    const listedBody = await listedResponse.json() as { events: Array<{ id: string }>; conflicts: unknown[] };
    assert.equal(listedBody.events[0].id, createdBody.event.id);
    assert.ok(Array.isArray(listedBody.conflicts));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  }
});
