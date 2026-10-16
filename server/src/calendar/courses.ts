import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import ical, {
  expandRecurringEvent,
  type CalendarResponse,
  type DateWithTimeZone,
  type EventInstance,
  type VEvent
} from "node-ical";
import type { DatabaseSync } from "node:sqlite";
import { CalendarRepository } from "./repository";
import { CalendarError, CalendarService } from "./service";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarSource,
  CalendarTime
} from "./types";

const MAX_TERM_DAYS = 730;
const MAX_OCCURRENCES = 260;
const MAX_IMPORT_EVENTS = 260;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION_RE = /^\S{1,200}$/;

export type CourseSeries = {
  id: string;
  ownerId: string;
  title: string;
  dayOfWeek: number;
  localStart: string;
  localEnd: string;
  timeZone: string;
  termStart: string;
  termEnd: string;
  week1StartsOn: string;
  teachingWeeks: number[] | "every_week";
  importKey: string;
  location?: string;
};

export type CourseSeriesInput = Omit<CourseSeries, "id" | "ownerId"> & { id?: string };

export type CourseOccurrenceException = {
  id: string;
  ownerId: string;
  seriesId: string;
  occurrenceDate: string;
  origin: "manual" | "import";
  action: "cancel" | "move";
  localStart?: string;
  localEnd?: string;
  location?: string;
  version: number;
  sourceRef: string;
};

export type CourseImportProposal = {
  id: string;
  ownerId: string;
  importKey: string;
  seriesId: string;
  proposed: CourseSeries;
  state: "pending" | "rejected";
  operationKey: string;
};

export type CourseImportResult = {
  operationKey: string;
  created: number;
  changed: number;
  rejected: number;
  occurrences: number;
  createdOccurrences: number;
  series: CourseSeries[];
  proposals: CourseImportProposal[];
  errors: Array<{ importKey?: string; code: string; message: string }>;
};

export type CourseExceptionResult = {
  exception: CourseOccurrenceException;
  event?: CalendarEvent;
};

export type IcsImportOptions = {
  termStart: string;
  termEnd: string;
  week1StartsOn: string;
  timeZone?: string;
};

export type CourseIcsImportResult = CourseImportResult & { sourceEvents: number };

type SqlRow = Record<string, unknown>;
type CourseOperation = {
  ownerId: string;
  operationKey: string;
  operationType: string;
  payloadHash: string;
  resultJson: string;
};

export class CourseCalendarError extends CalendarError {
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(code, message, status, details);
    this.name = "CourseCalendarError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function requireString(value: unknown, field: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new CourseCalendarError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function requireDate(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new CourseCalendarError("INVALID_TIME", `${field} must be YYYY-MM-DD`);
  try {
    Temporal.PlainDate.from(value);
  } catch {
    throw new CourseCalendarError("INVALID_TIME", `${field} is invalid`);
  }
  return value;
}

function requireTime(value: unknown, field: string) {
  if (typeof value !== "string" || !TIME_RE.test(value)) throw new CourseCalendarError("INVALID_TIME", `${field} must be HH:mm`);
  try {
    Temporal.PlainTime.from(value);
  } catch {
    throw new CourseCalendarError("INVALID_TIME", `${field} is invalid`);
  }
  return value;
}

function requireTimeZone(value: unknown, field = "timeZone") {
  if (typeof value !== "string" || !value || value.length > 100) throw new CourseCalendarError("INVALID_TIME", `${field} must be an IANA time zone`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new CourseCalendarError("INVALID_TIME", `${field} is invalid`);
  }
  return value;
}

function requireOperation(value: unknown) {
  if (typeof value !== "string" || !OPERATION_RE.test(value)) throw new CourseCalendarError("INVALID_INPUT", "operationKey is invalid");
  return value;
}

function dayDifference(start: string, end: string) {
  return Temporal.PlainDate.from(start).until(Temporal.PlainDate.from(end), { largestUnit: "day" }).days;
}

function dateString(date: Temporal.PlainDate) {
  return date.toString();
}

function toLocalZoned(date: string, time: string, timeZone: string) {
  try {
    return Temporal.PlainDate.from(date)
      .toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) });
  } catch {
    throw new CourseCalendarError("INVALID_TIME", `cannot represent ${date} ${time} in ${timeZone}`);
  }
}

function eventInputForSeries(series: CourseSeries, date: string, exception?: CourseOccurrenceException): CalendarEventInput {
  const localStart = exception?.action === "move" && exception.localStart ? exception.localStart : series.localStart;
  const localEnd = exception?.action === "move" && exception.localEnd ? exception.localEnd : series.localEnd;
  const startsAt = toLocalZoned(date, localStart, series.timeZone).toInstant().toString();
  const endsAt = toLocalZoned(date, localEnd, series.timeZone).toInstant().toString();
  const source: CalendarSource = { kind: "course", ref: `course:${series.importKey}:${date}` };
  return {
    title: series.title,
    kind: "course",
    time: { kind: "interval", startsAt, endsAt, timeZone: series.timeZone },
    ...(exception?.action === "move" && exception.location !== undefined
      ? (exception.location ? { location: exception.location } : {})
      : (series.location ? { location: series.location } : {})),
    status: "confirmed",
    sources: [source],
    seriesId: series.id
  };
}

function extractValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) return String((value as { val: unknown }).val);
  return "";
}

function localDateTime(value: DateWithTimeZone, timeZone: string) {
  if (value.dateOnly) return undefined;
  return Temporal.Instant.from(value.toISOString()).toZonedDateTimeISO(timeZone);
}

function eventDateTime(value: DateWithTimeZone, timeZone: string) {
  const local = localDateTime(value, timeZone);
  if (!local) throw new CourseCalendarError("INVALID_TIME", "ICS all-day events cannot become course intervals");
  return local;
}

function rowJson<T>(row: SqlRow | undefined): T | undefined {
  return row ? JSON.parse(String(row.data)) as T : undefined;
}

class CourseStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_course_series (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        importKey TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(ownerId, id),
        UNIQUE(ownerId, importKey)
      );
      CREATE TABLE IF NOT EXISTS calendar_course_instances (
        ownerId TEXT NOT NULL,
        seriesId TEXT NOT NULL,
        occurrenceDate TEXT NOT NULL,
        eventId TEXT NOT NULL,
        exceptionVersion INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(ownerId, seriesId, occurrenceDate)
      );
      CREATE TABLE IF NOT EXISTS calendar_course_exceptions (
        ownerId TEXT NOT NULL,
        seriesId TEXT NOT NULL,
        occurrenceDate TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(ownerId, seriesId, occurrenceDate)
      );
      CREATE TABLE IF NOT EXISTS calendar_course_operations (
        ownerId TEXT NOT NULL,
        operationKey TEXT NOT NULL,
        operationType TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        resultJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY(ownerId, operationKey)
      );
      CREATE TABLE IF NOT EXISTS calendar_course_import_proposals (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        importKey TEXT NOT NULL,
        seriesId TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(ownerId, id)
      );
      CREATE INDEX IF NOT EXISTS calendar_course_proposals_state
        ON calendar_course_import_proposals(ownerId, state, createdAt);
    `);
  }

  withTransaction<T>(work: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  getSeries(ownerId: string, id: string) {
    return rowJson<CourseSeries>(this.db.prepare("SELECT data FROM calendar_course_series WHERE ownerId = ? AND id = ?").get(ownerId, id) as SqlRow | undefined);
  }

  getSeriesByImportKey(ownerId: string, importKey: string) {
    return rowJson<CourseSeries>(this.db.prepare("SELECT data FROM calendar_course_series WHERE ownerId = ? AND importKey = ?").get(ownerId, importKey) as SqlRow | undefined);
  }

  listSeries(ownerId: string) {
    return (this.db.prepare("SELECT data FROM calendar_course_series WHERE ownerId = ? ORDER BY importKey, id").all(ownerId) as SqlRow[])
      .map((row) => rowJson<CourseSeries>(row) as CourseSeries);
  }

  saveSeries(series: CourseSeries, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_course_series(ownerId, id, importKey, version, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, id) DO UPDATE SET version = excluded.version, data = excluded.data, updatedAt = excluded.updatedAt
    `).run(series.ownerId, series.id, series.importKey, 1, JSON.stringify(series), now, now);
  }

  getInstance(ownerId: string, seriesId: string, occurrenceDate: string) {
    return rowJson<{ seriesId: string; occurrenceDate: string; eventId: string; exceptionVersion: number; importEventVersion?: number }>(this.db.prepare(
      "SELECT data FROM calendar_course_instances WHERE ownerId = ? AND seriesId = ? AND occurrenceDate = ?"
    ).get(ownerId, seriesId, occurrenceDate) as SqlRow | undefined);
  }

  saveInstance(ownerId: string, instance: { seriesId: string; occurrenceDate: string; eventId: string; exceptionVersion: number; importEventVersion?: number }, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_course_instances(ownerId, seriesId, occurrenceDate, eventId, exceptionVersion, data, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, seriesId, occurrenceDate) DO UPDATE SET eventId = excluded.eventId, exceptionVersion = excluded.exceptionVersion, data = excluded.data, updatedAt = excluded.updatedAt
    `).run(ownerId, instance.seriesId, instance.occurrenceDate, instance.eventId, instance.exceptionVersion, JSON.stringify(instance), now);
  }

  getException(ownerId: string, seriesId: string, occurrenceDate: string) {
    return rowJson<CourseOccurrenceException>(this.db.prepare(
      "SELECT data FROM calendar_course_exceptions WHERE ownerId = ? AND seriesId = ? AND occurrenceDate = ?"
    ).get(ownerId, seriesId, occurrenceDate) as SqlRow | undefined);
  }

  saveException(exception: CourseOccurrenceException, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_course_exceptions(ownerId, seriesId, occurrenceDate, version, data, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, seriesId, occurrenceDate) DO UPDATE SET version = excluded.version, data = excluded.data, updatedAt = excluded.updatedAt
    `).run(exception.ownerId, exception.seriesId, exception.occurrenceDate, exception.version, JSON.stringify(exception), now);
  }

  getOperation(ownerId: string, operationKey: string): CourseOperation | undefined {
    const row = this.db.prepare("SELECT ownerId, operationKey, operationType, payloadHash, resultJson FROM calendar_course_operations WHERE ownerId = ? AND operationKey = ?").get(ownerId, operationKey) as SqlRow | undefined;
    return row ? {
      ownerId: String(row.ownerId), operationKey: String(row.operationKey), operationType: String(row.operationType), payloadHash: String(row.payloadHash), resultJson: String(row.resultJson)
    } : undefined;
  }

  saveOperation(operation: CourseOperation, now: string) {
    this.db.prepare("INSERT INTO calendar_course_operations(ownerId, operationKey, operationType, payloadHash, resultJson, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(
      operation.ownerId, operation.operationKey, operation.operationType, operation.payloadHash, operation.resultJson, now
    );
  }

  getPendingProposal(ownerId: string, importKey: string, payloadHash: string) {
    return rowJson<CourseImportProposal>(this.db.prepare(
      "SELECT data FROM calendar_course_import_proposals WHERE ownerId = ? AND importKey = ? AND payloadHash = ? AND state = 'pending'"
    ).get(ownerId, importKey, payloadHash) as SqlRow | undefined);
  }

  saveProposal(proposal: CourseImportProposal, payloadHash: string, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_course_import_proposals(ownerId, id, importKey, seriesId, payloadHash, state, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(proposal.ownerId, proposal.id, proposal.importKey, proposal.seriesId, payloadHash, proposal.state, JSON.stringify(proposal), now, now);
  }

  listProposals(ownerId: string, state?: CourseImportProposal["state"]) {
    const rows = state
      ? this.db.prepare("SELECT data FROM calendar_course_import_proposals WHERE ownerId = ? AND state = ? ORDER BY createdAt, id").all(ownerId, state) as SqlRow[]
      : this.db.prepare("SELECT data FROM calendar_course_import_proposals WHERE ownerId = ? ORDER BY createdAt, id").all(ownerId) as SqlRow[];
    return rows.map((row) => rowJson<CourseImportProposal>(row) as CourseImportProposal);
  }
}

export class CourseCalendarService {
  readonly ownerId: string;
  readonly calendar: CalendarService;
  readonly store: CourseStore;

  constructor(input: DatabaseSync | CalendarRepository | CalendarService, ownerId = "local-owner") {
    if (input instanceof CalendarService) {
      this.calendar = input;
      // A CalendarService is already bound to the authenticated owner. Do not
      // let a second default or caller-supplied owner split course rows from
      // the events they materialize.
      this.ownerId = input.ownerId;
      this.store = new CourseStore(input.repository.db);
    } else {
      this.ownerId = requireString(ownerId, "ownerId", 200);
      const repository = input instanceof CalendarRepository ? input : new CalendarRepository(input);
      this.calendar = new CalendarService(repository, this.ownerId);
      this.store = new CourseStore(repository.db);
    }
  }

  listSeries() {
    return this.store.listSeries(this.ownerId);
  }

  listExceptions(seriesId?: string) {
    const series = seriesId ? this.requireSeries(seriesId) : undefined;
    const rows = series
      ? this.store.db.prepare("SELECT data FROM calendar_course_exceptions WHERE ownerId = ? AND seriesId = ? ORDER BY occurrenceDate").all(this.ownerId, series.id) as SqlRow[]
      : this.store.db.prepare("SELECT data FROM calendar_course_exceptions WHERE ownerId = ? ORDER BY seriesId, occurrenceDate").all(this.ownerId) as SqlRow[];
    return rows.map((row) => rowJson<CourseOccurrenceException>(row) as CourseOccurrenceException);
  }

  listImportProposals(state?: CourseImportProposal["state"]) {
    return this.store.listProposals(this.ownerId, state);
  }

  importSeries(operationKeyInput: unknown, rawSeries: unknown[]): CourseImportResult {
    const operationKey = requireOperation(operationKeyInput);
    if (!Array.isArray(rawSeries) || rawSeries.length === 0 || rawSeries.length > MAX_IMPORT_EVENTS) {
      throw new CourseCalendarError("INVALID_INPUT", "series must contain 1-260 items");
    }
    const normalized = rawSeries.map((item) => this.normalizeSeries(item));
    const operationPayload = { series: normalized };
    const operationHash = hash(operationPayload);
    const existingOperation = this.store.getOperation(this.ownerId, operationKey);
    if (existingOperation) {
      this.assertOperation(existingOperation, "series:import", operationHash);
      return JSON.parse(existingOperation.resultJson) as CourseImportResult;
    }

    const result: CourseImportResult = {
      operationKey, created: 0, changed: 0, rejected: 0, occurrences: 0, createdOccurrences: 0,
      series: [], proposals: [], errors: []
    };
    for (const input of normalized) {
      try {
        const current = this.store.getSeriesByImportKey(this.ownerId, input.importKey);
        if (!current) {
          const series: CourseSeries = { ...input, id: input.id ?? randomUUID(), ownerId: this.ownerId };
          this.store.withTransaction(() => this.store.saveSeries(series, nowIso()));
          const materialized = this.materializeSeries(series);
          result.created += 1;
          result.occurrences += materialized.occurrences;
          result.createdOccurrences += materialized.createdOccurrences;
          result.series.push(series);
          continue;
        }
        const proposed = { ...input, id: current.id, ownerId: this.ownerId } as CourseSeries;
        const currentHash = hash(this.seriesComparable(current));
        const proposedHash = hash(this.seriesComparable(proposed));
        if (currentHash === proposedHash) {
          const materialized = this.materializeSeries(current);
          result.occurrences += materialized.occurrences;
          result.createdOccurrences += materialized.createdOccurrences;
          result.series.push(current);
          continue;
        }
        const proposalPayloadHash = hash(this.seriesComparable(proposed));
        const pending = this.store.getPendingProposal(this.ownerId, current.importKey, proposalPayloadHash);
        const proposal = pending ?? {
          id: randomUUID(), ownerId: this.ownerId, importKey: current.importKey, seriesId: current.id,
          proposed, state: "pending" as const, operationKey
        };
        if (!pending) this.store.withTransaction(() => this.store.saveProposal(proposal, proposalPayloadHash, nowIso()));
        result.changed += 1;
        result.proposals.push(proposal);
        result.series.push(current);
      } catch (error) {
        const courseError = error instanceof CourseCalendarError || error instanceof CalendarError
          ? error
          : new CourseCalendarError("STORAGE_FAILED", "course import failed", 500);
        result.rejected += 1;
        result.errors.push({ importKey: input.importKey, code: courseError instanceof CourseCalendarError ? courseError.code : "STORAGE_FAILED", message: courseError.message });
      }
    }
    this.store.withTransaction(() => this.store.saveOperation({ ownerId: this.ownerId, operationKey, operationType: "series:import", payloadHash: operationHash, resultJson: JSON.stringify(result) }, nowIso()));
    return result;
  }

  importIcs(operationKeyInput: unknown, icsText: unknown, options: IcsImportOptions): CourseIcsImportResult {
    const operationKey = requireOperation(operationKeyInput);
    if (typeof icsText !== "string" || icsText.length === 0 || icsText.length > 5_000_000) throw new CourseCalendarError("INVALID_INPUT", "ics is invalid");
    const normalizedOptions = this.validateImportOptions(options);
    let parsed: CalendarResponse;
    try {
      parsed = ical.sync.parseICS(icsText);
    } catch {
      throw new CourseCalendarError("INVALID_INPUT", "ICS could not be parsed");
    }
    const events = Object.values(parsed).filter((item): item is VEvent => Boolean(item && typeof item === "object" && item.type === "VEVENT"));
    if (events.length === 0 || events.length > MAX_IMPORT_EVENTS) throw new CourseCalendarError("INVALID_INPUT", "ICS must contain 1-260 VEVENT items");
    const series: CourseSeriesInput[] = [];
    const exceptions: Array<{ series: CourseSeriesInput; date: string; instance: EventInstance; action: "cancel" | "move" }> = [];
    const errors: Array<{ importKey?: string; code: string; message: string }> = [];
    for (const event of events) {
      try {
        const converted = this.seriesFromIcsEvent(event, normalizedOptions);
        series.push(converted.series);
        exceptions.push(...converted.exceptions);
      } catch (error) {
        const courseError = error instanceof CourseCalendarError ? error : new CourseCalendarError("INVALID_INPUT", "ICS event is incomplete");
        errors.push({ importKey: event.uid, code: courseError.code, message: courseError.message });
      }
    }
    if (series.length === 0) {
      return {
        operationKey,
        created: 0,
        changed: 0,
        rejected: errors.length,
        occurrences: 0,
        createdOccurrences: 0,
        series: [],
        proposals: [],
        errors,
        sourceEvents: events.length
      };
    }
    const result = this.importSeries(operationKey, series);
    for (const exception of exceptions) {
      const imported = result.series.find((item) => item.importKey === exception.series.importKey);
      if (!imported) continue;
      if (result.proposals.some((proposal) => proposal.importKey === imported.importKey && proposal.state === "pending")) continue;
      try {
        const local = eventDateTime(exception.instance.start, imported.timeZone);
        const end = eventDateTime(exception.instance.end, imported.timeZone);
        const expectedDate = this.occurrenceDates(imported).find((date) => date === exception.date);
        if (expectedDate && exception.action === "cancel") {
          this.setImportedOccurrenceException(`${operationKey}:exception:${imported.id}:${exception.date}`, imported.id, exception.date, "cancel");
        } else if (expectedDate && (local.toPlainTime().toString({ smallestUnit: "minute" }) !== imported.localStart || end.toPlainTime().toString({ smallestUnit: "minute" }) !== imported.localEnd)) {
          this.setImportedOccurrenceException(`${operationKey}:exception:${imported.id}:${exception.date}`, imported.id, exception.date, {
            localStart: local.toPlainTime().toString({ smallestUnit: "minute" }),
            localEnd: end.toPlainTime().toString({ smallestUnit: "minute" }),
            ...(imported.location ? { location: imported.location } : {})
          });
        }
      } catch (error) {
        const courseError = error instanceof CourseCalendarError ? error : new CourseCalendarError("INVALID_TIME", "ICS exception could not be represented");
        errors.push({ importKey: imported.importKey, code: courseError.code, message: courseError.message });
      }
    }
    return { ...result, sourceEvents: events.length, rejected: result.rejected + errors.length, errors: [...result.errors, ...errors] };
  }

  setOccurrenceException(
    operationKeyInput: unknown,
    seriesId: string,
    occurrenceDateInput: unknown,
    rawChange: unknown,
    expectedEventVersionInput: unknown
  ): CourseExceptionResult {
    return this.setOccurrenceExceptionInternal(
      operationKeyInput,
      seriesId,
      occurrenceDateInput,
      rawChange,
      this.requireEventVersion(expectedEventVersionInput),
      "manual"
    );
  }

  private setImportedOccurrenceException(operationKeyInput: unknown, seriesId: string, occurrenceDateInput: unknown, rawChange: unknown) {
    return this.setOccurrenceExceptionInternal(operationKeyInput, seriesId, occurrenceDateInput, rawChange, undefined, "import");
  }

  private setOccurrenceExceptionInternal(
    operationKeyInput: unknown,
    seriesId: string,
    occurrenceDateInput: unknown,
    rawChange: unknown,
    expectedEventVersion: number | undefined,
    origin: CourseOccurrenceException["origin"]
  ): CourseExceptionResult {
    const operationKey = requireOperation(operationKeyInput);
    const occurrenceDate = requireDate(occurrenceDateInput, "occurrenceDate");
    const series = this.requireSeries(seriesId);
    if (!this.occurrenceDates(series).includes(occurrenceDate)) throw new CourseCalendarError("INVALID_TIME", "occurrenceDate is outside the imported teaching weeks");
    const change = this.normalizeException(rawChange);
    const operationPayload = { seriesId, occurrenceDate, change, expectedEventVersion, origin };
    const operationHash = hash(operationPayload);
    const existingOperation = this.store.getOperation(this.ownerId, operationKey);
    if (existingOperation) {
      this.assertOperation(existingOperation, "occurrence:exception", operationHash);
      return JSON.parse(existingOperation.resultJson) as CourseExceptionResult;
    }

    let invalidation: { previousVersion: number; currentVersion: number; eventId: string } | undefined;
    const result = this.store.withTransaction(() => {
      const instance = this.store.getInstance(this.ownerId, series.id, occurrenceDate);
      if (!instance) throw new CourseCalendarError("STORAGE_FAILED", "course occurrence instance is missing", 500);
      const current = this.calendar.repository.getEvent(this.ownerId, instance.eventId);
      if (!current) throw new CourseCalendarError("STORAGE_FAILED", "course occurrence event is missing", 500);
      if (origin === "manual" && current.version !== expectedEventVersion) {
        throw new CourseCalendarError("VERSION_CONFLICT", "course occurrence version is stale", 409, { current });
      }

      const previous = this.store.getException(this.ownerId, series.id, occurrenceDate);
      const previousOrigin = previous?.origin === "import" ? "import" : "manual";
      if (origin === "import" && instance.importEventVersion !== undefined && current.version !== instance.importEventVersion) {
        const skipped: CourseExceptionResult = {
          exception: previous ?? {
            id: randomUUID(), ownerId: this.ownerId, seriesId: series.id, occurrenceDate, origin: "import",
            ...change, version: 0, sourceRef: `course:${series.importKey}:${occurrenceDate}:exception`
          },
          event: current
        };
        this.store.saveOperation({ ownerId: this.ownerId, operationKey, operationType: "occurrence:exception", payloadHash: operationHash, resultJson: JSON.stringify(skipped) }, nowIso());
        return skipped;
      }
      if (origin === "import" && previous && previousOrigin === "manual") {
        const preserved: CourseExceptionResult = { exception: previous, event: current };
        this.store.saveOperation({ ownerId: this.ownerId, operationKey, operationType: "occurrence:exception", payloadHash: operationHash, resultJson: JSON.stringify(preserved) }, nowIso());
        return preserved;
      }
      if (origin === "import" && previous && JSON.stringify({ action: previous.action, localStart: previous.localStart, localEnd: previous.localEnd, location: previous.location })
        === JSON.stringify(change)) {
        const unchanged: CourseExceptionResult = { exception: previous, event: current };
        this.store.saveOperation({ ownerId: this.ownerId, operationKey, operationType: "occurrence:exception", payloadHash: operationHash, resultJson: JSON.stringify(unchanged) }, nowIso());
        return unchanged;
      }

      const exception: CourseOccurrenceException = {
        id: previous?.id ?? randomUUID(), ownerId: this.ownerId, seriesId: series.id, occurrenceDate, origin,
        ...change, version: (previous?.version ?? 0) + 1, sourceRef: `course:${series.importKey}:${occurrenceDate}:exception`
      };
      let event = current;
      if (change.action === "cancel") {
        if (current.status !== "cancelled") {
          event = { ...current, status: "cancelled", version: current.version + 1 };
          invalidation = { eventId: event.id, previousVersion: current.version, currentVersion: event.version };
          this.calendar.repository.updateEvent(event, nowIso());
        }
      } else if (current.status !== "cancelled") {
        const input = eventInputForSeries(series, occurrenceDate, exception);
        event = {
          ...current,
          time: input.time,
          ...(change.location !== undefined ? (change.location ? { location: change.location } : { location: undefined }) : {}),
          version: current.version + 1
        };
        invalidation = { eventId: event.id, previousVersion: current.version, currentVersion: event.version };
        this.calendar.repository.updateEvent(event, nowIso());
      }
      this.store.saveException(exception, nowIso());
      this.store.saveInstance(this.ownerId, {
        ...instance,
        exceptionVersion: exception.version,
        ...(origin === "import" ? { importEventVersion: event.version } : {})
      }, nowIso());
      const committed: CourseExceptionResult = { exception, event };
      this.store.saveOperation({ ownerId: this.ownerId, operationKey, operationType: "occurrence:exception", payloadHash: operationHash, resultJson: JSON.stringify(committed) }, nowIso());
      return committed;
    });
    if (invalidation && this.calendar.hooks.onReminderInvalidated) {
      try {
        this.calendar.hooks.onReminderInvalidated({ ...invalidation, reason: result.exception.action === "cancel" ? "cancelled" : "updated" });
      } catch {
        // Reminder delivery must not turn a committed course exception into a failed request.
      }
    }
    return result;
  }

  expand(seriesId: string, from: string, to: string) {
    const series = this.requireSeries(seriesId);
    const start = Temporal.Instant.from(from).epochMilliseconds;
    const end = Temporal.Instant.from(to).epochMilliseconds;
    if (end <= start || end - start > MAX_TERM_DAYS * 86_400_000) throw new CourseCalendarError("INVALID_TIME", "course expansion range is invalid");
    return this.occurrenceDates(series).filter((date) => {
      const instant = toLocalZoned(date, series.localStart, series.timeZone).toInstant().epochMilliseconds;
      return instant >= start && instant < end;
    }).map((date) => this.store.getInstance(this.ownerId, series.id, date)).filter((value): value is { seriesId: string; occurrenceDate: string; eventId: string; exceptionVersion: number; importEventVersion?: number } => Boolean(value));
  }

  private materializeSeries(series: CourseSeries) {
    let occurrences = 0;
    let createdOccurrences = 0;
    for (const date of this.occurrenceDates(series)) {
      occurrences += 1;
      const result = this.materializeOccurrence(series, date, this.store.getException(this.ownerId, series.id, date));
      if (result.created) createdOccurrences += 1;
    }
    return { occurrences, createdOccurrences };
  }

  private materializeOccurrence(series: CourseSeries, date: string, exception?: CourseOccurrenceException) {
    if (exception?.action === "cancel") {
      const instance = this.store.getInstance(this.ownerId, series.id, date);
      if (!instance) return { created: false, event: undefined };
      const current = this.calendar.getEvent(instance.eventId);
      if (exception?.origin === "import" && instance.importEventVersion !== undefined && current.version !== instance.importEventVersion) {
        return { created: false, event: current };
      }
      if (current.status !== "cancelled") this.calendar.cancelEvent(current.id, current.version, `course:${series.id}:${date}:cancel:v${exception.version}`);
      this.store.withTransaction(() => this.store.saveInstance(this.ownerId, { ...instance, exceptionVersion: exception.version }, nowIso()));
      return { created: false, event: this.calendar.getEvent(instance.eventId) };
    }
    const instance = this.store.getInstance(this.ownerId, series.id, date);
    if (!instance) {
      const event = this.calendar.createEvent(`course:${series.id}:${date}:create`, eventInputForSeries(series, date, exception));
      this.store.withTransaction(() => this.store.saveInstance(this.ownerId, {
        seriesId: series.id,
        occurrenceDate: date,
        eventId: event.id,
        exceptionVersion: exception?.version ?? 0,
        importEventVersion: event.version
      }, nowIso()));
      return { created: true, event };
    }
    const current = this.calendar.getEvent(instance.eventId);
    if (exception?.origin === "import" && instance.importEventVersion !== undefined && current.version !== instance.importEventVersion) {
      return { created: false, event: current };
    }
    if (exception && exception.version > instance.exceptionVersion && current.status !== "cancelled") {
      const next = this.calendar.updateEvent(current.id, current.version, `course:${series.id}:${date}:move:v${exception.version}`, {
        time: eventInputForSeries(series, date, exception).time,
        ...(exception.location !== undefined ? { location: exception.location } : {})
      });
      this.store.withTransaction(() => this.store.saveInstance(this.ownerId, { ...instance, exceptionVersion: exception.version }, nowIso()));
      return { created: false, event: next };
    }
    if (exception && exception.version > instance.exceptionVersion) {
      this.store.withTransaction(() => this.store.saveInstance(this.ownerId, { ...instance, exceptionVersion: exception.version }, nowIso()));
    }
    return { created: false, event: current };
  }

  private occurrenceDates(series: CourseSeriesInput | CourseSeries) {
    const week1 = Temporal.PlainDate.from(series.week1StartsOn);
    const termStart = Temporal.PlainDate.from(series.termStart);
    const termEnd = Temporal.PlainDate.from(series.termEnd);
    const weeks = series.teachingWeeks === "every_week"
      ? Array.from({ length: Math.floor(week1.until(termEnd, { largestUnit: "day" }).days / 7) + 1 }, (_, index) => index + 1)
      : series.teachingWeeks;
    const dates = weeks.map((week) => week1.add({ days: (week - 1) * 7 + series.dayOfWeek - 1 }))
      .filter((date) => Temporal.PlainDate.compare(date, termStart) >= 0 && Temporal.PlainDate.compare(date, termEnd) <= 0)
      .map(dateString);
    if (dates.length > MAX_OCCURRENCES) throw new CourseCalendarError("INVALID_INPUT", "course expansion exceeds the occurrence limit");
    return dates;
  }

  private normalizeSeries(raw: unknown): CourseSeriesInput {
    if (!raw || typeof raw !== "object") throw new CourseCalendarError("INVALID_INPUT", "course series is invalid");
    const input = raw as Record<string, unknown>;
    const termStart = requireDate(input.termStart, "termStart");
    const termEnd = requireDate(input.termEnd, "termEnd");
    if (Temporal.PlainDate.compare(Temporal.PlainDate.from(termEnd), Temporal.PlainDate.from(termStart)) < 0 || dayDifference(termStart, termEnd) > MAX_TERM_DAYS) {
      throw new CourseCalendarError("INVALID_TIME", "term range is invalid or too long");
    }
    const week1StartsOn = requireDate(input.week1StartsOn, "week1StartsOn");
    if (Temporal.PlainDate.from(week1StartsOn).dayOfWeek !== 1) throw new CourseCalendarError("INVALID_TIME", "week1StartsOn must be a Monday");
    if (Temporal.PlainDate.compare(Temporal.PlainDate.from(week1StartsOn), Temporal.PlainDate.from(termEnd)) > 0) {
      throw new CourseCalendarError("INVALID_TIME", "week1StartsOn must not be after the term");
    }
    if (typeof input.dayOfWeek !== "number" || !Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 1 || input.dayOfWeek > 7) throw new CourseCalendarError("INVALID_INPUT", "dayOfWeek must be 1-7");
    const localStart = requireTime(input.localStart, "localStart");
    const localEnd = requireTime(input.localEnd, "localEnd");
    if (localEnd <= localStart) throw new CourseCalendarError("INVALID_TIME", "localEnd must be after localStart");
    const timeZone = requireTimeZone(input.timeZone);
    const teachingWeeks = input.teachingWeeks === "every_week"
      ? "every_week" as const
      : this.normalizeTeachingWeeks(input.teachingWeeks);
    const result: CourseSeriesInput = {
      title: requireString(input.title, "title"), dayOfWeek: input.dayOfWeek, localStart, localEnd, timeZone,
      termStart, termEnd, week1StartsOn, teachingWeeks, importKey: requireString(input.importKey, "importKey")
    };
    // Series identifiers are server-owned. Ignore a client-supplied id so a
    // new import cannot target or overwrite another series by primary key.
    if (input.location !== undefined && input.location !== "") result.location = requireString(input.location, "location");
    const dates = this.occurrenceDates(result);
    if (dates.length === 0) throw new CourseCalendarError("INVALID_INPUT", "series has no occurrences in the term");
    return result;
  }

  private normalizeTeachingWeeks(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 104 || !value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 104)) {
      throw new CourseCalendarError("INVALID_INPUT", "teachingWeeks must be every_week or a list of weeks");
    }
    const weeks = [...new Set(value as number[])].sort((a, b) => a - b);
    if (weeks.length !== value.length) throw new CourseCalendarError("INVALID_INPUT", "teachingWeeks must be unique");
    return weeks;
  }

  private normalizeException(raw: unknown): Pick<CourseOccurrenceException, "action" | "localStart" | "localEnd" | "location"> {
    if (raw === "cancel") return { action: "cancel" };
    if (!raw || typeof raw !== "object") throw new CourseCalendarError("INVALID_INPUT", "exception change is invalid");
    const input = raw as Record<string, unknown>;
    const localStart = requireTime(input.localStart, "exception.localStart");
    const localEnd = requireTime(input.localEnd, "exception.localEnd");
    if (localEnd <= localStart) throw new CourseCalendarError("INVALID_TIME", "exception.localEnd must be after localStart");
    const result: Pick<CourseOccurrenceException, "action" | "localStart" | "localEnd" | "location"> = { action: "move", localStart, localEnd };
    if (input.location !== undefined && input.location !== "") result.location = requireString(input.location, "exception.location");
    return result;
  }

  private requireEventVersion(value: unknown) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new CourseCalendarError("INVALID_INPUT", "expectedEventVersion must be a positive integer");
    }
    return value;
  }

  private validateImportOptions(options: IcsImportOptions) {
    if (!options || typeof options !== "object") throw new CourseCalendarError("INVALID_INPUT", "ICS import options are required");
    const termStart = requireDate(options.termStart, "termStart");
    const termEnd = requireDate(options.termEnd, "termEnd");
    if (Temporal.PlainDate.compare(Temporal.PlainDate.from(termEnd), Temporal.PlainDate.from(termStart)) < 0
      || dayDifference(termStart, termEnd) > MAX_TERM_DAYS) {
      throw new CourseCalendarError("INVALID_TIME", "term range is invalid or too long");
    }
    const week1StartsOn = requireDate(options.week1StartsOn, "week1StartsOn");
    if (Temporal.PlainDate.from(week1StartsOn).dayOfWeek !== 1) {
      throw new CourseCalendarError("INVALID_TIME", "week1StartsOn must be a Monday");
    }
    return {
      termStart, termEnd, week1StartsOn,
      timeZone: options.timeZone ? requireTimeZone(options.timeZone) : undefined
    };
  }

  private seriesFromIcsEvent(event: VEvent, options: ReturnType<CourseCalendarService["validateImportOptions"]>) {
    if (!event.uid || !event.start || !event.end || event.status === "CANCELLED") throw new CourseCalendarError("INVALID_INPUT", "ICS VEVENT needs UID, DTSTART and DTEND");
    const timeZone = event.start.tz ?? options.timeZone;
    if (!timeZone) throw new CourseCalendarError("INVALID_TIME", "ICS VEVENT has no reliable time zone");
    requireTimeZone(timeZone);
    const start = eventDateTime(event.start, timeZone);
    const end = eventDateTime(event.end, timeZone);
    if (start.toPlainDate().toString() !== end.toPlainDate().toString()) {
      throw new CourseCalendarError("INVALID_INPUT", "ICS cross-date course intervals are not supported");
    }
    const termStart = options.termStart;
    const termEnd = options.termEnd;
    const week1 = options.week1StartsOn;
    const weekNumber = Math.floor(Temporal.PlainDate.from(week1).until(start.toPlainDate(), { largestUnit: "day" }).days / 7) + 1;
    const title = extractValue(event.summary) || event.uid;
    const location = extractValue(event.location);
    const importKey = `ics:${event.uid}`;
    let teachingWeeks: number[] | "every_week" = [weekNumber];
    const exceptions: Array<{ series: CourseSeriesInput; date: string; instance: EventInstance; action: "cancel" | "move" }> = [];
    if (event.rrule) {
      const recurrenceOptions = event.rrule.options as Record<string, unknown>;
      if (recurrenceOptions.freq !== "WEEKLY") throw new CourseCalendarError("INVALID_INPUT", "ICS recurrence must be weekly");
      const recurrenceWeekdays = recurrenceOptions.byweekday;
      if (Array.isArray(recurrenceWeekdays) && recurrenceWeekdays.length > 1) {
        throw new CourseCalendarError("INVALID_INPUT", "ICS multi-day weekly recurrences are not supported");
      }
      for (const field of ["byhour", "byHour", "byminute", "byMinute", "bysecond", "bySecond"]) {
        const values = recurrenceOptions[field];
        if (Array.isArray(values) && values.length > 1) {
          throw new CourseCalendarError("INVALID_INPUT", "ICS recurrences with multiple times per day are not supported");
        }
      }
      const instances = expandRecurringEvent(event, {
        from: new Date(toLocalZoned(termStart, "00:00", timeZone).toInstant().toString()),
        to: new Date(toLocalZoned(termEnd, "23:59", timeZone).toInstant().add({ minutes: 1 }).toString()),
        includeOverrides: true,
        excludeExdates: true
      });
      if (instances.length === 0) throw new CourseCalendarError("INVALID_INPUT", "ICS recurrence has no instances in the term");
      if (instances.length > MAX_OCCURRENCES) throw new CourseCalendarError("INVALID_INPUT", "ICS recurrence exceeds the occurrence limit");
      teachingWeeks = [...new Set(instances.map((instance) => {
        const local = eventDateTime(instance.start, timeZone);
        return Math.floor(Temporal.PlainDate.from(week1).until(local.toPlainDate(), { largestUnit: "day" }).days / 7) + 1;
      }))].sort((a, b) => a - b);
      for (const instance of instances) {
        const local = eventDateTime(instance.start, timeZone);
        const instanceEnd = eventDateTime(instance.end, timeZone);
        if (!instance.isOverride && (local.dayOfWeek !== start.dayOfWeek
          || local.toPlainTime().toString() !== start.toPlainTime().toString()
          || instanceEnd.toPlainTime().toString() !== end.toPlainTime().toString()
          || local.toPlainDate().toString() !== instanceEnd.toPlainDate().toString())) {
          throw new CourseCalendarError("INVALID_INPUT", "ICS recurrence changes weekday or time; not supported");
        }
        const localDate = local.toPlainDate().toString();
        const recurrenceDate = instance.event.recurrenceid
          ? eventDateTime(instance.event.recurrenceid, timeZone).toPlainDate().toString()
          : localDate;
        if (instance.isOverride && recurrenceDate !== localDate) {
          throw new CourseCalendarError("INVALID_INPUT", "ICS cross-date recurrence overrides are not supported");
        }
        const date = recurrenceDate;
        if (instance.isOverride && instance.event.status === "CANCELLED") {
          exceptions.push({ series: { id: undefined, title, dayOfWeek: start.dayOfWeek, localStart: start.toPlainTime().toString({ smallestUnit: "minute" }), localEnd: end.toPlainTime().toString({ smallestUnit: "minute" }), timeZone, termStart, termEnd, week1StartsOn: week1, teachingWeeks, importKey, ...(location ? { location } : {}) }, date, instance, action: "cancel" });
        } else if (instance.isOverride && (local.toPlainTime().toString({ smallestUnit: "minute" }) !== start.toPlainTime().toString({ smallestUnit: "minute" }) || instanceEnd.toPlainTime().toString({ smallestUnit: "minute" }) !== end.toPlainTime().toString({ smallestUnit: "minute" }))) {
          exceptions.push({ series: { id: undefined, title, dayOfWeek: start.dayOfWeek, localStart: start.toPlainTime().toString({ smallestUnit: "minute" }), localEnd: end.toPlainTime().toString({ smallestUnit: "minute" }), timeZone, termStart, termEnd, week1StartsOn: week1, teachingWeeks, importKey, ...(location ? { location } : {}) }, date, instance, action: "move" });
        }
      }
    }
    const series: CourseSeriesInput = {
      title, dayOfWeek: start.dayOfWeek, localStart: start.toPlainTime().toString({ smallestUnit: "minute" }), localEnd: end.toPlainTime().toString({ smallestUnit: "minute" }),
      timeZone, termStart, termEnd, week1StartsOn: week1, teachingWeeks, importKey, ...(location ? { location } : {})
    };
    return { series, exceptions: exceptions.map((item) => ({ ...item, series: { ...series } })) };
  }

  private seriesComparable(series: CourseSeries) {
    const { id: _id, ownerId: _ownerId, ...comparable } = series;
    return comparable;
  }

  private requireSeries(id: string) {
    const series = this.store.getSeries(this.ownerId, id);
    if (!series) throw new CourseCalendarError("NOT_FOUND", "course series not found", 404);
    return series;
  }

  private assertOperation(operation: CourseOperation, type: string, payloadHash: string) {
    if (operation.operationType !== type || operation.payloadHash !== payloadHash) throw new CourseCalendarError("IDEMPOTENCY_CONFLICT", "operationKey was already used with different content", 409);
  }
}

export default CourseCalendarService;
