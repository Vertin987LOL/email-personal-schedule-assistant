import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { access, open, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type CalendarBackupCounts = {
  calendarEvents: number;
  calendarTasks: number;
  calendarDeliveryOutbox: number;
  acceptedCalendarDeliveries: number;
  notificationDeliveries: number;
  sentDeliveries: number;
};

export type CalendarBackupReport = {
  command: "backup" | "verify-copy";
  source: string;
  destination: string;
  integrityCheck: "ok";
  pages?: number;
  counts: CalendarBackupCounts;
  matched?: boolean;
};

type SqlRow = Record<string, unknown>;

function requireAbsolute(value: string, label: string) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

function samePath(left: string, right: string) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function requireRegularFile(filePath: string, label: string) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be a regular file")) throw error;
    throw new Error(`${label} does not exist`);
  }
}

function integrityCheck(db: DatabaseSync) {
  const row = db.prepare("PRAGMA integrity_check").get() as SqlRow | undefined;
  const value = row ? String(Object.values(row)[0] ?? "") : "";
  if (value !== "ok") throw new Error(`integrity_check failed: ${value || "unknown"}`);
}

function tableCount(db: DatabaseSync, table: string, where = "", params: SQLInputValue[] = []) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get(...params) as SqlRow;
  return Number(row.count ?? 0);
}

function counts(db: DatabaseSync): CalendarBackupCounts {
  return {
    calendarEvents: tableCount(db, "calendar_events"),
    calendarTasks: tableCount(db, "calendar_agent_tasks"),
    calendarDeliveryOutbox: tableCount(db, "calendar_delivery_outbox"),
    acceptedCalendarDeliveries: tableCount(db, "calendar_delivery_outbox", "state = ?", ["accepted"]),
    notificationDeliveries: tableCount(db, "notification_deliveries"),
    sentDeliveries: tableCount(db, "notification_deliveries", "status = ?", ["sent"])
  };
}

function openReadOnly(filePath: string) {
  return new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
}

async function reserveDestination(destination: string) {
  try {
    const handle = await open(destination, "wx");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("destination already exists; refusing to overwrite it");
    }
    throw error;
  }
}

export async function backupCalendarDatabase(source: string, destination: string): Promise<CalendarBackupReport> {
  const sourcePath = requireAbsolute(source, "source");
  const destinationPath = requireAbsolute(destination, "destination");
  if (samePath(sourcePath, destinationPath)) throw new Error("source and destination must differ");
  await requireRegularFile(sourcePath, "source");
  try {
    const parent = path.dirname(destinationPath);
    await requireRegularFile(sourcePath, "source");
    await access(parent);
    await reserveDestination(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("destination parent directory does not exist");
    throw error;
  }

  let sourceDb: DatabaseSync | undefined;
  try {
    sourceDb = openReadOnly(sourcePath);
    integrityCheck(sourceDb);
    const sourceCounts = counts(sourceDb);
    const pages = await backup(sourceDb, destinationPath, { rate: 100 });
    sourceDb.close();
    sourceDb = undefined;
    const destinationDb = openReadOnly(destinationPath);
    try {
      integrityCheck(destinationDb);
      const destinationCounts = counts(destinationDb);
      if (JSON.stringify(sourceCounts) !== JSON.stringify(destinationCounts)) {
        throw new Error("backup verification counts do not match source");
      }
      return {
        command: "backup",
        source: sourcePath,
        destination: destinationPath,
        integrityCheck: "ok",
        pages,
        counts: destinationCounts,
        matched: true
      };
    } finally {
      destinationDb.close();
    }
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    sourceDb?.close();
  }
}

export async function verifyCalendarCopy(source: string, destination: string): Promise<CalendarBackupReport> {
  const sourcePath = requireAbsolute(source, "source");
  const destinationPath = requireAbsolute(destination, "destination");
  if (samePath(sourcePath, destinationPath)) throw new Error("source and destination must differ");
  await requireRegularFile(sourcePath, "source");
  await requireRegularFile(destinationPath, "destination");
  const sourceDb = openReadOnly(sourcePath);
  const destinationDb = openReadOnly(destinationPath);
  try {
    integrityCheck(sourceDb);
    integrityCheck(destinationDb);
    const sourceCounts = counts(sourceDb);
    const destinationCounts = counts(destinationDb);
    const matched = JSON.stringify(sourceCounts) === JSON.stringify(destinationCounts);
    if (!matched) throw new Error("copy verification counts do not match source");
    return {
      command: "verify-copy",
      source: sourcePath,
      destination: destinationPath,
      integrityCheck: "ok",
      counts: destinationCounts,
      matched
    };
  } finally {
    sourceDb.close();
    destinationDb.close();
  }
}

function parseArgs(argv: string[]) {
  const command = argv[0];
  if (command !== "backup" && command !== "verify-copy") throw new Error("usage: backup|verify-copy --source ABSOLUTE --destination ABSOLUTE");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--source" && key !== "--destination") throw new Error(`unknown option: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires an absolute path`);
    if (values.has(key)) throw new Error(`${key} may be supplied only once`);
    values.set(key, value);
  }
  const source = values.get("--source");
  const destination = values.get("--destination");
  if (!source || !destination) throw new Error("both --source and --destination are required");
  return { command, source: requireAbsolute(source, "source"), destination: requireAbsolute(destination, "destination") } as const;
}

export async function run(argv: string[]) {
  const args = parseArgs(argv);
  const report = args.command === "backup"
    ? await backupCalendarDatabase(args.source, args.destination)
    : await verifyCalendarCopy(args.source, args.destination);
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
