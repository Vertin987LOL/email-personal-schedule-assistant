import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { CalendarError, CalendarService } from "./service";
import type { CalendarEvent, CalendarEventInput, CalendarTime, EventPatch } from "./types";
import { queryProcessedEmails } from "../store";
import type { ProcessedEmail } from "../types";

export type CalendarToolContext = {
  taskId: string;
  source: { kind: "manual" | "email" | "plan"; ref: string };
  isActive: () => boolean;
};

export type ToolRecovery = "replan" | "retry" | "ask_user" | "stop";

export type ToolResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        recovery: ToolRecovery;
        details?: unknown;
      };
    };

type Fields = Record<string, unknown>;
type CandidateEvent = Pick<CalendarEvent, "title" | "kind" | "time" | "status"> & Partial<Pick<CalendarEvent, "location" | "reminder" | "sourceEvidence" | "seriesId">>;
type Overlap = {
  eventId: string;
  title: string;
  version: number;
  startsAt: string;
  endsAt: string;
  overlapStart: string;
  overlapEnd: string;
  overlapMinutes: number;
};

export type ProposalPolicy = { requireFree: boolean };

const TOOL_NAMES = new Set([
  "calendar.list",
  "calendar.get",
  "calendar.find_slots",
  "calendar.preview",
  "calendar.propose",
  "calendar.get_operation",
  "calendar.request_input",
  "mail.list_recent",
  "mail.search"
]);
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 500;
const MAX_LOCATION = 500;
const MAX_EVIDENCE = 10_000;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

function fail(code: string, message: string, recovery: ToolRecovery, details?: unknown): never {
  throw new CalendarError(code, message, 400, details);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

function canonical(value: unknown) {
  return JSON.stringify(stable(value));
}

function object(value: unknown, field: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", `${field} must be an object`, "ask_user");
  return value as Fields;
}

function fields(value: Fields, allowed: readonly string[], field = "arguments") {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("INVALID_INPUT", `${field}.${key} is not allowed`, "ask_user");
  }
}

function text(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    fail("INVALID_INPUT", `${field} must be a non-empty string`, "ask_user");
  }
  return value;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("INVALID_INPUT", `${field} is invalid`, "ask_user");
  return value as T;
}

function positiveInteger(value: unknown, field: string, max?: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    fail("INVALID_INPUT", `${field} must be a positive integer`, "ask_user");
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string, max?: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
    fail("INVALID_INPUT", `${field} must be a non-negative integer`, "ask_user");
  }
  return value;
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean") fail("INVALID_INPUT", `${field} must be a boolean`, "ask_user");
  return value;
}

function instant(value: unknown, field: string) {
  if (typeof value !== "string" || !INSTANT_RE.test(value)) {
    fail("INVALID_TIME", `${field} must be an ISO instant with an explicit offset`, "ask_user");
  }
  try {
    return { value, milliseconds: Temporal.Instant.from(value).epochMilliseconds };
  } catch {
    fail("INVALID_TIME", `${field} is not a valid instant`, "ask_user");
  }
}

function timeZone(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    fail("INVALID_TIME", "timeZone must be an IANA time zone", "ask_user");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    fail("INVALID_TIME", `Unknown timeZone: ${value}`, "ask_user");
  }
  return value;
}

function dateOnly(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail("INVALID_TIME", `${field} must be YYYY-MM-DD`, "ask_user");
  try {
    if (Temporal.PlainDate.from(value).toString() !== value) throw new Error("invalid date");
  } catch {
    fail("INVALID_TIME", `${field} is not a valid date`, "ask_user");
  }
  return value;
}

function calendarTime(value: unknown): CalendarTime {
  const input = object(value, "time");
  const kind = enumValue(input.kind, "time.kind", ["interval", "point", "date"] as const);
  const zone = timeZone(input.timeZone);
  if (kind === "interval") {
    fields(input, ["kind", "startsAt", "endsAt", "timeZone"], "time");
    const startsAt = instant(input.startsAt, "time.startsAt");
    const endsAt = instant(input.endsAt, "time.endsAt");
    if (endsAt.milliseconds <= startsAt.milliseconds) fail("INVALID_TIME", "time.endsAt must be after time.startsAt", "ask_user");
    return { kind, startsAt: startsAt.value, endsAt: endsAt.value, timeZone: zone };
  }
  if (kind === "point") {
    fields(input, ["kind", "at", "timeZone"], "time");
    const at = instant(input.at, "time.at");
    return { kind, at: at.value, timeZone: zone };
  }
  fields(input, ["kind", "onDate", "timeZone"], "time");
  return { kind, onDate: dateOnly(input.onDate, "time.onDate"), timeZone: zone };
}

function reminder(value: unknown) {
  if (value === undefined) return undefined;
  const input = object(value, "reminder");
  fields(input, ["enabled", "minutesBefore", "at"], "reminder");
  if (typeof input.enabled !== "boolean") fail("INVALID_INPUT", "reminder.enabled is invalid", "ask_user");
  const result: NonNullable<CalendarEvent["reminder"]> = { enabled: input.enabled };
  if (input.minutesBefore !== undefined) result.minutesBefore = nonNegativeInteger(input.minutesBefore, "reminder.minutesBefore", 1_000_000);
  if (input.at !== undefined) result.at = instant(input.at, "reminder.at").value;
  return result;
}

function eventCandidate(value: unknown, source?: CalendarToolContext["source"], allowMetadata = true): CandidateEvent | CalendarEventInput {
  const input = object(value, "event");
  fields(input, allowMetadata
    ? ["title", "kind", "time", "location", "status", "reminder", "sourceEvidence", "seriesId"]
    : ["title", "kind", "time", "location", "status", "reminder"], "event");
  const result: CandidateEvent & Partial<Pick<CalendarEventInput, "sources">> = {
    title: text(input.title, "event.title", MAX_TITLE),
    kind: enumValue(input.kind, "event.kind", ["course", "activity", "deadline", "time_block"] as const),
    time: calendarTime(input.time),
    status: enumValue(input.status ?? "confirmed", "event.status", ["confirmed", "tentative", "cancelled", "ignored"] as const)
  };
  if (input.location !== undefined) {
    if (typeof input.location !== "string" || input.location.length > MAX_LOCATION) fail("INVALID_INPUT", "event.location is invalid", "ask_user");
    result.location = input.location;
  }
  if (input.reminder !== undefined) result.reminder = reminder(input.reminder);
  if (input.sourceEvidence !== undefined) result.sourceEvidence = text(input.sourceEvidence, "event.sourceEvidence", MAX_EVIDENCE);
  if (input.seriesId !== undefined) result.seriesId = text(input.seriesId, "event.seriesId", 500);
  if (source) return { ...result, sources: [clone(source)] } as CalendarEventInput;
  return result;
}

function patch(value: unknown): EventPatch {
  const input = object(value, "patch");
  fields(input, ["title", "time", "location", "status", "reminder"], "patch");
  if (Object.keys(input).length === 0) fail("INVALID_INPUT", "patch cannot be empty", "ask_user");
  const result: EventPatch = {};
  if ("title" in input) result.title = text(input.title, "patch.title", MAX_TITLE);
  if ("time" in input) result.time = calendarTime(input.time);
  if ("location" in input) {
    if (input.location !== null && (typeof input.location !== "string" || input.location.length > MAX_LOCATION)) fail("INVALID_INPUT", "patch.location is invalid", "ask_user");
    result.location = input.location as string | undefined;
  }
  if ("status" in input) result.status = enumValue(input.status, "patch.status", ["confirmed", "tentative", "cancelled", "ignored"] as const);
  if ("reminder" in input) result.reminder = reminder(input.reminder);
  return result;
}

function context(value: CalendarToolContext) {
  const input = object(value, "context");
  fields(input, ["taskId", "source", "isActive"], "context");
  const source = object(input.source, "context.source");
  fields(source, ["kind", "ref"], "context.source");
  if (typeof input.isActive !== "function") fail("INVALID_INPUT", "context.isActive must be a function", "stop");
  return {
    taskId: text(input.taskId, "context.taskId", 500),
    source: { kind: enumValue(source.kind, "context.source.kind", ["manual", "email", "plan"] as const), ref: text(source.ref, "context.source.ref", 500) },
    isActive: input.isActive as () => boolean
  } satisfies CalendarToolContext;
}

function overlapRange(time: CalendarTime): [number, number] | undefined {
  if (time.kind !== "interval") return undefined;
  return [Temporal.Instant.from(time.startsAt).epochMilliseconds, Temporal.Instant.from(time.endsAt).epochMilliseconds];
}

function occupies(event: Pick<CalendarEvent, "status" | "time">) {
  return (event.status === "confirmed" || event.status === "tentative") && event.time.kind === "interval";
}

function isoMilliseconds(milliseconds: number) {
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toString();
}

function calculateOverlaps(candidate: CandidateEvent, events: CalendarEvent[], targetId?: string): Overlap[] {
  if (!occupies(candidate)) return [];
  const candidateRange = overlapRange(candidate.time);
  if (!candidateRange) return [];
  return events
    .filter((event) => event.id !== targetId && occupies(event))
    .map((event) => {
      const range = overlapRange(event.time);
      if (!range) return undefined;
      const start = Math.max(candidateRange[0], range[0]);
      const end = Math.min(candidateRange[1], range[1]);
      if (start >= end) return undefined;
      return {
        eventId: event.id,
        title: event.title,
        version: event.version,
        startsAt: event.time.kind === "interval" ? event.time.startsAt : "",
        endsAt: event.time.kind === "interval" ? event.time.endsAt : "",
        overlapStart: isoMilliseconds(start),
        overlapEnd: isoMilliseconds(end),
        overlapMinutes: (end - start) / 60_000
      } satisfies Overlap;
    })
    .filter((item): item is Overlap => item !== undefined)
    .sort((a, b) => a.overlapStart.localeCompare(b.overlapStart) || a.eventId.localeCompare(b.eventId));
}

function applyPatch(event: CalendarEvent, changes: EventPatch): CandidateEvent {
  const result: CandidateEvent = { title: event.title, kind: event.kind, time: event.time, status: event.status };
  if (event.location !== undefined) result.location = event.location;
  if (event.reminder !== undefined) result.reminder = event.reminder;
  if (event.sourceEvidence !== undefined) result.sourceEvidence = event.sourceEvidence;
  if (event.seriesId !== undefined) result.seriesId = event.seriesId;
  Object.assign(result, changes);
  if (changes.location === null) delete result.location;
  if ("reminder" in changes && changes.reminder === undefined) delete result.reminder;
  return result;
}

function clock(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) fail("INVALID_TIME", `${field} must be HH:MM`, "ask_user");
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3));
  if (hour > 23 || minute > 59) fail("INVALID_TIME", `${field} must be a valid local time`, "ask_user");
  return hour * 60 + minute;
}

function eventInstantRange(event: CalendarEvent) {
  return event.time.kind === "interval"
    ? [Temporal.Instant.from(event.time.startsAt).epochMilliseconds, Temporal.Instant.from(event.time.endsAt).epochMilliseconds] as const
    : undefined;
}

function activeIntervalRanges(events: CalendarEvent[], from: number, to: number) {
  return events
    .filter((event) => occupies(event))
    .map((event) => {
      const range = eventInstantRange(event);
      return range && range[1] > from && range[0] < to ? range : undefined;
    })
    .filter((range): range is readonly [number, number] => range !== undefined);
}

function mergeRanges(ranges: readonly (readonly [number, number])[]) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<readonly [number, number]> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) merged.push([range[0], range[1]]);
    else merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])];
  }
  return merged;
}

function recoveryFor(code: string): ToolRecovery {
  if (code === "TIME_CONFLICT" || code === "CONFLICT" || code === "VERSION_CONFLICT") return "replan";
  if (code === "STORAGE_FAILED" || code === "SQLITE_BUSY") return "retry";
  if (code === "TASK_INACTIVE" || code === "UNKNOWN_TOOL" || code === "OPERATION_FORBIDDEN" || code === "SOURCE_POLICY") return "stop";
  return "ask_user";
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof CalendarError) {
    return { ok: false, error: { code: error.code, message: error.message, recovery: recoveryFor(error.code), ...(error.details === undefined ? {} : { details: error.details }) } };
  }
  const message = error instanceof Error ? error.message : "calendar tool failed";
  return { ok: false, error: { code: "INTERNAL_ERROR", message, recovery: "retry" } };
}

function formatReceivedAt(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    const h = parts.find((p) => p.type === "hour")?.value;
    const min = parts.find((p) => p.type === "minute")?.value;
    return `${y}-${m}-${d} ${h}:${min}`;
  } catch {
    return value;
  }
}

function formatEmailItem(email: ProcessedEmail) {
  return {
    id: email.id,
    subject: email.subject || "无主题",
    from: email.fromAddress || email.fromName || "未知发件人",
    receivedAt: formatReceivedAt(email.receivedAt || email.processedAt),
    category: email.category,
    summaryZh: email.summaryZh || "无摘要",
    actionItems: Array.isArray(email.actionItemsZh) ? email.actionItemsZh : []
  };
}

export type CalendarToolServiceOptions = {
  mailQuery?: typeof queryProcessedEmails;
};

export class CalendarToolService {
  private readonly checksTable = "calendar_tool_checks";
  private readonly operationsTable = "calendar_tool_operations";
  private readonly mailQuery: typeof queryProcessedEmails;

  constructor(
    private readonly calendar: CalendarService,
    options?: CalendarToolServiceOptions
  ) {
    this.mailQuery = options?.mailQuery ?? queryProcessedEmails;
    this.calendar.repository.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.checksTable} (
        checkId TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        candidateJson TEXT NOT NULL,
        versionsJson TEXT NOT NULL,
        overlapsJson TEXT NOT NULL,
        rangeJson TEXT,
        checkedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.operationsTable} (
        ownerId TEXT NOT NULL,
        operationId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        operationType TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, operationId)
      );
      CREATE TABLE IF NOT EXISTS calendar_tool_proposal_policies (
        ownerId TEXT NOT NULL,
        proposalId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        operationId TEXT NOT NULL,
        requireFree INTEGER NOT NULL,
        candidateJson TEXT,
        targetId TEXT,
        expectedVersion INTEGER,
        ruleDigest TEXT NOT NULL,
        overlapsJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, proposalId),
        UNIQUE (ownerId, operationId)
      );
    `);
  }

  getProposalPolicy(proposalId: string): ProposalPolicy | undefined {
    return getProposalPolicy(this.calendar, proposalId);
  }

  invoke(name: string, args: unknown, ctx: CalendarToolContext): ToolResult {
    try {
      if (!TOOL_NAMES.has(name)) fail("UNKNOWN_TOOL", `unknown calendar tool: ${name}`, "stop");
      const safeContext = context(ctx);
      if (!safeContext.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
      switch (name) {
        case "calendar.list": return this.list(args);
        case "calendar.get": return this.get(args);
        case "calendar.find_slots": return this.findSlots(args);
        case "calendar.preview": return this.preview(args, safeContext);
        case "calendar.propose": return this.propose(args, safeContext);
        case "calendar.get_operation": return this.getOperation(args, safeContext);
        case "calendar.request_input": return this.requestInput(args);
        case "mail.list_recent": return this.listRecentMails(args);
        case "mail.search": return this.searchMails(args);
        default: fail("UNKNOWN_TOOL", `unknown calendar tool: ${name}`, "stop");
      }
    } catch (error) {
      return errorResult(error);
    }
  }

  private list(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["from", "to"]);
    const from = instant(input.from, "from");
    const to = instant(input.to, "to");
    if (to.milliseconds <= from.milliseconds) fail("INVALID_TIME", "to must be after from", "ask_user");
    return { ok: true, data: this.calendar.listEvents(from.value, to.value) };
  }

  private get(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["eventId"]);
    return { ok: true, data: this.calendar.getEvent(text(input.eventId, "eventId", 200)) };
  }

  private findSlots(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["from", "to", "durationMinutes", "timeZone", "dayStart", "dayEnd", "limit"]);
    const from = instant(input.from, "from");
    const to = instant(input.to, "to");
    if (to.milliseconds <= from.milliseconds) fail("INVALID_TIME", "to must be after from", "ask_user");
    if (to.milliseconds - from.milliseconds > MAX_RANGE_MS) fail("INVALID_TIME", "find_slots range cannot exceed 31 days", "ask_user");
    const duration = positiveInteger(input.durationMinutes, "durationMinutes", 24 * 60);
    const zone = timeZone(input.timeZone);
    const startMinutes = input.dayStart === undefined ? 8 * 60 : clock(input.dayStart, "dayStart");
    const endMinutes = input.dayEnd === undefined ? 22 * 60 : clock(input.dayEnd, "dayEnd");
    if (endMinutes <= startMinutes) fail("INVALID_TIME", "dayEnd must be after dayStart", "ask_user");
    const limit = input.limit === undefined ? 10 : positiveInteger(input.limit, "limit", 10);
    const events = this.calendar.repository.listEvents(this.calendar.ownerId);
    const slots: Array<{ startsAt: string; endsAt: string; timeZone: string }> = [];
    let date = Temporal.Instant.from(from.value).toZonedDateTimeISO(zone).toPlainDate();
    const lastDate = Temporal.Instant.from(to.value).toZonedDateTimeISO(zone).toPlainDate();
    while (Temporal.PlainDate.compare(date, lastDate) <= 0 && slots.length < limit) {
      const startLocal = date.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from({ hour: Math.floor(startMinutes / 60), minute: startMinutes % 60 }) });
      const endLocal = date.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from({ hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 }) });
      const dayFrom = Math.max(from.milliseconds, startLocal.toInstant().epochMilliseconds);
      const dayTo = Math.min(to.milliseconds, endLocal.toInstant().epochMilliseconds);
      const occupied = mergeRanges(activeIntervalRanges(events, dayFrom, dayTo));
      const addGap = (gapFrom: number, gapTo: number) => {
        let cursor = gapFrom;
        while (cursor + duration * 60_000 <= gapTo && slots.length < limit) {
          const candidateEnd = cursor + duration * 60_000;
          slots.push({ startsAt: isoMilliseconds(cursor), endsAt: isoMilliseconds(candidateEnd), timeZone: zone });
          cursor = candidateEnd;
        }
      };
      let cursor = dayFrom;
      for (const [blockedFrom, blockedTo] of occupied) {
        if (blockedFrom > cursor) addGap(cursor, blockedFrom);
        cursor = Math.max(cursor, blockedTo);
        if (slots.length >= limit) break;
      }
      if (slots.length < limit && cursor < dayTo) addGap(cursor, dayTo);
      date = date.add({ days: 1 });
    }
    return { ok: true, data: slots };
  }

  private preview(args: unknown, ctx: CalendarToolContext): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["event", "targetId", "patch", "expectedVersion", "requireFree"]);
    const prepared = this.prepareCandidate(input, ctx);
    const events = this.calendar.repository.listEvents(this.calendar.ownerId);
    const overlaps = prepared.candidate ? calculateOverlaps(prepared.candidate, events, prepared.targetId) : [];
    const checkId = randomUUID();
    if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
    this.persistCheck(checkId, ctx, prepared.candidate, events, prepared.targetId, overlaps);
    if (input.requireFree === true && overlaps.length > 0) {
      throw new CalendarError("TIME_CONFLICT", "candidate overlaps existing calendar events", 409, {
        checkId,
        overlaps,
        suggestion: { tool: "calendar.find_slots" }
      });
    }
    return {
      ok: true,
      data: {
        checkId,
        overlaps,
        warnings: overlaps.length > 0 ? [{ code: "TIME_CONFLICT", message: "candidate overlaps existing calendar events" }] : [],
        ...(prepared.targetId ? { targetId: prepared.targetId } : {})
      }
    };
  }

  private propose(args: unknown, ctx: CalendarToolContext): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["action", "event", "targetId", "expectedVersion", "patch", "evidence", "requireFree"]);
    const action = enumValue(input.action, "action", ["create", "update", "cancel"] as const);
    const evidence = text(input.evidence, "evidence", MAX_EVIDENCE);
    const requireFree = input.requireFree === undefined ? false : booleanValue(input.requireFree, "requireFree");
    const normalized: Record<string, unknown> = { action, evidence };
    let candidate: CandidateEvent | undefined;
    let targetId: string | undefined;
    if (ctx.source.kind === "email" && action !== "create") {
      fail("SOURCE_POLICY", "email-sourced tasks may only propose tentative new activities", "stop");
    }
    if (action === "create") {
      if (input.targetId !== undefined || input.expectedVersion !== undefined || input.patch !== undefined) fail("INVALID_INPUT", "create proposal cannot target or patch an event", "ask_user");
      if (input.event === undefined) fail("INVALID_INPUT", "create proposal needs an event", "ask_user");
      const rawEvent = object(input.event, "event");
      if (ctx.source.kind !== "plan") {
        if (rawEvent.seriesId !== undefined || rawEvent.sourceEvidence !== undefined || (ctx.source.kind === "email" && rawEvent.reminder !== undefined)) {
          fail("SOURCE_POLICY", "this proposal source cannot supply host metadata or email-triggered reminders", "stop");
        }
        if (rawEvent.kind === "course") fail("SOURCE_POLICY", "course events must come from the course importer", "stop");
      }
      const event = eventCandidate(input.event, ctx.source) as CalendarEventInput;
      if (ctx.source.kind === "email") event.status = "tentative";
      candidate = event;
      normalized.event = event;
    } else {
      if (input.event !== undefined || input.targetId === undefined || input.expectedVersion === undefined) fail("INVALID_INPUT", `${action} proposal needs targetId and expectedVersion`, "ask_user");
      targetId = text(input.targetId, "targetId", 200);
      const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
      normalized.targetId = targetId;
      normalized.expectedVersion = expectedVersion;
      const target = this.calendar.getEvent(targetId);
      if (target.version !== expectedVersion) throw new CalendarError("VERSION_CONFLICT", "event version is stale", 409, { current: target });
      if (action === "update") {
        if (input.patch === undefined) fail("INVALID_INPUT", "update proposal needs patch", "ask_user");
        const changes = patch(input.patch);
        candidate = applyPatch(target, changes);
        normalized.patch = changes;
      } else {
        if (input.patch !== undefined) fail("INVALID_INPUT", "cancel proposal cannot contain patch", "ask_user");
        normalized.targetId = targetId;
      }
    }
    const events = this.calendar.repository.listEvents(this.calendar.ownerId);
    const overlaps = candidate ? calculateOverlaps(candidate, events, targetId) : [];
    if (requireFree && overlaps.length > 0) {
      throw new CalendarError("TIME_CONFLICT", "proposal overlaps existing calendar events", 409, { overlaps, suggestion: { tool: "calendar.find_slots" } });
    }
    const operationArgs = clone(normalized);
    if (operationArgs.event && typeof operationArgs.event === "object" && !Array.isArray(operationArgs.event)) {
      delete (operationArgs.event as Fields).sources;
    }
    const operationKey = this.operationKey(ctx.taskId, "calendar.propose", operationArgs);
    normalized.operationKey = operationKey;
    if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
    const proposal = this.calendar.repository.withTransaction(() => {
      this.persistOperation(operationKey, ctx, "proposal:create");
      if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
      const created = this.calendar.createProposal(normalized);
      if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
      this.persistProposalPolicy(created.id, operationKey, ctx, candidate, targetId, input.expectedVersion, requireFree, overlaps);
      return created;
    });
    return { ok: true, data: { operationId: operationKey, proposal, ...(overlaps.length > 0 ? { warnings: [{ code: "TIME_CONFLICT", message: "proposal overlaps existing calendar events" }] } : {}) } };
  }

  private getOperation(args: unknown, ctx: CalendarToolContext): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["operationId"]);
    const operationId = text(input.operationId, "operationId", 200);
    const row = this.calendar.repository.db.prepare(`SELECT taskId, operationType FROM ${this.operationsTable} WHERE ownerId = ? AND operationId = ?`).get(this.calendar.ownerId, operationId) as { taskId?: string; operationType?: string } | undefined;
    if (!row) throw new CalendarError("OPERATION_NOT_FOUND", "calendar operation not found", 404);
    if (row.taskId !== ctx.taskId) throw new CalendarError("OPERATION_FORBIDDEN", "operation belongs to another task", 403);
    const stored = this.calendar.repository.getOperation(this.calendar.ownerId, operationId);
    if (!stored) throw new CalendarError("STORAGE_FAILED", "calendar operation record is missing", 500);
    let result: unknown;
    try { result = JSON.parse(stored.resultJson); } catch { throw new CalendarError("STORAGE_FAILED", "calendar operation result is invalid", 500); }
    return { ok: true, data: { operationId, operationType: row.operationType, result } };
  }

  private requestInput(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["question", "missing"]);
    if (!Array.isArray(input.missing) || input.missing.length === 0 || input.missing.length > 32) fail("INVALID_INPUT", "missing must be a non-empty array", "ask_user");
    const missing = input.missing.map((item, index) => text(item, `missing[${index}]`, 200));
    return { ok: true, data: { status: "needs_input", question: text(input.question, "question", 2_000), missing } };
  }

  private listRecentMails(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["limit", "category"]);
    const limit = input.limit === undefined ? 5 : positiveInteger(input.limit, "limit", 15);
    const category = input.category === undefined ? "all" : enumValue(input.category, "category", ["all", "important", "secondary"] as const);
    const queryOptions: Parameters<typeof queryProcessedEmails>[0] = { limit };
    if (category === "all") {
      queryOptions.excludeCategory = "ignore";
    } else {
      queryOptions.category = category;
    }
    const result = this.mailQuery(queryOptions);
    return {
      ok: true,
      data: {
        total: result.total,
        emails: result.items.map(formatEmailItem)
      }
    };
  }

  private searchMails(args: unknown): ToolResult {
    const input = object(args, "arguments");
    fields(input, ["query", "limit"]);
    const query = text(input.query, "query", 500);
    const limit = input.limit === undefined ? 5 : positiveInteger(input.limit, "limit", 15);
    const result = this.mailQuery({
      q: query,
      limit,
      excludeCategory: "ignore"
    });
    return {
      ok: true,
      data: {
        query,
        count: result.items.length,
        emails: result.items.map(formatEmailItem)
      }
    };
  }

  private prepareCandidate(input: Fields, ctx: CalendarToolContext) {
    const hasEvent = input.event !== undefined;
    const hasTarget = input.targetId !== undefined;
    if (hasEvent === hasTarget) fail("INVALID_INPUT", "preview needs either event or targetId", "ask_user");
    if (hasEvent) {
      if (input.patch !== undefined || input.expectedVersion !== undefined) fail("INVALID_INPUT", "create preview cannot contain patch or expectedVersion", "ask_user");
      if (input.requireFree !== undefined) booleanValue(input.requireFree, "requireFree");
      return { candidate: eventCandidate(input.event, undefined, false) as CandidateEvent, targetId: undefined };
    }
    const targetId = text(input.targetId, "targetId", 200);
    if (input.patch === undefined || input.expectedVersion === undefined) fail("INVALID_INPUT", "update preview needs patch and expectedVersion", "ask_user");
    const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
    const target = this.calendar.getEvent(targetId);
    if (target.version !== expectedVersion) throw new CalendarError("VERSION_CONFLICT", "event version is stale", 409, { current: target });
    if (input.requireFree !== undefined) booleanValue(input.requireFree, "requireFree");
    return { candidate: applyPatch(target, patch(input.patch)), targetId };
  }

  private operationKey(taskId: string, name: string, args: unknown) {
    return `calendar:${createHash("sha256").update(canonical({ taskId, name, args })).digest("hex")}`;
  }

  private persistCheck(checkId: string, ctx: CalendarToolContext, candidate: CandidateEvent | undefined, events: CalendarEvent[], targetId: string | undefined, overlaps: Overlap[]) {
    const related = events
      .filter((event) => event.id !== targetId)
      .map((event) => ({ eventId: event.id, version: event.version }));
    const candidateRange = candidate?.time.kind === "interval"
      ? { from: candidate.time.startsAt, to: candidate.time.endsAt }
      : undefined;
    const checkedAt = new Date().toISOString();
    if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
    this.calendar.repository.db.prepare(`
      INSERT INTO ${this.checksTable} (checkId, ownerId, taskId, candidateJson, versionsJson, overlapsJson, rangeJson, checkedAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(checkId, this.calendar.ownerId, ctx.taskId, JSON.stringify(candidate ?? null), JSON.stringify(related), JSON.stringify(overlaps), candidateRange ? JSON.stringify(candidateRange) : null, checkedAt, checkedAt);
  }

  private persistOperation(operationId: string, ctx: CalendarToolContext, operationType: string) {
    const existing = this.calendar.repository.db.prepare(`SELECT taskId FROM ${this.operationsTable} WHERE ownerId = ? AND operationId = ?`).get(this.calendar.ownerId, operationId) as { taskId?: string } | undefined;
    if (existing && existing.taskId !== ctx.taskId) throw new CalendarError("OPERATION_FORBIDDEN", "operation belongs to another task", 403);
    if (existing) return;
    if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
    this.calendar.repository.db.prepare(`
      INSERT INTO ${this.operationsTable} (ownerId, operationId, taskId, operationType, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.calendar.ownerId, operationId, ctx.taskId, operationType, new Date().toISOString());
  }

  private persistProposalPolicy(proposalId: string, operationId: string, ctx: CalendarToolContext, candidate: CandidateEvent | undefined, targetId: string | undefined, expectedVersion: unknown, requireFree: boolean, overlaps: Overlap[]) {
    const checkedAt = new Date().toISOString();
    if (!ctx.isActive()) fail("TASK_INACTIVE", "calendar task is no longer active", "stop");
    const ruleDigest = createHash("sha256").update(canonical({ requireFree, candidate, targetId, expectedVersion })).digest("hex");
    const existing = this.calendar.repository.db.prepare(
      "SELECT taskId, ruleDigest FROM calendar_tool_proposal_policies WHERE ownerId = ? AND operationId = ?"
    ).get(this.calendar.ownerId, operationId) as { taskId?: string; ruleDigest?: string } | undefined;
    if (existing) {
      if (existing.taskId !== ctx.taskId) throw new CalendarError("OPERATION_FORBIDDEN", "operation belongs to another task", 403);
      if (existing.ruleDigest !== ruleDigest) throw new CalendarError("IDEMPOTENCY_CONFLICT", "proposal rule changed for the same operation", 409);
      return;
    }
    this.calendar.repository.db.prepare(`
      INSERT INTO calendar_tool_proposal_policies
        (ownerId, proposalId, taskId, operationId, requireFree, candidateJson, targetId, expectedVersion, ruleDigest, overlapsJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.calendar.ownerId, proposalId, ctx.taskId, operationId, requireFree ? 1 : 0, candidate ? JSON.stringify(candidate) : null, targetId ?? null, typeof expectedVersion === "number" ? expectedVersion : null, ruleDigest, JSON.stringify(overlaps), checkedAt);
  }
}

export function getProposalPolicy(calendar: CalendarService, proposalId: string): ProposalPolicy | undefined {
  if (typeof proposalId !== "string" || proposalId.length === 0) return undefined;
  const row = calendar.repository.db.prepare(
    "SELECT requireFree FROM calendar_tool_proposal_policies WHERE ownerId = ? AND proposalId = ?"
  ).get(calendar.ownerId, proposalId) as { requireFree?: number } | undefined;
  return row ? { requireFree: Number(row.requireFree) === 1 } : undefined;
}
