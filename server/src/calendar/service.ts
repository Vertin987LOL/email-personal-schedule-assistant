import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import type {
  CalendarConflict,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventKind,
  CalendarEventStatus,
  CalendarListResult,
  CalendarProposalInput,
  CalendarProposalResult,
  CalendarReminder,
  CalendarResolveDecision,
  CalendarSource,
  CalendarServiceHooks,
  CalendarTime,
  ChangeProposal,
  EventCandidate,
  EventPatch
} from "./types";
import { CalendarRepository, type StoredOperation } from "./repository";

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 500;
const MAX_LOCATION_LENGTH = 500;
const MAX_EVIDENCE_LENGTH = 10_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION_KEY = /^[^\s]{1,200}$/;

export class CalendarError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "CalendarError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function payloadHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function stringValue(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new CalendarError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new CalendarError("INVALID_INPUT", `${field} is invalid`);
  }
  return value as T;
}

function ensureOperationKey(value: unknown) {
  if (typeof value !== "string" || !OPERATION_KEY.test(value)) {
    throw new CalendarError("INVALID_INPUT", "operationKey must be a non-empty key without spaces");
  }
  return value;
}

function validateTimeZone(timeZone: unknown) {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 100) {
    throw new CalendarError("INVALID_TIME", "timeZone must be an IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new CalendarError("INVALID_TIME", `Unknown timeZone: ${timeZone}`);
  }
  return timeZone;
}

function parseInstant(value: unknown, field: string) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new CalendarError("INVALID_TIME", `${field} must be an ISO 8601 instant with an explicit offset`);
  }
  let milliseconds: number;
  try {
    milliseconds = Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    throw new CalendarError("INVALID_TIME", `${field} is not a valid instant`);
  }
  return milliseconds;
}

function validateDate(value: unknown, field: string) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new CalendarError("INVALID_TIME", `${field} must be YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new CalendarError("INVALID_TIME", `${field} is not a valid date`);
  }
  return value;
}

function validateCalendarTime(value: unknown): CalendarTime {
  if (!value || typeof value !== "object") {
    throw new CalendarError("INVALID_TIME", "time is required");
  }
  const input = value as Record<string, unknown>;
  const kind = enumValue(input.kind, "time.kind", ["interval", "point", "date"] as const);
  const timeZone = validateTimeZone(input.timeZone);
  if (kind === "interval") {
    const startsAt = String(input.startsAt ?? "");
    const endsAt = String(input.endsAt ?? "");
    const startMs = parseInstant(startsAt, "time.startsAt");
    const endMs = parseInstant(endsAt, "time.endsAt");
    if (endMs <= startMs) {
      throw new CalendarError("INVALID_TIME", "time.endsAt must be after time.startsAt");
    }
    return { kind, startsAt, endsAt, timeZone };
  }
  if (kind === "point") {
    const at = String(input.at ?? "");
    parseInstant(at, "time.at");
    return { kind, at, timeZone };
  }
  return { kind, onDate: validateDate(input.onDate, "time.onDate"), timeZone };
}

function validateSource(value: unknown, field: string): CalendarSource {
  if (!value || typeof value !== "object") {
    throw new CalendarError("INVALID_INPUT", `${field} is invalid`);
  }
  const source = value as Record<string, unknown>;
  return {
    kind: enumValue(source.kind, `${field}.kind`, ["manual", "course", "email", "plan"] as const),
    ref: stringValue(source.ref, `${field}.ref`, 500)
  };
}

function validateSources(value: unknown): CalendarSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new CalendarError("INVALID_INPUT", "sources must contain at least one source");
  }
  const sources = value.map((source, index) => validateSource(source, `sources[${index}]`));
  const keys = new Set(sources.map((source) => `${source.kind}:${source.ref}`));
  if (keys.size !== sources.length) throw new CalendarError("INVALID_INPUT", "sources must be unique");
  return sources;
}

function validateReminder(value: unknown): CalendarReminder | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new CalendarError("INVALID_INPUT", "reminder is invalid");
  const reminder = value as Record<string, unknown>;
  if (typeof reminder.enabled !== "boolean") throw new CalendarError("INVALID_INPUT", "reminder.enabled is invalid");
  const result: CalendarReminder = { enabled: reminder.enabled };
  if (reminder.minutesBefore !== undefined) {
    if (typeof reminder.minutesBefore !== "number" || !Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0 || reminder.minutesBefore > 1_000_000) {
      throw new CalendarError("INVALID_INPUT", "reminder.minutesBefore is invalid");
    }
    result.minutesBefore = reminder.minutesBefore;
  }
  if (reminder.at !== undefined) {
    parseInstant(reminder.at, "reminder.at");
    result.at = reminder.at as string;
  }
  return result;
}

function validateEventInput(value: unknown): CalendarEventInput {
  if (!value || typeof value !== "object") throw new CalendarError("INVALID_INPUT", "event is required");
  const input = value as Record<string, unknown>;
  const result: CalendarEventInput = {
    title: stringValue(input.title, "title", MAX_TITLE_LENGTH),
    kind: enumValue(input.kind, "kind", ["course", "activity", "deadline", "time_block"] as const),
    time: validateCalendarTime(input.time),
    status: enumValue(input.status ?? "confirmed", "status", ["confirmed", "tentative", "cancelled", "ignored"] as const),
    sources: validateSources(input.sources)
  };
  if (input.location !== undefined) {
    if (typeof input.location !== "string" || input.location.length > MAX_LOCATION_LENGTH) {
      throw new CalendarError("INVALID_INPUT", "location is invalid");
    }
    result.location = input.location;
  }
  if (input.sourceEvidence !== undefined) {
    if (typeof input.sourceEvidence !== "string" || input.sourceEvidence.length > MAX_EVIDENCE_LENGTH) {
      throw new CalendarError("INVALID_INPUT", "sourceEvidence is invalid");
    }
    result.sourceEvidence = input.sourceEvidence;
  }
  if (input.seriesId !== undefined) result.seriesId = stringValue(input.seriesId, "seriesId", 500);
  result.reminder = validateReminder(input.reminder);
  return result;
}

function validatePatch(value: unknown): EventPatch {
  if (!value || typeof value !== "object") throw new CalendarError("INVALID_INPUT", "patch is required");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["title", "time", "location", "status", "reminder"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new CalendarError("INVALID_INPUT", `patch.${key} is not allowed`);
  }
  const patch: EventPatch = {};
  if ("title" in input) patch.title = stringValue(input.title, "patch.title", MAX_TITLE_LENGTH);
  if ("time" in input) patch.time = validateCalendarTime(input.time);
  if ("location" in input) {
    if (input.location !== null && (typeof input.location !== "string" || input.location.length > MAX_LOCATION_LENGTH)) {
      throw new CalendarError("INVALID_INPUT", "patch.location is invalid");
    }
    patch.location = input.location as string | undefined;
  }
  if ("status" in input) patch.status = enumValue(input.status, "patch.status", ["confirmed", "tentative", "cancelled", "ignored"] as const);
  if ("reminder" in input) patch.reminder = validateReminder(input.reminder);
  if (Object.keys(patch).length === 0) throw new CalendarError("INVALID_INPUT", "patch cannot be empty");
  return patch;
}

function timeStartMs(time: CalendarTime) {
  if (time.kind === "interval") return Date.parse(time.startsAt);
  if (time.kind === "point") return Date.parse(time.at);
  return dateEventRange(time)[0];
}

function dateEventRange(time: Extract<CalendarTime, { kind: "date" }>): [number, number] {
  const start = Temporal.PlainDate.from(time.onDate)
    .toZonedDateTime({ timeZone: time.timeZone, plainTime: "00:00" })
    .toInstant()
    .epochMilliseconds;
  const end = Temporal.PlainDate.from(time.onDate)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: time.timeZone, plainTime: "00:00" })
    .toInstant()
    .epochMilliseconds;
  return [start, end];
}

function timeInRange(time: CalendarTime, fromMs: number, toMs: number) {
  if (time.kind === "interval") return Date.parse(time.endsAt) > fromMs && Date.parse(time.startsAt) < toMs;
  if (time.kind === "point") return Date.parse(time.at) >= fromMs && Date.parse(time.at) < toMs;
  const [start, end] = dateEventRange(time);
  return end > fromMs && start < toMs;
}

function intervalConflict(a: CalendarEvent, b: CalendarEvent): boolean {
  if (a.status === "cancelled" || a.status === "ignored" || b.status === "cancelled" || b.status === "ignored") return false;
  if (a.time.kind !== "interval" || b.time.kind !== "interval") return false;
  return Date.parse(a.time.startsAt) < Date.parse(b.time.endsAt) && Date.parse(b.time.startsAt) < Date.parse(a.time.endsAt);
}

function applyPatch(event: CalendarEvent, patch: EventPatch): CalendarEvent {
  const updated = { ...event, ...patch, time: patch.time ?? event.time };
  if (patch.location === null) delete (updated as { location?: string }).location;
  if (patch.reminder === undefined && "reminder" in patch) delete (updated as { reminder?: CalendarReminder }).reminder;
  return updated;
}

function operationResult<T>(operation: StoredOperation): T {
  return JSON.parse(operation.resultJson) as T;
}

export class CalendarService {
  readonly repository: CalendarRepository;
  readonly ownerId: string;
  readonly hooks: CalendarServiceHooks;

  constructor(repositoryOrDatabase: CalendarRepository | CalendarRepository["db"], ownerId = "local-owner", hooks: CalendarServiceHooks = {}) {
    this.repository = repositoryOrDatabase instanceof CalendarRepository
      ? repositoryOrDatabase
      : new CalendarRepository(repositoryOrDatabase);
    this.ownerId = stringValue(ownerId, "ownerId", 200);
    this.hooks = hooks;
  }

  listEvents(from: string, to: string): CalendarListResult {
    const fromMs = parseInstant(from, "from");
    const toMs = parseInstant(to, "to");
    if (toMs <= fromMs) throw new CalendarError("INVALID_TIME", "to must be after from");
    if (toMs - fromMs > MAX_RANGE_MS) throw new CalendarError("INVALID_TIME", "calendar range cannot exceed 366 days");
    const events = this.repository.listEvents(this.ownerId)
      .filter((event) => timeInRange(event.time, fromMs, toMs))
      .sort((a, b) => timeStartMs(a.time) - timeStartMs(b.time) || a.id.localeCompare(b.id));
    const conflicts: CalendarConflict[] = [];
    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        if (intervalConflict(events[i], events[j])) {
          conflicts.push({ eventId: events[i].id, otherEventId: events[j].id, reason: "overlap" });
        }
      }
    }
    return { events, conflicts };
  }

  getEvent(id: string) {
    const event = this.repository.getEvent(this.ownerId, id);
    if (!event) throw new CalendarError("NOT_FOUND", "calendar event not found", 404);
    return event;
  }

  createEvent(operationKeyInput: unknown, rawEvent: unknown): CalendarEvent {
    const operationKey = ensureOperationKey(operationKeyInput);
    const eventInput = validateEventInput(rawEvent);
    const hash = payloadHash({ operationKey, event: eventInput });
    return this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, operationKey);
      if (existing) {
        this.assertOperation(existing, "event:create", hash);
        if (existing.resultId) return this.repository.getEvent(this.ownerId, existing.resultId) ?? operationResult<CalendarEvent>(existing);
        return operationResult<CalendarEvent>(existing);
      }
      const event: CalendarEvent = { id: randomUUID(), ownerId: this.ownerId, version: 1, ...clone(eventInput) };
      const now = nowIso();
      this.repository.insertEvent(event, now);
      this.repository.putOperation({
        ownerId: this.ownerId,
        operationKey,
        operationType: "event:create",
        payloadHash: hash,
        resultJson: JSON.stringify(event),
        resultId: event.id
      }, now);
      return event;
    });
  }

  updateEvent(id: string, expectedVersionInput: unknown, operationKeyInput: unknown, rawPatch: unknown): CalendarEvent {
    const operationKey = ensureOperationKey(operationKeyInput);
    const expectedVersion = this.expectedVersion(expectedVersionInput);
    const patch = validatePatch(rawPatch);
    const hash = payloadHash({ id, expectedVersion, patch });
    let invalidation: { previousVersion: number; currentVersion: number; eventId: string } | undefined;
    const event = this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, operationKey);
      if (existing) {
        this.assertOperation(existing, "event:update", hash);
        return operationResult<CalendarEvent>(existing);
      }
      const current = this.requireEvent(id);
      this.assertVersion(current, expectedVersion);
      if (current.status === "cancelled") throw new CalendarError("CONFLICT", "cancelled events remain tombstones", 409);
      const event = { ...applyPatch(current, patch), version: current.version + 1 };
      invalidation = { eventId: event.id, previousVersion: current.version, currentVersion: event.version };
      const now = nowIso();
      this.repository.updateEvent(event, now);
      this.repository.putOperation({
        ownerId: this.ownerId,
        operationKey,
        operationType: "event:update",
        payloadHash: hash,
        resultJson: JSON.stringify(event),
        resultId: event.id
      }, now);
      return event;
    });
    this.notifyReminderInvalidated(invalidation, "updated");
    return event;
  }

  attachSource(eventId: string, expectedVersionInput: unknown, operationKeyInput: unknown, rawSource: unknown): CalendarEvent {
    const operationKey = ensureOperationKey(operationKeyInput);
    const expectedVersion = this.expectedVersion(expectedVersionInput);
    const source = validateSource(rawSource, "source");
    const hash = payloadHash({ eventId, expectedVersion, source });
    return this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, operationKey);
      if (existing) {
        this.assertOperation(existing, "event:attach-source", hash);
        return operationResult<CalendarEvent>(existing);
      }
      const current = this.requireEvent(eventId);
      this.assertVersion(current, expectedVersion);
      const alreadyAttached = current.sources.some((item) => item.kind === source.kind && item.ref === source.ref);
      const event = alreadyAttached
        ? current
        : { ...current, sources: [...current.sources, source], version: current.version + 1 };
      const now = nowIso();
      if (event !== current) this.repository.updateEvent(event, now);
      this.repository.putOperation({
        ownerId: this.ownerId,
        operationKey,
        operationType: "event:attach-source",
        payloadHash: hash,
        resultJson: JSON.stringify(event),
        resultId: event.id
      }, now);
      return event;
    });
  }

  cancelEvent(id: string, expectedVersionInput: unknown, operationKeyInput: unknown): CalendarEvent {
    const operationKey = ensureOperationKey(operationKeyInput);
    const expectedVersion = this.expectedVersion(expectedVersionInput);
    const hash = payloadHash({ id, expectedVersion, action: "cancel" });
    let invalidation: { previousVersion: number; currentVersion: number; eventId: string } | undefined;
    const event = this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, operationKey);
      if (existing) {
        this.assertOperation(existing, "event:cancel", hash);
        return operationResult<CalendarEvent>(existing);
      }
      const current = this.requireEvent(id);
      this.assertVersion(current, expectedVersion);
      const event = current.status === "cancelled"
        ? current
        : { ...current, status: "cancelled" as const, version: current.version + 1 };
      if (event !== current) invalidation = { eventId: event.id, previousVersion: current.version, currentVersion: event.version };
      const now = nowIso();
      if (event !== current) this.repository.updateEvent(event, now);
      this.repository.putOperation({
        ownerId: this.ownerId,
        operationKey,
        operationType: "event:cancel",
        payloadHash: hash,
        resultJson: JSON.stringify(event),
        resultId: event.id
      }, now);
      return event;
    });
    this.notifyReminderInvalidated(invalidation, "cancelled");
    return event;
  }

  upsertCandidate(rawCandidate: unknown): EventCandidate {
    if (!rawCandidate || typeof rawCandidate !== "object") throw new CalendarError("INVALID_INPUT", "candidate is required");
    const input = rawCandidate as Record<string, unknown>;
    const id = stringValue(input.id, "candidate.id", 200);
    const source = validateSource(input.source, "candidate.source");
    const candidate: EventCandidate = {
      id,
      ownerId: this.ownerId,
      source,
      title: stringValue(input.title, "candidate.title", MAX_TITLE_LENGTH),
      evidence: stringValue(input.evidence, "candidate.evidence", MAX_EVIDENCE_LENGTH),
      state: enumValue(input.state ?? "ready", "candidate.state", ["needs_details", "ready", "ignored", "confirmed"] as const),
      missing: Array.isArray(input.missing) && input.missing.every((item) => typeof item === "string")
        ? input.missing.map(String)
        : []
    };
    if (input.kind !== undefined) candidate.kind = enumValue(input.kind, "candidate.kind", ["course", "activity", "deadline", "time_block"] as const);
    if (input.time !== undefined) candidate.time = validateCalendarTime(input.time);
    if (input.location !== undefined) candidate.location = stringValue(input.location, "candidate.location", MAX_LOCATION_LENGTH);
    return this.repository.withTransaction(() => {
      const current = this.repository.getCandidate(this.ownerId, id);
      if (current && (current.source.kind !== candidate.source.kind || current.source.ref !== candidate.source.ref)) {
        throw new CalendarError("IDEMPOTENCY_CONFLICT", "candidate identity already belongs to another source", 409);
      }
      // Replayed extraction cannot undo an explicit decision. Changes to a
      // linked event must go through a version-checked proposal instead.
      if (current?.state === "ignored" || current?.state === "confirmed") return current;
      if (candidate.state === "confirmed" && !current?.linkedEventId) {
        throw new CalendarError("INVALID_INPUT", "only candidate confirmation can set confirmed state");
      }
      // Linking a candidate to an event is an execution-side fact; callers cannot inject it.
      if (current?.linkedEventId) {
        candidate.linkedEventId = current.linkedEventId;
      }
      this.repository.saveCandidate(candidate, nowIso());
      return candidate;
    });
  }

  listCandidates(state?: EventCandidate["state"]) {
    if (state !== undefined) enumValue(state, "state", ["needs_details", "ready", "ignored", "confirmed"] as const);
    return this.repository.listCandidates(this.ownerId, state);
  }

  confirmCandidate(candidateId: string, operationKeyInput: unknown): { candidate: EventCandidate; event?: CalendarEvent } {
    const operationKey = ensureOperationKey(operationKeyInput);
    const candidate = this.repository.getCandidate(this.ownerId, candidateId);
    if (!candidate) throw new CalendarError("NOT_FOUND", "calendar candidate not found", 404);
    const hash = payloadHash({ candidateId, action: "confirm" });
    return this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, operationKey);
      if (existing) {
        this.assertOperation(existing, "candidate:confirm", hash);
        return operationResult<{ candidate: EventCandidate; event?: CalendarEvent }>(existing);
      }
      if (candidate.linkedEventId) {
        const event = this.repository.getEvent(this.ownerId, candidate.linkedEventId);
        if (!event) throw new CalendarError("STORAGE_FAILED", "candidate points to a missing event", 500);
        const result = { candidate, event };
        this.repository.putOperation({ ownerId: this.ownerId, operationKey, operationType: "candidate:confirm", payloadHash: hash, resultJson: JSON.stringify(result), resultId: event.id }, nowIso());
        return result;
      }
      if (!candidate.time) throw new CalendarError("NEEDS_DETAILS", "candidate needs a reliable date or time", 409, { missing: candidate.missing });
      const event: CalendarEvent = {
        id: randomUUID(),
        ownerId: this.ownerId,
        title: candidate.title,
        kind: candidate.kind ?? "activity",
        time: candidate.time,
        ...(candidate.location ? { location: candidate.location } : {}),
        status: "confirmed",
        sources: [candidate.source],
        sourceEvidence: candidate.evidence,
        version: 1
      };
      const updatedCandidate: EventCandidate = { ...candidate, state: "confirmed", linkedEventId: event.id };
      const now = nowIso();
      this.repository.insertEvent(event, now);
      this.repository.saveCandidate(updatedCandidate, now);
      const result = { candidate: updatedCandidate, event };
      this.repository.putOperation({ ownerId: this.ownerId, operationKey, operationType: "candidate:confirm", payloadHash: hash, resultJson: JSON.stringify(result), resultId: event.id }, now);
      return result;
    });
  }

  createProposal(rawInput: unknown): ChangeProposal {
    const input = this.validateProposalInput(rawInput);
    const hash = payloadHash(input);
    return this.repository.withTransaction(() => {
      const existing = this.repository.getOperation(this.ownerId, input.operationKey);
      if (existing) {
        this.assertOperation(existing, "proposal:create", hash);
        return operationResult<ChangeProposal>(existing);
      }
      const existingProposal = this.repository.getProposalByOperation(this.ownerId, input.operationKey);
      if (existingProposal) return existingProposal;
      if (input.action !== "create" && input.action !== "match" && input.action !== "plan") {
        if (!input.targetId) throw new CalendarError("INVALID_INPUT", "targetId is required for this proposal");
        this.requireEvent(input.targetId);
        if (input.expectedVersion === undefined) throw new CalendarError("INVALID_INPUT", "expectedVersion is required for this proposal");
      }
      const proposal: ChangeProposal = { id: randomUUID(), ownerId: this.ownerId, ...clone(input), state: "pending" };
      const now = nowIso();
      this.repository.saveProposal(proposal, now);
      this.repository.putOperation({ ownerId: this.ownerId, operationKey: input.operationKey, operationType: "proposal:create", payloadHash: hash, resultJson: JSON.stringify(proposal), resultId: proposal.id }, now);
      return proposal;
    });
  }

  listProposals(state?: ChangeProposal["state"]) {
    if (state !== undefined) enumValue(state, "state", ["pending", "applied", "rejected", "stale"] as const);
    return this.repository.listProposals(this.ownerId, state);
  }

  resolveProposal(proposalId: string, decisionInput: unknown, operationKeyInput: unknown, expectedVersionInput?: unknown): CalendarProposalResult {
    const decision = enumValue(decisionInput, "decision", ["approve", "reject"] as const) as CalendarResolveDecision;
    const operationKey = ensureOperationKey(operationKeyInput);
    const proposal = this.repository.getProposal(this.ownerId, proposalId);
    if (!proposal) throw new CalendarError("NOT_FOUND", "calendar proposal not found", 404);
    const suppliedVersion = expectedVersionInput === undefined ? undefined : this.expectedVersion(expectedVersionInput);
    if (suppliedVersion !== undefined && suppliedVersion !== proposal.expectedVersion) {
      throw new CalendarError("VERSION_CONFLICT", "resolve expectedVersion does not match the proposal", 409, { proposal });
    }
    const expectedVersion = proposal.expectedVersion;
    const hash = payloadHash({ proposalId, decision, expectedVersion });
    let staleProposal: ChangeProposal | undefined;
    let invalidation: { previousVersion: number; currentVersion: number; eventId: string } | undefined;
    const result = this.repository.withTransaction(() => {
      const existingOperation = this.repository.getOperation(this.ownerId, operationKey);
      if (existingOperation) {
        this.assertOperation(existingOperation, "proposal:resolve", hash);
        const resolved = operationResult<ChangeProposal>(existingOperation);
        return { proposal: resolved, event: resolved.resultEventId ? this.repository.getEvent(this.ownerId, resolved.resultEventId) : undefined };
      }
      const current = this.repository.getProposal(this.ownerId, proposalId);
      if (!current) throw new CalendarError("NOT_FOUND", "calendar proposal not found", 404);
      if (current.state !== "pending") {
        const resultAlready = { proposal: current, event: current.resultEventId ? this.repository.getEvent(this.ownerId, current.resultEventId) : undefined };
        this.repository.putOperation({ ownerId: this.ownerId, operationKey, operationType: "proposal:resolve", payloadHash: hash, resultJson: JSON.stringify(current), resultId: current.resultEventId }, nowIso());
        return resultAlready;
      }
      if (decision === "approve" && current.targetId && current.expectedVersion !== undefined) {
        const target = this.requireEvent(current.targetId);
        if (target.version !== (expectedVersion ?? current.expectedVersion)) {
          staleProposal = { ...current, state: "stale" };
          this.repository.saveProposal(staleProposal, nowIso());
          return { proposal: staleProposal, event: undefined };
        }
      }
      if (decision === "reject") {
        const rejected = { ...current, state: "rejected" as const };
        const now = nowIso();
        this.repository.saveProposal(rejected, now);
        this.repository.putOperation({ ownerId: this.ownerId, operationKey, operationType: "proposal:resolve", payloadHash: hash, resultJson: JSON.stringify(rejected) }, now);
        return { proposal: rejected, event: undefined };
      }
      let event: CalendarEvent | undefined;
      if (current.action === "create") {
        if (!current.event) throw new CalendarError("INVALID_INPUT", "create proposal has no event");
        event = { id: randomUUID(), ownerId: this.ownerId, version: 1, ...clone(validateEventInput(current.event)) };
        this.repository.insertEvent(event, nowIso());
      } else if (current.targetId && current.action === "update") {
        const target = this.requireEvent(current.targetId);
        if (target.status === "cancelled") throw new CalendarError("CONFLICT", "cancelled events remain tombstones", 409);
        event = { ...applyPatch(target, current.patch ?? {}), version: target.version + 1 };
        invalidation = { eventId: event.id, previousVersion: target.version, currentVersion: event.version };
        this.repository.updateEvent(event, nowIso());
      } else if (current.targetId && current.action === "cancel") {
        const target = this.requireEvent(current.targetId);
        event = target.status === "cancelled" ? target : { ...target, status: "cancelled" as const, version: target.version + 1 };
        if (event !== target) invalidation = { eventId: event.id, previousVersion: target.version, currentVersion: event.version };
        if (event !== target) this.repository.updateEvent(event, nowIso());
      }
      const applied: ChangeProposal = { ...current, state: "applied", ...(event ? { resultEventId: event.id } : {}) };
      const now = nowIso();
      this.repository.saveProposal(applied, now);
      this.repository.putOperation({ ownerId: this.ownerId, operationKey, operationType: "proposal:resolve", payloadHash: hash, resultJson: JSON.stringify(applied), resultId: event?.id }, now);
      return { proposal: applied, event };
    });
    if (staleProposal) {
      throw new CalendarError("VERSION_CONFLICT", "proposal is stale because the target version changed", 409, { proposal: staleProposal });
    }
    this.notifyReminderInvalidated(invalidation, result.proposal.action === "cancel" ? "cancelled" : "updated");
    return result;
  }

  private validateProposalInput(rawInput: unknown): CalendarProposalInput {
    if (!rawInput || typeof rawInput !== "object") throw new CalendarError("INVALID_INPUT", "proposal is required");
    const input = rawInput as Record<string, unknown>;
    const action = enumValue(input.action, "action", ["create", "update", "cancel", "match", "plan"] as const);
    if (action === "match" || action === "plan") {
      throw new CalendarError("INVALID_INPUT", `${action} proposals are not supported by M1`);
    }
    const result: CalendarProposalInput = {
      operationKey: ensureOperationKey(input.operationKey),
      action,
      evidence: stringValue(input.evidence, "evidence", MAX_EVIDENCE_LENGTH)
    };
    if (input.targetId !== undefined) result.targetId = stringValue(input.targetId, "targetId", 200);
    if (input.expectedVersion !== undefined) result.expectedVersion = this.expectedVersion(input.expectedVersion);
    if (input.candidateId !== undefined) result.candidateId = stringValue(input.candidateId, "candidateId", 200);
    if (input.patch !== undefined) result.patch = validatePatch(input.patch);
    if (input.event !== undefined) result.event = validateEventInput(input.event);
    if (action === "create" && !result.event) throw new CalendarError("INVALID_INPUT", "create proposal needs an event");
    if (action === "update" && !result.patch) throw new CalendarError("INVALID_INPUT", "update proposal needs patch");
    return result;
  }

  private expectedVersion(value: unknown) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new CalendarError("INVALID_INPUT", "expectedVersion must be a positive integer");
    return value;
  }

  private requireEvent(id: string) {
    const event = this.repository.getEvent(this.ownerId, id);
    if (!event) throw new CalendarError("NOT_FOUND", "calendar event not found", 404);
    return event;
  }

  private assertVersion(event: CalendarEvent, expectedVersion: number) {
    if (event.version !== expectedVersion) {
      throw new CalendarError("VERSION_CONFLICT", "event version is stale", 409, { current: event });
    }
  }

  private assertOperation(operation: StoredOperation, type: string, hash: string) {
    if (operation.operationType !== type || operation.payloadHash !== hash) {
      throw new CalendarError("IDEMPOTENCY_CONFLICT", "operationKey was already used with different content", 409);
    }
  }

  private notifyReminderInvalidated(
    change: { previousVersion: number; currentVersion: number; eventId: string } | undefined,
    reason: "updated" | "cancelled"
  ) {
    if (!change || !this.hooks.onReminderInvalidated) return;
    try {
      this.hooks.onReminderInvalidated({ ...change, reason });
    } catch {
      // A future reminder worker must not turn a committed calendar mutation into a failed request.
    }
  }
}

export function getCalendarEventStartMs(event: CalendarEvent) {
  return timeStartMs(event.time);
}
