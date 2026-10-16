import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backupCalendarDatabase, verifyCalendarCopy } from "./calendar-backup";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "calendar-backup-test-"));
  const source = path.join(directory, "app.sqlite");
  const destination = path.join(directory, "backups", "app-copy.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE calendar_events (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE calendar_agent_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE calendar_delivery_outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE credentials (key TEXT PRIMARY KEY, envelope TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO calendar_events VALUES (?, ?, ?)").run("event-1", "tentative", "calendar event");
  db.prepare("INSERT INTO calendar_agent_tasks VALUES (?, ?, ?)").run("task-1", "succeeded", "calendar task");
  db.prepare("INSERT INTO calendar_delivery_outbox VALUES (?, ?, ?)").run("calendar-delivery-1", "accepted", "calendar reminder");
  db.prepare("INSERT INTO notification_deliveries VALUES (?, ?, ?)").run("delivery-1", "sent", "sent receipt");
  db.prepare("INSERT INTO credentials VALUES (?, ?)").run("qq", "v1:secret-envelope");
  db.close();
  return { directory, source, destination };
}

test("online backup and verify-copy preserve calendar, task, reminder-outbox, and sent-delivery state", async () => {
  const target = await fixture();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target.destination), { recursive: true }));

  const report = await backupCalendarDatabase(target.source, target.destination);
  assert.equal(report.integrityCheck, "ok");
  assert.equal(report.matched, true);
  assert.deepEqual(report.counts, {
    calendarEvents: 1,
    calendarTasks: 1,
    calendarDeliveryOutbox: 1,
    acceptedCalendarDeliveries: 1,
    notificationDeliveries: 1,
    sentDeliveries: 1
  });
  assert.doesNotMatch(JSON.stringify(report), /secret-envelope/);

  const verified = await verifyCalendarCopy(target.source, target.destination);
  assert.equal(verified.integrityCheck, "ok");
  assert.equal(verified.matched, true);
  assert.deepEqual(verified.counts, report.counts);

  const copy = new DatabaseSync(target.destination, { readOnly: true });
  try {
    assert.equal((copy.prepare("SELECT status FROM calendar_events WHERE id = ?").get("event-1") as { status: string }).status, "tentative");
    assert.equal((copy.prepare("SELECT state FROM calendar_agent_tasks WHERE id = ?").get("task-1") as { state: string }).state, "succeeded");
    assert.equal((copy.prepare("SELECT state FROM calendar_delivery_outbox WHERE id = ?").get("calendar-delivery-1") as { state: string }).state, "accepted");
    assert.equal((copy.prepare("SELECT status FROM notification_deliveries WHERE id = ?").get("delivery-1") as { status: string }).status, "sent");
  } finally {
    copy.close();
  }
});

test("backup refuses to overwrite an existing destination", async () => {
  const target = await fixture();
  const directory = path.dirname(target.destination);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(target.destination, "keep this file", "utf8");

  await assert.rejects(() => backupCalendarDatabase(target.source, target.destination), /refusing to overwrite/);
  assert.equal(await readFile(target.destination, "utf8"), "keep this file");
});

test("backup requires explicit absolute source and destination paths", async () => {
  await assert.rejects(() => backupCalendarDatabase("app.sqlite", path.resolve("copy.sqlite")), /source must be an absolute path/);
  await assert.rejects(() => backupCalendarDatabase(path.resolve("app.sqlite"), "copy.sqlite"), /destination must be an absolute path/);
});
