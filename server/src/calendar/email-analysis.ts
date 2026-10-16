import { createHash } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { CalendarError, CalendarService } from "./service";
import { CalendarToolService, type ToolResult } from "./agent-tools";
import type { CalendarEvent, CalendarTime, EventPatch } from "./types";

export type EmailCalendarInput = {
  emailId: string;
  sourceKey: string;
  taskId?: string;
  subject: string;
  bodyText: string;
  fromAddress?: string;
  modelText: string;
};

export type EmailCalendarOverlap = {
  eventId: string;
  title: string;
  version: number;
  status: "confirmed" | "tentative";
  startsAt: string;
  endsAt: string;
  overlapStart: string;
  overlapEnd: string;
  overlapMinutes: number;
};

export type EmailActivityAnalysis = {
  key: string;
  title: string;
  kind: "activity" | "deadline";
  action: "create" | "update" | "cancel";
  evidence: string;
  time?: CalendarTime;
  knownStart?: { at: string; timeZone: string };
  missing?: string[];
  externalEventId?: string;
  candidateId?: string;
  eventId?: string;
  proposalId?: string;
  status: "created" | "existing" | "proposed" | "needs_details" | "needs_review" | "ignored";
  overlaps: EmailCalendarOverlap[];
  coverage: "unverified";
};

export type EmailCalendarAnalysis = {
  emailId: string;
  sourceKey: string;
  subject: string;
  summaryZh: string;
  checkedAt: string;
  activities: EmailActivityAnalysis[];
  status: "ok" | "failed";
  reason?: string;
};

type Fields = Record<string, unknown>;
type ParsedActivity = {
  key: string;
  title: string;
  kind: "activity" | "deadline";
  time?: CalendarTime;
  knownStart?: { at: string; timeZone: string };
  missing: string[];
  evidence: string;
  externalEventId?: string;
  action: "create" | "update" | "cancel";
};
type ParsedModel = { summaryZh: string; activities: ParsedActivity[] };
type ExternalRow = { sender: string | null; emailId: string; sourceKey: string; eventId: string | null; candidateId: string | null };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 200_000;
const MAX_REASON = 2_000;

class AnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisInputError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function inputObject(value: unknown, field: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnalysisInputError(`${field} must be an object`);
  return value as Fields;
}

function allowed(value: Fields, keys: readonly string[], field: string) {
  const allowedKeys = new Set(keys);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new AnalysisInputError(`${field}.${key} is not allowed`);
}

function requiredText(value: unknown, field: string, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AnalysisInputError(`${field} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, field: string, max = MAX_TEXT) {
  if (value === undefined) return undefined;
  return requiredText(value, field, max);
}

function zone(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new AnalysisInputError(`${field} must be an IANA time zone`);
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); } catch { throw new AnalysisInputError(`${field} is not a valid IANA time zone`); }
  return value;
}

function instant(value: unknown, field: string) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) throw new AnalysisInputError(`${field} must be an ISO instant with an explicit offset`);
  try { Temporal.Instant.from(value); } catch { throw new AnalysisInputError(`${field} is invalid`); }
  return value;
}

function dateOnly(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) throw new AnalysisInputError(`${field} must be YYYY-MM-DD`);
  try { if (Temporal.PlainDate.from(value).toString() !== value) throw new Error("invalid date"); } catch { throw new AnalysisInputError(`${field} is invalid`); }
  return value;
}

function modelTime(value: unknown): CalendarTime {
  const input = inputObject(value, "activity.time");
  if (typeof input.kind !== "string") throw new AnalysisInputError("activity.time.kind is required");
  const timeZone = zone(input.timeZone, "activity.time.timeZone");
  if (input.kind === "interval") {
    allowed(input, ["kind", "startsAt", "endsAt", "timeZone"], "activity.time");
    const startsAt = instant(input.startsAt, "activity.time.startsAt");
    const endsAt = instant(input.endsAt, "activity.time.endsAt");
    if (Temporal.Instant.from(endsAt).epochMilliseconds <= Temporal.Instant.from(startsAt).epochMilliseconds) throw new AnalysisInputError("activity.time.endsAt must be after startsAt");
    return { kind: "interval", startsAt, endsAt, timeZone };
  }
  if (input.kind === "point") {
    allowed(input, ["kind", "at", "timeZone"], "activity.time");
    return { kind: "point", at: instant(input.at, "activity.time.at"), timeZone };
  }
  if (input.kind === "date") {
    allowed(input, ["kind", "onDate", "timeZone"], "activity.time");
    return { kind: "date", onDate: dateOnly(input.onDate, "activity.time.onDate"), timeZone };
  }
  throw new AnalysisInputError("activity.time.kind is invalid");
}

function knownStart(value: unknown) {
  const input = inputObject(value, "activity.knownStart");
  allowed(input, ["at", "timeZone"], "activity.knownStart");
  return { at: instant(input.at, "activity.knownStart.at"), timeZone: zone(input.timeZone, "activity.knownStart.timeZone") };
}

function parseFence(value: string) {
  const text = value.trim();
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (match) return match[1];
  if (text.includes("```")) throw new AnalysisInputError("modelText contains an invalid JSON fence");
  return text;
}

function parseModel(modelText: string, bodyText: string, subject: string): ParsedModel {
  let raw: unknown;
  try { raw = JSON.parse(parseFence(modelText)); } catch { throw new AnalysisInputError("modelText must be strict JSON"); }
  const root = inputObject(raw, "model");
  allowed(root, ["summaryZh", "activities"], "model");
  const summaryZh = requiredText(root.summaryZh, "summaryZh", 20_000);
  if (!Array.isArray(root.activities) || root.activities.length > 10) throw new AnalysisInputError("activities must contain at most 10 items");
  const activities = root.activities.map((rawActivity, index) => parseActivity(rawActivity, index, bodyText, subject));
  return { summaryZh, activities };
}

export function validateEmailCalendarExtraction(modelText: string, bodyText: string, subject: string): { ok: true } | { ok: false; message: string } {
  try {
    parseModel(modelText, bodyText, subject);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: safeReason(error) };
  }
}

function parseActivity(value: unknown, index: number, bodyText: string, subject: string): ParsedActivity {
  const input = inputObject(value, `activities[${index}]`);
  allowed(input, ["key", "title", "kind", "time", "knownStart", "missing", "evidence", "externalEventId", "action"], `activities[${index}]`);
  const key = requiredText(input.key, `activities[${index}].key`, 200);
  const title = requiredText(input.title, `activities[${index}].title`, 500);
  const kind = input.kind;
  if (kind !== "activity" && kind !== "deadline") throw new AnalysisInputError(`activities[${index}].kind is invalid`);
  const evidence = requiredText(input.evidence, `activities[${index}].evidence`, 10_000);
  if (!bodyText.includes(evidence) && !subject.includes(evidence)) throw new AnalysisInputError(`activities[${index}].evidence is not in the email`);
  const externalEventId = optionalText(input.externalEventId, `activities[${index}].externalEventId`, 500);
  if (externalEventId && !evidence.includes(externalEventId)) throw new AnalysisInputError(`activities[${index}].externalEventId is not in evidence`);
  const time = input.time === undefined ? undefined : modelTime(input.time);
  const start = input.knownStart === undefined ? undefined : knownStart(input.knownStart);
  if (time?.kind === "interval" && start && Temporal.Instant.from(time.startsAt).epochMilliseconds !== Temporal.Instant.from(start.at).epochMilliseconds) throw new AnalysisInputError(`activities[${index}].knownStart does not match time.startsAt`);
  if (input.missing !== undefined && (!Array.isArray(input.missing) || input.missing.length > 20 || input.missing.some((item) => typeof item !== "string" || !item.trim()))) throw new AnalysisInputError(`activities[${index}].missing is invalid`);
  const missing = [...new Set((input.missing as string[] | undefined)?.map(String) ?? [])];
  const action = input.action === undefined ? "create" : input.action;
  if (action !== "create" && action !== "update" && action !== "cancel") throw new AnalysisInputError(`activities[${index}].action is invalid`);
  if (action === "cancel" && time !== undefined) throw new AnalysisInputError(`activities[${index}].cancel cannot contain time`);
  return { key, title, kind, ...(time ? { time } : {}), ...(start ? { knownStart: start } : {}), missing, evidence, ...(externalEventId ? { externalEventId } : {}), action };
}

function normalizeSender(value: string | undefined) {
  if (value === undefined) return null;
  const text = requiredText(value, "fromAddress", 500).trim().toLowerCase();
  const angle = /<([^<>]+)>/.exec(text);
  return (angle?.[1] ?? text).trim();
}

function candidateId(emailId: string, key: string) {
  return `email-candidate:${digest({ emailId, key }).slice(0, 48)}`;
}

function operationKey(emailId: string, key: string, action: string) {
  return `email-analysis:${digest({ emailId, key, action }).slice(0, 48)}`;
}

function activeInterval(event: CalendarEvent) {
  if (event.status !== "confirmed" && event.status !== "tentative") return undefined;
  if (event.time.kind !== "interval") return undefined;
  return [Temporal.Instant.from(event.time.startsAt).epochMilliseconds, Temporal.Instant.from(event.time.endsAt).epochMilliseconds] as const;
}

function pointOverlaps(calendar: CalendarService, at: string): EmailCalendarOverlap[] {
  const instantMs = Temporal.Instant.from(at).epochMilliseconds;
  return calendar.repository.listEvents(calendar.ownerId).flatMap((event) => {
    const range = activeInterval(event);
    if (!range || instantMs < range[0] || instantMs >= range[1]) return [];
    return [{
      eventId: event.id, title: event.title, version: event.version,
      status: event.status === "tentative" ? "tentative" : "confirmed",
      startsAt: event.time.kind === "interval" ? event.time.startsAt : "",
      endsAt: event.time.kind === "interval" ? event.time.endsAt : "",
      overlapStart: Temporal.Instant.from(at).toString(), overlapEnd: Temporal.Instant.from(at).toString(), overlapMinutes: 0
    }];
  });
}

function asOverlaps(result: ToolResult, calendar: CalendarService): EmailCalendarOverlap[] {
  if (!result.ok) throw new CalendarError(result.error.code, result.error.message, 400, result.error.details);
  const data = result.data as { overlaps?: unknown };
  if (!Array.isArray(data?.overlaps)) return [];
  return (clone(data.overlaps) as Array<EmailCalendarOverlap & { status?: unknown }>).map((overlap) => {
    const event = calendar.repository.getEvent(calendar.ownerId, overlap.eventId);
    return { ...overlap, status: event?.status === "tentative" ? "tentative" : "confirmed" };
  });
}

function taskIdFor(input: Pick<EmailCalendarInput, "emailId" | "taskId">) {
  return input.taskId ?? `email:${input.emailId}`;
}

function titleFingerprint(title: string) {
  return title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function similarTitle(left: string, right: string) {
  const a = titleFingerprint(left);
  const b = titleFingerprint(right);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
}

function sameTime(left: CalendarTime, right: CalendarTime) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "interval" && right.kind === "interval") {
    return Temporal.Instant.from(left.startsAt).epochMilliseconds === Temporal.Instant.from(right.startsAt).epochMilliseconds
      && Temporal.Instant.from(left.endsAt).epochMilliseconds === Temporal.Instant.from(right.endsAt).epochMilliseconds;
  }
  if (left.kind === "point" && right.kind === "point") {
    return Temporal.Instant.from(left.at).epochMilliseconds === Temporal.Instant.from(right.at).epochMilliseconds;
  }
  return left.kind === "date" && right.kind === "date" && left.onDate === right.onDate;
}

function safeReason(error: unknown) {
  const message = error instanceof Error ? error.message : "email calendar analysis failed";
  return message.slice(0, MAX_REASON);
}

export class CalendarEmailAnalysisService {
  private readonly tools: CalendarToolService;

  constructor(private readonly calendar: CalendarService) {
    this.tools = new CalendarToolService(calendar);
    calendar.repository.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_email_analysis (
        ownerId TEXT NOT NULL,
        emailId TEXT NOT NULL,
        sourceKey TEXT NOT NULL,
        fromAddress TEXT,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, emailId)
      );
      CREATE TABLE IF NOT EXISTS calendar_email_external (
        ownerId TEXT NOT NULL,
        externalEventId TEXT NOT NULL,
        sender TEXT,
        emailId TEXT NOT NULL,
        sourceKey TEXT NOT NULL,
        eventId TEXT,
        candidateId TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, externalEventId)
      );
    `);
  }

  finalize(input: EmailCalendarInput): EmailCalendarAnalysis {
    const base = this.validateInput(input);
    const existing = this.get(base.emailId);
    if (existing) return existing;
    try {
      const model = parseModel(base.modelText, base.bodyText, base.subject);
      return this.calendar.repository.withTransaction(() => {
        const replay = this.get(base.emailId);
        if (replay) return replay;
        const activities = model.activities.map((item) => this.processActivity(item, base));
        const analysis: EmailCalendarAnalysis = {
          emailId: base.emailId, sourceKey: base.sourceKey, subject: base.subject,
          summaryZh: model.summaryZh, checkedAt: new Date().toISOString(), activities, status: "ok"
        };
        this.saveAnalysis(analysis, base);
        return clone(analysis);
      });
    } catch (error) {
      return this.persistFailure(base, safeReason(error));
    }
  }

  fail(emailId: string, reason: string): EmailCalendarAnalysis {
    const id = requiredText(emailId, "emailId", 500);
    const existing = this.get(id);
    if (existing) return existing;
    const base: EmailCalendarInput = { emailId: id, sourceKey: `email:${id}`, subject: "", bodyText: "", modelText: "" };
    return this.persistFailure(base, requiredText(reason, "reason", MAX_REASON));
  }

  get(emailId: string): EmailCalendarAnalysis | undefined {
    if (typeof emailId !== "string" || !emailId.trim()) return undefined;
    const row = this.calendar.repository.db.prepare(
      "SELECT data FROM calendar_email_analysis WHERE ownerId = ? AND emailId = ?"
    ).get(this.calendar.ownerId, emailId) as { data?: string } | undefined;
    if (!row) return undefined;
    return clone(JSON.parse(String(row.data)) as EmailCalendarAnalysis);
  }

  private validateInput(value: EmailCalendarInput): EmailCalendarInput {
    const input = inputObject(value, "input");
    allowed(input, ["emailId", "sourceKey", "taskId", "subject", "bodyText", "fromAddress", "modelText"], "input");
    return {
      emailId: requiredText(input.emailId, "emailId", 500), sourceKey: requiredText(input.sourceKey, "sourceKey", 500),
      ...(input.taskId === undefined ? {} : { taskId: requiredText(input.taskId, "taskId", 500) }),
      subject: typeof input.subject === "string" && input.subject.length <= MAX_TEXT ? input.subject : (() => { throw new AnalysisInputError("subject is invalid"); })(), bodyText: typeof input.bodyText === "string" && input.bodyText.length <= MAX_TEXT ? input.bodyText : (() => { throw new AnalysisInputError("bodyText is invalid"); })(),
      ...(input.fromAddress === undefined ? {} : { fromAddress: requiredText(input.fromAddress, "fromAddress", 500) }),
      modelText: requiredText(input.modelText, "modelText", MAX_TEXT)
    };
  }

  private processActivity(item: ParsedActivity, input: EmailCalendarInput): EmailActivityAnalysis {
    const sender = normalizeSender(input.fromAddress);
    const mapped = item.externalEventId ? this.external(item.externalEventId) : undefined;
    if (item.externalEventId && mapped && input.fromAddress === undefined) return this.needsReview(item, ["sender_verification"]);
    if (item.externalEventId && mapped && mapped.sender !== sender) return this.needsReview(item, ["sender_verification"]);
    const mappedEvent = mapped?.eventId ? this.calendar.repository.getEvent(this.calendar.ownerId, mapped.eventId) : undefined;
    if (item.externalEventId && mapped && (!mappedEvent || !mappedEvent.sources.some((source) => source.kind === "email" && source.ref === mapped.sourceKey))) return this.needsReview(item, ["module_event_verification"]);
    if (mappedEvent && item.action === "create") {
      const attached = this.attachEmailSource(mappedEvent, item, input);
      const overlaps = this.overlapsForTarget(attached, input);
      const status = attached.status === "cancelled" || attached.status === "ignored" ? "ignored" : "existing";
      return { ...this.baseActivity(item, status), eventId: attached.id, overlaps };
    }
    if (item.action !== "create") {
      if (!mappedEvent) return this.needsReview(item, ["reliable_external_event_id"]);
      return this.proposeChange(item, input, this.attachEmailSource(mappedEvent, item, input));
    }
    if (item.externalEventId && mappedEvent) return { ...this.baseActivity(item, "existing"), eventId: mappedEvent.id };
    const complete = item.kind === "deadline"
      ? item.time?.kind === "date" || item.time?.kind === "point"
      : item.kind === "activity" && item.time?.kind === "interval";
    const startOnly = item.knownStart ?? (item.time?.kind === "point" && item.kind === "activity" ? { at: item.time.at, timeZone: item.time.timeZone } : undefined);
    const duplicate = !item.externalEventId && complete && item.time ? this.findDuplicate(item.title, item.time) : undefined;
    if (duplicate) {
      const overlaps = asOverlaps(this.tools.invoke("calendar.preview", {
        event: { title: item.title, kind: item.kind, time: item.time }, requireFree: false
      }, { taskId: taskIdFor(input), source: { kind: "email", ref: input.sourceKey }, isActive: () => true }), this.calendar);
      const id = candidateId(input.emailId, item.key);
      const missing = ["possible_duplicate"];
      const candidate = this.calendar.upsertCandidate({
        id, source: { kind: "email", ref: input.sourceKey }, title: item.title, kind: item.kind, time: item.time, evidence: item.evidence, state: "needs_details", missing
      });
      if (candidate.state === "ignored") return { ...this.baseActivity(item, "ignored"), candidateId: candidate.id, missing, overlaps };
      if (candidate.state === "confirmed" && candidate.linkedEventId) return { ...this.baseActivity(item, "existing"), candidateId: candidate.id, eventId: candidate.linkedEventId, missing, overlaps };
      return { ...this.baseActivity(item, "needs_review"), candidateId: id, missing, overlaps };
    }
    if (!complete || item.missing.length > 0) {
      const overlaps = startOnly ? pointOverlaps(this.calendar, startOnly.at) : [];
      const missing = item.missing.length ? item.missing : ["complete_time"];
      const id = candidateId(input.emailId, item.key);
      const candidate = this.calendar.upsertCandidate({
        id, source: { kind: "email", ref: input.sourceKey }, title: item.title, kind: item.kind,
        ...(item.time ? { time: item.time } : {}), evidence: item.evidence, state: "needs_details", missing
      });
      if (candidate.state === "ignored") return { ...this.baseActivity(item, "ignored"), candidateId: candidate.id, missing, overlaps };
      if (candidate.state === "confirmed" && candidate.linkedEventId) return { ...this.baseActivity(item, "existing"), candidateId: candidate.id, eventId: candidate.linkedEventId, missing, overlaps };
      return { ...this.baseActivity(item, "needs_details"), candidateId: id, missing, overlaps };
    }
    const overlaps = asOverlaps(this.tools.invoke("calendar.preview", {
      event: { title: item.title, kind: item.kind, time: item.time }, requireFree: false
    }, { taskId: taskIdFor(input), source: { kind: "email", ref: input.sourceKey }, isActive: () => true }), this.calendar);
    const id = candidateId(input.emailId, item.key);
    const candidate = this.calendar.upsertCandidate({ id, source: { kind: "email", ref: input.sourceKey }, title: item.title, kind: item.kind, time: item.time, evidence: item.evidence, state: "ready", missing: [] });
    if (candidate.state === "ignored") return { ...this.baseActivity(item, "ignored"), candidateId: candidate.id, overlaps };
    if (candidate.state === "confirmed" && candidate.linkedEventId) return { ...this.baseActivity(item, "existing"), candidateId: candidate.id, eventId: candidate.linkedEventId, overlaps };
    const confirmed = this.calendar.confirmCandidate(id, operationKey(input.emailId, item.key, "confirm"));
    if (!confirmed.event) return { ...this.baseActivity(item, "needs_details"), candidateId: id, missing: ["complete_time"], overlaps };
    let finalEvent = confirmed.event;
    if (finalEvent.status === "confirmed") finalEvent = this.calendar.updateEvent(finalEvent.id, finalEvent.version, operationKey(input.emailId, item.key, "tentative"), { status: "tentative" });
    if (item.externalEventId) this.saveExternal(item.externalEventId, input, id, finalEvent.id);
    return { ...this.baseActivity(item, "created"), candidateId: id, eventId: finalEvent.id, overlaps };
  }

  private proposeChange(item: ParsedActivity, input: EmailCalendarInput, target: CalendarEvent): EmailActivityAnalysis {
    if (target.status === "cancelled" || target.status === "ignored") return { ...this.baseActivity(item, "ignored"), eventId: target.id };
    const action = item.action;
    const patch: EventPatch = {};
    if (action === "update") {
      if (item.knownStart && item.time === undefined) return this.needsReview(item, ["complete_time"]);
      if (item.time && !((item.kind === "activity" && item.time.kind === "interval") || (item.kind === "deadline" && (item.time.kind === "date" || item.time.kind === "point")))) return this.needsReview(item, ["complete_time"]);
      if (item.kind !== target.kind && !(item.kind === "activity" && target.kind === "time_block")) return this.needsReview(item, ["kind_change"]);
      if (item.title !== target.title) patch.title = item.title;
      if (item.time !== undefined) patch.time = item.time;
      if (Object.keys(patch).length === 0) return { ...this.baseActivity(item, "existing"), eventId: target.id };
    }
    const previewArgs = action === "cancel"
      ? { targetId: target.id, expectedVersion: target.version, patch: { status: "cancelled" } }
      : { targetId: target.id, expectedVersion: target.version, patch };
    const overlaps = asOverlaps(this.tools.invoke("calendar.preview", previewArgs, {
      taskId: taskIdFor(input), source: { kind: "email", ref: input.sourceKey }, isActive: () => true
    }), this.calendar);
    const proposal = this.calendar.createProposal({
      operationKey: operationKey(input.emailId, item.key, action), action, targetId: target.id,
      expectedVersion: target.version, ...(action === "update" ? { patch } : {}), evidence: item.evidence
    });
    this.saveProposalPolicy(proposal.id, proposal.operationKey, input, target.id, target.version, action === "update", overlaps);
    return { ...this.baseActivity(item, "proposed"), eventId: target.id, proposalId: proposal.id, overlaps };
  }

  private baseActivity(item: ParsedActivity, status: EmailActivityAnalysis["status"]): EmailActivityAnalysis {
    return {
      key: item.key, title: item.title, kind: item.kind, action: item.action, evidence: item.evidence,
      ...(item.time ? { time: item.time } : {}), ...(item.knownStart ? { knownStart: item.knownStart } : {}),
      ...(item.externalEventId ? { externalEventId: item.externalEventId } : {}), status, overlaps: [], coverage: "unverified"
    };
  }

  private needsReview(item: ParsedActivity, missing: string[]): EmailActivityAnalysis {
    return { ...this.baseActivity(item, "needs_review"), missing };
  }

  private overlapsForTarget(target: CalendarEvent, input: EmailCalendarInput) {
    return asOverlaps(this.tools.invoke("calendar.preview", {
      targetId: target.id, expectedVersion: target.version, patch: { title: target.title }, requireFree: false
    }, { taskId: taskIdFor(input), source: { kind: "email", ref: input.sourceKey }, isActive: () => true }), this.calendar);
  }

  private attachEmailSource(target: CalendarEvent, item: ParsedActivity, input: EmailCalendarInput) {
    return this.calendar.attachSource(target.id, target.version, operationKey(input.emailId, item.key, "attach-source"), {
      kind: "email", ref: input.sourceKey
    });
  }

  private findDuplicate(title: string, time: CalendarTime) {
    return this.calendar.repository.listEvents(this.calendar.ownerId).find((event) => similarTitle(title, event.title) && sameTime(time, event.time));
  }

  private external(externalEventId: string): ExternalRow | undefined {
    const row = this.calendar.repository.db.prepare(`
      SELECT sender, emailId, sourceKey, eventId, candidateId FROM calendar_email_external
      WHERE ownerId = ? AND externalEventId = ?
    `).get(this.calendar.ownerId, externalEventId) as ExternalRow | undefined;
    return row;
  }

  private saveExternal(externalEventId: string, input: EmailCalendarInput, candidateId: string, eventId: string) {
    const sender = normalizeSender(input.fromAddress);
    const existing = this.external(externalEventId);
    if (existing) {
      if (existing.sender !== sender || existing.eventId !== eventId) throw new AnalysisInputError("external event identity conflicts");
      return;
    }
    this.calendar.repository.db.prepare(`
      INSERT INTO calendar_email_external
        (ownerId, externalEventId, sender, emailId, sourceKey, eventId, candidateId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.calendar.ownerId, externalEventId, sender, input.emailId, input.sourceKey, eventId, candidateId, new Date().toISOString());
  }

  private saveProposalPolicy(proposalId: string, operationId: string, input: EmailCalendarInput, targetId: string, expectedVersion: number, requireFree: boolean, overlaps: EmailCalendarOverlap[]) {
    const taskId = taskIdFor(input);
    const ruleDigest = digest({ requireFree, targetId, expectedVersion });
    this.calendar.repository.db.prepare(`
      INSERT INTO calendar_tool_proposal_policies
        (ownerId, proposalId, taskId, operationId, requireFree, candidateJson, targetId, expectedVersion, ruleDigest, overlapsJson, createdAt)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(this.calendar.ownerId, proposalId, taskId, operationId, requireFree ? 1 : 0, targetId, expectedVersion, ruleDigest, JSON.stringify(overlaps), new Date().toISOString());
  }

  private saveAnalysis(analysis: EmailCalendarAnalysis, input: EmailCalendarInput) {
    this.calendar.repository.db.prepare(`
      INSERT INTO calendar_email_analysis (ownerId, emailId, sourceKey, fromAddress, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.calendar.ownerId, analysis.emailId, input.sourceKey, normalizeSender(input.fromAddress), JSON.stringify(analysis), analysis.checkedAt, analysis.checkedAt);
  }

  private persistFailure(input: EmailCalendarInput, reason: string): EmailCalendarAnalysis {
    const existing = this.get(input.emailId);
    if (existing) return existing;
    const analysis: EmailCalendarAnalysis = {
      emailId: input.emailId, sourceKey: input.sourceKey, subject: input.subject, summaryZh: "", checkedAt: new Date().toISOString(), activities: [], status: "failed", reason: reason.slice(0, MAX_REASON)
    };
    try {
      return this.calendar.repository.withTransaction(() => {
        const replay = this.get(input.emailId);
        if (replay) return replay;
        this.saveAnalysis(analysis, input);
        return clone(analysis);
      });
    } catch (error) {
      const replay = this.get(input.emailId);
      if (replay) return replay;
      throw error;
    }
  }
}

export function renderEmailCalendarAnalysis(analysis: EmailCalendarAnalysis): string {
  const lines = [`邮件 ${analysis.emailId}：${analysis.status === "failed" ? "日程分析失败" : "日程分析完成"}`];
  if (analysis.status === "failed") {
    lines.push(`原因：${analysis.reason ?? "未知错误"}`);
    return lines.join("\n");
  }
  if (analysis.activities.length === 0) lines.push("未识别到可核对的日程。");
  for (const activity of analysis.activities) {
    const label = `${activity.title}（${activity.kind === "deadline" ? "截止" : "活动"}）`;
    if (activity.status === "needs_details") lines.push(`${label}：待补充 ${activity.missing?.join("、") ?? "时间"}。`);
    else if (activity.status === "needs_review") lines.push(`${label}：待核对，未自动匹配或修改已有安排。`);
    else if (activity.status === "ignored") lines.push(`${label}：已保留现有忽略决定。`);
    else if (activity.status === "proposed") lines.push(`${label}：已保存待确认变更提案。`);
    else if (activity.status === "existing") lines.push(`${label}：已匹配本模块已有邮件日程。`);
    else lines.push(`${label}：已生成可撤销的暂定日程。`);
    if (activity.overlaps.length) {
      for (const overlap of activity.overlaps) lines.push(`  冲突：${overlap.title}${overlap.status === "tentative" ? "（暂定）" : "（已确认）"}，${overlap.overlapStart}—${overlap.overlapEnd}，${overlap.overlapMinutes} 分钟。`);
    } else if (activity.status !== "needs_details" && activity.status !== "needs_review") {
      lines.push("  当前记录未发现重叠；完整课表未核对。");
    }
  }
  return lines.join("\n");
}
