import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Temporal } from "temporal-polyfill";
import { CalendarService } from "./service";
import type { CalendarEvent, CalendarEventInput, ChangeProposal } from "./types";
import type { CalendarTask } from "./agent-tasks";

export type CalendarDeliveryKind = "task" | "reminder";
export type CalendarDeliveryState = "pending" | "paused" | "sending" | "accepted" | "unknown" | "expired" | "invalidated";

/** Safe projection for the UI; recipient and dedupe keys never leave the outbox. */
export type CalendarDeliveryRecord = {
  id: string;
  kind: CalendarDeliveryKind;
  state: CalendarDeliveryState;
  eventId?: string;
  taskId?: string;
  fireAt?: string;
  text?: string;
  acceptedAt?: string;
  error?: string;
};

export type CalendarDeliveryProposal = ChangeProposal | { proposal: ChangeProposal; digest?: string };

export type CalendarDeliveryDependencies = {
  send: (recipient: string | undefined, text: string) => Promise<unknown>;
  now?: () => number | Date | string;
  isReady?: (recipient?: string) => boolean;
  taskRecipient?: (task: CalendarTask) => string | undefined;
};

type DeliveryRow = CalendarDeliveryRecord & {
  ownerId: string;
  dedupeKey: string;
  recipient?: string;
  createdAt: string;
  updatedAt: string;
};

type ReminderSchedule = { fireAt: string; fireAtMs: number; text: string; dedupeKey: string };

const MAX_BATCH = 5;
const MAX_OFFLINE_AGE_MS = 60 * 60 * 1000;
const MAX_TASK_TEXT_LENGTH = 20_000;
const MAX_PROPOSAL_PREVIEWS = 10;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function safeError() {
  // Transport errors can contain request headers or provider details. Keep the
  // durable status useful without persisting secrets in a UI-visible field.
  return "delivery failed";
}

function dateEndMs(event: CalendarEvent) {
  if (event.time.kind === "interval") return Date.parse(event.time.endsAt);
  if (event.time.kind === "point") return Date.parse(event.time.at);
  return Temporal.PlainDate.from(event.time.onDate)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: event.time.timeZone, plainTime: "00:00" })
    .toInstant().epochMilliseconds;
}

function reminderSchedule(event: CalendarEvent): ReminderSchedule | undefined {
  const reminder = event.reminder;
  if (!reminder?.enabled || event.status === "cancelled" || event.status === "ignored") return undefined;
  let fireAtMs: number;
  if (reminder.at !== undefined) fireAtMs = Date.parse(reminder.at);
  else if (event.time.kind === "interval") fireAtMs = Date.parse(event.time.startsAt);
  else if (event.time.kind === "point") fireAtMs = Date.parse(event.time.at);
  else return undefined;
  if (!Number.isFinite(fireAtMs)) return undefined;
  if (reminder.at === undefined) {
    const minutes = reminder.minutesBefore ?? 0;
    if (!Number.isInteger(minutes) || minutes < 0) return undefined;
    fireAtMs -= minutes * 60_000;
  }
  const fireAt = iso(fireAtMs);
  const text = reminderText(event);
  // Titles, locations, and source metadata may be corrected without creating
  // a second notification for the same scheduled instant. The text is
  // refreshed separately when this key already exists.
  const scheduleHash = hash({ eventId: event.id, fireAt, time: event.time, reminder });
  return { fireAt, fireAtMs, text, dedupeKey: `reminder:${event.id}:${scheduleHash}` };
}

function displayInstant(value: string, timeZone: string) {
  try {
    return Temporal.Instant.from(value).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ");
  } catch {
    return value;
  }
}

function compactText(value: string, maxLength = 240) {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function proposalTimeText(time: CalendarEvent["time"] | undefined) {
  if (!time) return "未设置";
  if (time.kind === "interval") return `${displayInstant(time.startsAt, time.timeZone)} 至 ${displayInstant(time.endsAt, time.timeZone)}`;
  if (time.kind === "point") return displayInstant(time.at, time.timeZone);
  return `${time.onDate}（全天，${time.timeZone}）`;
}

type ProposalEventDetails = {
  title?: string;
  time?: CalendarEvent["time"];
  location?: string;
};

function proposalEventDetails(value: CalendarEvent | CalendarEventInput | undefined): ProposalEventDetails | undefined {
  if (!value) return undefined;
  return { title: value.title, time: value.time, location: value.location };
}

function proposalPreview(calendar: CalendarService, ownerId: string, proposal: ChangeProposal) {
  const before = proposalEventDetails(
    proposal.targetId ? calendar.repository.getEvent(ownerId, proposal.targetId) : undefined,
  );
  const supplied = proposalEventDetails(proposal.event);
  const patch = proposal.patch ?? {};
  const after = proposal.action === "create"
    ? supplied
    : { ...(before ?? {}), ...(supplied ?? {}), ...patch } as ProposalEventDetails;
  const title = compactText(after?.title ?? before?.title ?? "未命名事项", 160);
  const action = proposal.action === "create"
    ? "新建"
    : proposal.action === "update"
      ? "更新"
      : proposal.action === "cancel"
        ? "取消"
        : proposal.action === "match"
          ? "匹配"
          : "规划";
  const locationBefore = before?.location ? compactText(before.location, 120) : "未设置";
  const locationAfter = after?.location ? compactText(after.location, 120) : "未设置";
  if (proposal.action === "cancel") {
    const location = after?.location ?? before?.location;
    return `取消「${title}」；取消时间：${proposalTimeText(before?.time ?? after?.time)}${location ? `；地点：${compactText(location, 120)}` : ""}`;
  }
  if (proposal.action === "create") {
    return `新建「${title}」；时间：${proposalTimeText(after?.time)}${after?.location ? `；地点：${compactText(after.location, 120)}` : ""}`;
  }
  const titleText = before?.title && after?.title && before.title !== after.title
    ? `标题：${compactText(before.title, 120)} → ${compactText(after.title, 120)}`
    : `事项：${title}`;
  const timeText = before?.time && after?.time
    ? `时间：${proposalTimeText(before.time)} → ${proposalTimeText(after.time)}`
    : `时间：${proposalTimeText(after?.time ?? before?.time)}`;
  const locationText = before?.location || after?.location
    ? locationBefore === locationAfter ? `地点：${locationAfter}` : `地点：${locationBefore} → ${locationAfter}`
    : "";
  return [action, titleText, timeText, locationText].filter(Boolean).join("；");
}

function reminderText(event: CalendarEvent) {
  const time = event.time.kind === "interval"
    ? `${displayInstant(event.time.startsAt, event.time.timeZone)} 至 ${displayInstant(event.time.endsAt, event.time.timeZone)}`
    : event.time.kind === "point"
      ? `截止 ${displayInstant(event.time.at, event.time.timeZone)}`
      : `${event.time.onDate}（全天，${event.time.timeZone}）`;
  const location = event.location ?? "未提供";
  const source = event.sources.map(item => `${item.kind}:${item.ref}`).join(", ");
  const status = event.status === "tentative" ? "暂定" : "已确认";
  return `日程提醒：${event.title}\n时间：${time}\n地点：${location}\n来源：${source}\n状态：${status}`;
}

function proposalValue(value: CalendarDeliveryProposal): { proposal: ChangeProposal; digest: string } | undefined {
  const wrapped = value && typeof value === "object" && "proposal" in value;
  const proposal = (wrapped ? (value as { proposal?: ChangeProposal }).proposal : value) as ChangeProposal | undefined;
  if (!proposal || typeof proposal.id !== "string") return undefined;
  const supplied = wrapped ? (value as { digest?: unknown }).digest : undefined;
  const digest = typeof supplied === "string" && supplied.length >= 12 ? supplied : hash(Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== "state" && key !== "resultEventId")));
  return { proposal, digest };
}

function taskResultText(task: CalendarTask) {
  const result = task.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string") return (result as { text: string }).text;
  if (result === undefined) return undefined;
  try { return JSON.stringify(result); } catch { return undefined; }
}

export class CalendarDeliveryService {
  private readonly db: DatabaseSync;
  private readonly ownerId: string;
  private tickPromise?: Promise<CalendarDeliveryRecord[]>;

  constructor(private readonly calendar: CalendarService, private readonly dependencies: CalendarDeliveryDependencies) {
    this.db = calendar.repository.db;
    this.ownerId = calendar.ownerId;
    this.ensureSchema();
    this.recoverSending();
  }

  private nowMs() {
    const value = this.dependencies.now?.() ?? Date.now();
    const milliseconds = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
    if (!Number.isFinite(milliseconds)) throw new Error("delivery clock is invalid");
    return Math.floor(milliseconds);
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_delivery_outbox (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        taskId TEXT,
        eventId TEXT,
        dedupeKey TEXT NOT NULL,
        recipient TEXT,
        fireAt TEXT,
        text TEXT NOT NULL,
        acceptedAt TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, id),
        UNIQUE (ownerId, dedupeKey)
      );
      CREATE INDEX IF NOT EXISTS calendar_delivery_outbox_owner_state
        ON calendar_delivery_outbox (ownerId, state, kind, fireAt, createdAt);
    `);
  }

  private recoverSending() {
    const now = iso(this.nowMs());
    this.db.prepare(`
      UPDATE calendar_delivery_outbox
      SET state = 'unknown', error = 'delivery interrupted before completion', updatedAt = ?
      WHERE ownerId = ? AND state = 'sending'
    `).run(now, this.ownerId);
  }

  private row(row: Record<string, unknown>): DeliveryRow {
    return {
      id: String(row.id),
      kind: String(row.kind) as CalendarDeliveryKind,
      state: String(row.state) as CalendarDeliveryState,
      ...(row.eventId == null ? {} : { eventId: String(row.eventId) }),
      ...(row.taskId == null ? {} : { taskId: String(row.taskId) }),
      ...(row.fireAt == null ? {} : { fireAt: String(row.fireAt) }),
      ...(row.text == null ? {} : { text: String(row.text) }),
      ...(row.acceptedAt == null ? {} : { acceptedAt: String(row.acceptedAt) }),
      ...(row.error == null ? {} : { error: String(row.error) }),
      ownerId: String(row.ownerId),
      dedupeKey: String(row.dedupeKey),
      ...(row.recipient == null ? {} : { recipient: String(row.recipient) }),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private publicRow(row: DeliveryRow): CalendarDeliveryRecord {
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
      ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
      ...(row.fireAt === undefined ? {} : { fireAt: row.fireAt }),
      ...(row.text === undefined ? {} : { text: row.text }),
      ...(row.acceptedAt === undefined ? {} : { acceptedAt: row.acceptedAt }),
      ...(row.error === undefined ? {} : { error: row.error }),
    };
  }

  list(): CalendarDeliveryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? ORDER BY createdAt ASC, id ASC
    `).all(this.ownerId) as Record<string, unknown>[];
    return rows.map(row => this.publicRow(this.row(row)));
  }

  private findByKey(dedupeKey: string) {
    const row = this.db.prepare("SELECT * FROM calendar_delivery_outbox WHERE ownerId = ? AND dedupeKey = ?").get(this.ownerId, dedupeKey) as Record<string, unknown> | undefined;
    return row ? this.row(row) : undefined;
  }

  private insert(input: { kind: CalendarDeliveryKind; dedupeKey: string; text: string; recipient?: string; taskId?: string; eventId?: string; fireAt?: string }) {
    const existing = this.findByKey(input.dedupeKey);
    if (existing) {
      if (input.kind === "reminder" && existing.state !== "accepted" && existing.state !== "unknown") {
        const now = iso(this.nowMs());
        const nextState = existing.state === "invalidated" ? "pending" : existing.state;
        this.db.prepare(`
          UPDATE calendar_delivery_outbox SET state = ?, text = ?, error = NULL, updatedAt = ?
          WHERE ownerId = ? AND id = ?
        `).run(nextState, input.text, now, this.ownerId, existing.id);
        existing.state = nextState;
        existing.text = input.text;
        existing.error = undefined;
        existing.updatedAt = now;
      }
      return existing;
    }
    const now = iso(this.nowMs());
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO calendar_delivery_outbox
        (ownerId, id, kind, state, taskId, eventId, dedupeKey, recipient, fireAt, text, createdAt, updatedAt)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.ownerId, id, input.kind, input.taskId ?? null, input.eventId ?? null, input.dedupeKey, input.recipient ?? null, input.fireAt ?? null, input.text, now, now);
    return this.row(this.db.prepare("SELECT * FROM calendar_delivery_outbox WHERE ownerId = ? AND id = ?").get(this.ownerId, id) as Record<string, unknown>);
  }

  private update(row: DeliveryRow, state: CalendarDeliveryState, patch: { error?: string | null; acceptedAt?: string | null } = {}) {
    const now = iso(this.nowMs());
    this.db.prepare(`
      UPDATE calendar_delivery_outbox
      SET state = ?, error = ?, acceptedAt = ?, updatedAt = ?
      WHERE ownerId = ? AND id = ?
    `).run(state, patch.error === undefined ? row.error ?? null : patch.error, patch.acceptedAt === undefined ? row.acceptedAt ?? null : patch.acceptedAt, now, this.ownerId, row.id);
    row.state = state;
    row.error = patch.error === null ? undefined : patch.error === undefined ? row.error : patch.error;
    row.acceptedAt = patch.acceptedAt === null ? undefined : patch.acceptedAt === undefined ? row.acceptedAt : patch.acceptedAt;
    row.updatedAt = now;
    return row;
  }

  private invalidateEventRows(eventId: string, currentKey?: string) {
    const rows = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? AND kind = 'reminder' AND eventId = ? AND state IN ('pending', 'paused')
    `).all(this.ownerId, eventId) as Record<string, unknown>[];
    for (const raw of rows) {
      const row = this.row(raw);
      if (currentKey !== undefined && row.dedupeKey === currentKey) continue;
      this.update(row, "invalidated", { error: "event reminder superseded" });
    }
  }

  /** Reconcile reminder schedules without sending. Existing accepted records are retained. */
  syncReminders() {
    const events = this.calendar.repository.listEvents(this.ownerId);
    const liveEventIds = new Set<string>();
    for (const event of events) {
      const schedule = reminderSchedule(event);
      if (!schedule) {
        this.invalidateEventRows(event.id);
        continue;
      }
      liveEventIds.add(event.id);
      this.invalidateEventRows(event.id, schedule.dedupeKey);
      this.insert({ kind: "reminder", eventId: event.id, dedupeKey: schedule.dedupeKey, fireAt: schedule.fireAt, text: schedule.text });
    }
    const pending = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? AND kind = 'reminder' AND state IN ('pending', 'paused')
    `).all(this.ownerId) as Record<string, unknown>[];
    for (const raw of pending) {
      const row = this.row(raw);
      if (!row.eventId || !liveEventIds.has(row.eventId)) this.update(row, "invalidated", { error: "event reminder no longer exists" });
    }
    return this.list();
  }

  private readTask(taskId: string): { available: true; task?: CalendarTask } | { available: false } {
    try {
      const row = this.db.prepare(`
        SELECT id, ownerId, sourceKey, sourceKind, sourceRef, text, inputsJson, state,
          threadId, turnId, result, error, question, proposalIdsJson, createdAt, updatedAt
        FROM calendar_agent_tasks WHERE ownerId = ? AND id = ?
      `).get(this.ownerId, taskId) as Record<string, unknown> | undefined;
      if (!row) return { available: true };
      const parse = (value: unknown, fallback: unknown) => value == null ? fallback : JSON.parse(String(value));
      return { available: true, task: {
        id: String(row.id), ownerId: String(row.ownerId), sourceKey: String(row.sourceKey),
        sourceKind: String(row.sourceKind) as CalendarTask["sourceKind"],
        ...(row.sourceRef == null ? {} : { sourceRef: String(row.sourceRef) }),
        text: String(row.text), inputs: parse(row.inputsJson, []) as CalendarTask["inputs"],
        state: String(row.state) as CalendarTask["state"],
        ...(row.threadId == null ? {} : { threadId: String(row.threadId) }),
        ...(row.turnId == null ? {} : { turnId: String(row.turnId) }),
        ...(row.result == null ? {} : { result: parse(row.result, undefined) }),
        ...(row.error == null ? {} : { error: String(row.error) }),
        ...(row.question == null ? {} : { question: String(row.question) }),
        proposalIds: parse(row.proposalIdsJson, []) as string[],
        createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
      } };
    } catch {
      return { available: false };
    }
  }

  private taskRowIsCurrent(row: DeliveryRow) {
    if (!row.taskId) return false;
    const stored = this.readTask(row.taskId);
    if (!stored.available || !stored.task || stored.task.sourceKind !== "wechat" || !this.dependencies.taskRecipient) return false;
    const current = stored.task;
    let recipient: string | undefined;
    try { recipient = this.dependencies.taskRecipient(current); } catch { return false; }
    const text = recipient ? this.taskText(current) : undefined;
    return Boolean(recipient && text && row.dedupeKey === this.taskKey(current, recipient, text));
  }

  private taskExpired(row: DeliveryRow, nowMs: number) {
    if (!row.taskId) return false;
    const stored = this.readTask(row.taskId);
    if (!stored.available || !stored.task) return false;
    const updatedAtMs = Date.parse(stored.task.updatedAt);
    return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > MAX_OFFLINE_AGE_MS;
  }

  private taskProposals(task: CalendarTask, proposals?: CalendarDeliveryProposal[]) {
    const values = proposals ?? task.proposalIds.map(id => this.calendar.repository.getProposal(this.ownerId, id)).filter((value): value is ChangeProposal => Boolean(value));
    const result: Array<{ proposal: ChangeProposal; digest: string }> = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = proposalValue(value);
      if (!normalized || normalized.proposal.state !== "pending" || seen.has(normalized.proposal.id)) continue;
      seen.add(normalized.proposal.id);
      result.push(normalized);
    }
    return result;
  }

  private taskText(task: CalendarTask, proposals?: CalendarDeliveryProposal[]) {
    if (!new Set<CalendarTask["state"]>([
      "needs_input", "awaiting_confirmation", "succeeded", "failed", "cancelled", "interrupted",
    ]).has(task.state)) return undefined;
    const parts: string[] = [];
    const result = taskResultText(task);
    if (result) parts.push(result);
    if (task.state === "needs_input" && task.question) {
      parts.push(`需要补充信息：${task.question}`);
      parts.push(`补充 ${task.id} 内容：${task.question}`);
    }
    if (task.state === "failed" || task.state === "cancelled" || task.state === "interrupted") {
      parts.push(`任务${task.state === "failed" ? "失败" : task.state === "cancelled" ? "已取消" : "已中断"}：${task.error ?? "未提供原因"}`);
    }
    if (task.state === "succeeded" && !result && !task.question) parts.push("任务已完成。");
    const pending = this.taskProposals(task, proposals);
    const proposalParts: string[] = [];
    for (const { proposal, digest } of pending.slice(0, MAX_PROPOSAL_PREVIEWS)) {
      const shortDigest = digest.slice(0, 12);
      proposalParts.push(`待确认变更：${proposalPreview(this.calendar, this.ownerId, proposal)}`);
      proposalParts.push(`确认命令：确认 ${task.id} ${proposal.id} ${shortDigest}`);
      proposalParts.push(`拒绝命令：拒绝 ${task.id} ${proposal.id} ${shortDigest}`);
    }
    if (pending.length > MAX_PROPOSAL_PREVIEWS) {
      proposalParts.push(`其余 ${pending.length - MAX_PROPOSAL_PREVIEWS} 项请在网页中查看。`);
    }
    const proposalText = proposalParts.join("\n");
    const prefixText = parts.join("\n");
    if (!proposalText) return prefixText.slice(0, MAX_TASK_TEXT_LENGTH) || undefined;
    const prefixLimit = Math.max(0, MAX_TASK_TEXT_LENGTH - proposalText.length - 1);
    const prefix = prefixText.slice(0, prefixLimit);
    return `${prefix}${prefix ? "\n" : ""}${proposalText}` || undefined;
  }

  private taskKey(task: CalendarTask, recipient: string, text: string) {
    return `task:${task.id}:${hash({ recipient, text, state: task.state, threadId: task.threadId, turnId: task.turnId, textInput: task.text, inputs: task.inputs })}`;
  }

  /** Enqueue one bound WeChat task result; email and unbound tasks are ignored. */
  enqueueTask(task: CalendarTask, proposals?: CalendarDeliveryProposal[]) {
    if (task.sourceKind !== "wechat" || !this.dependencies.taskRecipient) return undefined;
    let recipient: string | undefined;
    try { recipient = this.dependencies.taskRecipient(task); } catch { return undefined; }
    if (!recipient) return undefined;
    const text = this.taskText(task, proposals);
    if (!text) return undefined;
    const dedupeKey = this.taskKey(task, recipient, text);
    return this.publicRow(this.insert({ kind: "task", taskId: task.id, recipient, dedupeKey, text }));
  }

  private reminderStatus(row: DeliveryRow, nowMs: number): "invalidated" | "expired" | "future" | "due" {
    if (!row.eventId || !row.fireAt) return "invalidated";
    const event = this.calendar.repository.getEvent(this.ownerId, row.eventId);
    const schedule = event ? reminderSchedule(event) : undefined;
    if (!event || !schedule || schedule.dedupeKey !== row.dedupeKey) return "invalidated";
    const fireAtMs = Date.parse(row.fireAt);
    if (!Number.isFinite(fireAtMs)) return "invalidated";
    const eventEnded = event.time.kind === "interval" || event.time.kind === "date"
      ? dateEndMs(event) <= nowMs
      : false;
    if (eventEnded || nowMs - fireAtMs > MAX_OFFLINE_AGE_MS) return "expired";
    return fireAtMs > nowMs ? "future" : "due";
  }

  private ready(recipient?: string) {
    if (!this.dependencies.isReady) return true;
    try { return this.dependencies.isReady(recipient); } catch { return false; }
  }

  private async tickInternal() {
    const nowMs = this.nowMs();
    const now = iso(nowMs);
    this.syncReminders();
    const taskRows = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? AND kind = 'task' AND state IN ('pending', 'paused')
    `).all(this.ownerId) as Record<string, unknown>[];
    for (const raw of taskRows) {
      const row = this.row(raw);
      if (!this.taskRowIsCurrent(row)) this.update(row, "invalidated", { error: "task result superseded" });
      else {
        if (this.taskExpired(row, nowMs)) {
          this.update(row, "expired", { error: "task is too old" });
        }
      }
    }
    // Validate future schedules too: an explicit reminder time may outlive a
    // point/date event, and that stale row must not sit pending until its time.
    const reminderRows = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? AND kind = 'reminder' AND state IN ('pending', 'paused')
    `).all(this.ownerId) as Record<string, unknown>[];
    for (const raw of reminderRows) {
      const row = this.row(raw);
      const status = this.reminderStatus(row, nowMs);
      if (status === "invalidated" || status === "expired") {
        this.update(row, status, { error: status === "expired" ? "reminder is too old" : "event reminder superseded" });
      }
    }
    const rows = this.db.prepare(`
      SELECT * FROM calendar_delivery_outbox
      WHERE ownerId = ? AND state IN ('pending', 'paused')
        AND (kind = 'task' OR (kind = 'reminder' AND fireAt IS NOT NULL AND fireAt <= ?))
      ORDER BY CASE WHEN kind = 'reminder' THEN fireAt ELSE createdAt END ASC, createdAt ASC, id ASC
    `).all(this.ownerId, now) as Record<string, unknown>[];
    let sentCount = 0;
    for (const raw of rows) {
      const row = this.row(raw);
      if (row.kind === "reminder") {
        const status = this.reminderStatus(row, nowMs);
        if (status === "invalidated" || status === "expired") {
          this.update(row, status, { error: status === "expired" ? "reminder is too old" : "event reminder superseded" });
          continue;
        }
        if (status === "future") continue;
      }
      if (!this.ready(row.recipient)) {
        this.update(row, "paused");
        continue;
      }
      if (row.state === "paused") {
        this.update(row, "pending");
        continue;
      }
      if (row.kind === "reminder") {
        const status = this.reminderStatus(row, this.nowMs());
        if (status !== "due") {
          if (status === "invalidated" || status === "expired") this.update(row, status, { error: status === "expired" ? "reminder is too old" : "event reminder superseded" });
          continue;
        }
      }
      if (row.kind === "task" && !this.taskRowIsCurrent(row)) {
        this.update(row, "invalidated", { error: "task result superseded" });
        continue;
      }
      if (row.kind === "task") {
        if (this.taskExpired(row, nowMs)) {
          this.update(row, "expired", { error: "task is too old" });
          continue;
        }
      }
      if (sentCount >= MAX_BATCH) continue;
      this.update(row, "sending", { error: null });
      sentCount++;
      try {
        await this.dependencies.send(row.recipient, row.text ?? "");
        this.update(row, "accepted", { error: null, acceptedAt: iso(this.nowMs()) });
      } catch {
        this.update(row, "unknown", { error: safeError() });
      }
    }
    return this.list();
  }

  /** Process at most five due entries, serially; concurrent calls share one run. */
  async tick() {
    if (!this.tickPromise) {
      this.tickPromise = this.tickInternal().finally(() => { this.tickPromise = undefined; });
    }
    return this.tickPromise;
  }
}
