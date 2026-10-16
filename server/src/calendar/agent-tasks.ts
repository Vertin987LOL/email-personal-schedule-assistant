import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CalendarTaskState =
  | "queued"
  | "running"
  | "needs_input"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type CalendarTaskSourceKind = "manual" | "wechat" | "email";

export type CalendarTaskInput = {
  inputKey: string;
  text: string;
  at: string;
};

export type CalendarTask = {
  id: string;
  ownerId: string;
  sourceKey: string;
  sourceKind: CalendarTaskSourceKind;
  sourceRef?: string;
  text: string;
  inputs: CalendarTaskInput[];
  state: CalendarTaskState;
  threadId?: string;
  turnId?: string;
  result?: unknown;
  error?: string;
  question?: string;
  proposalIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CalendarTaskCreateInput = {
  sourceKey: string;
  sourceKind: CalendarTaskSourceKind;
  sourceRef?: string;
  text: string;
};

export type CalendarTaskUpdatePatch = Partial<Pick<
  CalendarTask,
  "state" | "threadId" | "turnId" | "result" | "error" | "question" | "proposalIds"
>>;

export type CalendarTaskInputAdd = {
  inputKey: string;
  text: string;
};

export const DEFAULT_TASK_OWNER_ID = "local-owner";
export const MAX_TASK_LIST_LIMIT = 100;
export const MAX_TASK_KEY_LENGTH = 512;
export const MAX_TASK_TEXT_LENGTH = 100_000;
export const MAX_TASK_FIELD_LENGTH = 20_000;
export const MAX_TASK_INPUT_COUNT = 50;
export const MAX_TASK_INPUT_TOTAL_LENGTH = 200_000;

export function wechatTaskSourceRef(botId: string, senderId: string) {
  const bot = requireIdentityPart(botId, "botId");
  const sender = requireIdentityPart(senderId, "senderId");
  return `wechat:${bot}:${sender}`;
}

/** Stable per-binding namespace for message source keys and input keys. */
export function wechatTaskKey(botId: string, senderId: string, messageId: string) {
  const bot = requireIdentityPart(botId, "botId");
  const sender = requireIdentityPart(senderId, "senderId");
  const message = requireIdentityPart(messageId, "messageId");
  const digest = createHash("sha256")
    .update(JSON.stringify([bot, sender, message]))
    .digest("hex");
  return `wechat:${digest}`;
}

export function parseWechatTaskSourceRef(sourceRef: string) {
  const match = /^wechat:([^:]+):(.+)$/u.exec(sourceRef);
  if (!match) return undefined;
  return { botId: match[1], senderId: match[2] };
}

export class CalendarTaskError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "SOURCE_KEY_CONFLICT"
      | "INPUT_KEY_CONFLICT"
      | "OWNER_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "CalendarTaskError";
  }
}

type SqlRow = Record<string, unknown>;

const taskStates = new Set<CalendarTaskState>([
  "queued",
  "running",
  "needs_input",
  "awaiting_confirmation",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unknown"
]);

const taskSourceKinds = new Set<CalendarTaskSourceKind>(["manual", "wechat", "email"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") throw new CalendarTaskError("INVALID_INPUT", `${field} must be a string`);
  if (!value.trim()) throw new CalendarTaskError("INVALID_INPUT", `${field} must not be empty`);
  if (value.length > maxLength) throw new CalendarTaskError("INVALID_INPUT", `${field} is too long`);
  return value;
}

function optionalText(value: unknown, field: string, maxLength = MAX_TASK_FIELD_LENGTH) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CalendarTaskError("INVALID_INPUT", `${field} must be a string`);
  if (value.length > maxLength) throw new CalendarTaskError("INVALID_INPUT", `${field} is too long`);
  return value || undefined;
}

function requireIdentityPart(value: unknown, field: string) {
  const text = requireText(value, field, MAX_TASK_KEY_LENGTH).trim();
  if (text.includes("\u0000")) throw new CalendarTaskError("INVALID_INPUT", `${field} contains an invalid character`);
  return text;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new CalendarTaskError("INVALID_INPUT", `unsupported task field: ${key}`);
  }
}

function now() {
  return new Date().toISOString();
}

function parseJsonArray<T>(value: unknown, field: string): T[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed as T[];
  } catch {
    throw new CalendarTaskError("INVALID_INPUT", `stored ${field} is invalid`);
  }
}

function parseJsonValue(value: unknown) {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return String(value);
  }
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new CalendarTaskError("INVALID_INPUT", "result must be JSON serializable");
  }
}

function rowToTask(row: SqlRow): CalendarTask {
  const sourceRef = row.sourceRef == null ? undefined : String(row.sourceRef);
  const task: CalendarTask = {
    id: String(row.id),
    ownerId: String(row.ownerId),
    sourceKey: String(row.sourceKey),
    sourceKind: String(row.sourceKind) as CalendarTaskSourceKind,
    ...(sourceRef ? { sourceRef } : {}),
    text: String(row.text),
    inputs: parseJsonArray<CalendarTaskInput>(row.inputsJson, "inputs"),
    state: String(row.state) as CalendarTaskState,
    ...(row.threadId == null ? {} : { threadId: String(row.threadId) }),
    ...(row.turnId == null ? {} : { turnId: String(row.turnId) }),
    ...(row.result == null ? {} : { result: parseJsonValue(row.result) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    ...(row.question == null ? {} : { question: String(row.question) }),
    proposalIds: parseJsonArray<string>(row.proposalIdsJson, "proposalIds"),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
  return cloneTask(task);
}

function cloneTask(task: CalendarTask): CalendarTask {
  return {
    ...task,
    ...(task.result === undefined ? {} : { result: cloneJsonValue(task.result) }),
    inputs: task.inputs.map((input) => ({ ...input })),
    proposalIds: [...task.proposalIds]
  };
}

function taskContentMatches(task: CalendarTask, input: CalendarTaskCreateInput) {
  return task.sourceKind === input.sourceKind
    && task.sourceRef === input.sourceRef
    && task.text === input.text;
}

export class CalendarTaskStore {
  readonly db: DatabaseSync;
  readonly ownerId: string;

  constructor(db: DatabaseSync, ownerId = DEFAULT_TASK_OWNER_ID) {
    this.db = db;
    this.ownerId = requireIdentityPart(ownerId, "ownerId");
    this.ensureSchema();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_agent_tasks (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        sourceKey TEXT NOT NULL,
        sourceKind TEXT NOT NULL,
        sourceRef TEXT,
        text TEXT NOT NULL,
        inputsJson TEXT NOT NULL,
        state TEXT NOT NULL,
        threadId TEXT,
        turnId TEXT,
        result TEXT,
        error TEXT,
        question TEXT,
        proposalIdsJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, id),
        UNIQUE (ownerId, sourceKey)
      );
      CREATE INDEX IF NOT EXISTS calendar_agent_tasks_owner_state
        ON calendar_agent_tasks (ownerId, state, updatedAt);
    `);
  }

  private withTransaction<T>(work: () => T): T {
    const nested = this.db.isTransaction;
    const savepoint = `agent_tasks_${randomUUID().replace(/-/g, "")}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      } catch {
        // Keep the original failure; rollback is best effort after SQLite errors.
      }
      throw error;
    }
  }

  private getInternal(id: string) {
    const row = this.db.prepare(
      "SELECT * FROM calendar_agent_tasks WHERE ownerId = ? AND id = ?"
    ).get(this.ownerId, id) as SqlRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  private writeTask(task: CalendarTask) {
    this.db.prepare(`
      UPDATE calendar_agent_tasks SET
        sourceKind = ?, sourceRef = ?, text = ?, inputsJson = ?, state = ?,
        threadId = ?, turnId = ?, result = ?, error = ?, question = ?,
        proposalIdsJson = ?, updatedAt = ?
      WHERE ownerId = ? AND id = ?
    `).run(
      task.sourceKind,
      task.sourceRef ?? null,
      task.text,
      JSON.stringify(task.inputs),
      task.state,
      task.threadId ?? null,
      task.turnId ?? null,
      task.result === undefined ? null : JSON.stringify(task.result),
      task.error ?? null,
      task.question ?? null,
      JSON.stringify(task.proposalIds),
      task.updatedAt,
      this.ownerId,
      task.id
    );
  }

  create(input: CalendarTaskCreateInput): CalendarTask {
    if (!isRecord(input)) throw new CalendarTaskError("INVALID_INPUT", "task input must be an object");
    rejectUnknownKeys(input, ["sourceKey", "sourceKind", "sourceRef", "text"]);
    const sourceKey = requireIdentityPart(input.sourceKey, "sourceKey");
    if (!taskSourceKinds.has(input.sourceKind)) {
      throw new CalendarTaskError("INVALID_INPUT", "sourceKind must be manual, wechat, or email");
    }
    const sourceRef = input.sourceRef === undefined ? undefined : requireIdentityPart(input.sourceRef, "sourceRef");
    const text = requireText(input.text, "text", MAX_TASK_TEXT_LENGTH);

    return this.withTransaction(() => {
      const existingRow = this.db.prepare(
        "SELECT * FROM calendar_agent_tasks WHERE ownerId = ? AND sourceKey = ?"
      ).get(this.ownerId, sourceKey) as SqlRow | undefined;
      if (existingRow) {
        const existing = rowToTask(existingRow);
        const normalized = { sourceKey, sourceKind: input.sourceKind, sourceRef, text };
        if (!taskContentMatches(existing, normalized)) {
          throw new CalendarTaskError("SOURCE_KEY_CONFLICT", "sourceKey already belongs to different task content");
        }
        return existing;
      }

      const timestamp = now();
      const task: CalendarTask = {
        id: randomUUID(),
        ownerId: this.ownerId,
        sourceKey,
        sourceKind: input.sourceKind,
        ...(sourceRef ? { sourceRef } : {}),
        text,
        inputs: [],
        state: "queued",
        proposalIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.db.prepare(`
        INSERT INTO calendar_agent_tasks (
          ownerId, id, sourceKey, sourceKind, sourceRef, text, inputsJson, state,
          proposalIdsJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.ownerId,
        task.id,
        task.sourceKey,
        task.sourceKind,
        task.sourceRef ?? null,
        task.text,
        JSON.stringify(task.inputs),
        task.state,
        JSON.stringify(task.proposalIds),
        task.createdAt,
        task.updatedAt
      );
      return cloneTask(task);
    });
  }

  get(id: string): CalendarTask | undefined {
    const taskId = requireIdentityPart(id, "id");
    return this.getInternal(taskId);
  }

  getBySourceKey(sourceKey: string): CalendarTask | undefined {
    const key = requireIdentityPart(sourceKey, "sourceKey");
    const row = this.db.prepare(
      "SELECT * FROM calendar_agent_tasks WHERE ownerId = ? AND sourceKey = ?"
    ).get(this.ownerId, key) as SqlRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(limit = 30): CalendarTask[] {
    if (!Number.isFinite(limit)) throw new CalendarTaskError("INVALID_INPUT", "limit must be finite");
    const safeLimit = Math.min(MAX_TASK_LIST_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(
      `SELECT * FROM calendar_agent_tasks
       WHERE ownerId = ? ORDER BY updatedAt DESC, createdAt DESC, id DESC LIMIT ?`
    ).all(this.ownerId, safeLimit) as SqlRow[];
    return rows.map(rowToTask);
  }

  listQueued(limit = 1): CalendarTask[] {
    if (!Number.isFinite(limit)) throw new CalendarTaskError("INVALID_INPUT", "limit must be finite");
    const safeLimit = Math.min(MAX_TASK_LIST_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(
      `SELECT * FROM calendar_agent_tasks
       WHERE ownerId = ? AND state = 'queued'
       ORDER BY createdAt ASC, id ASC LIMIT ?`
    ).all(this.ownerId, safeLimit) as SqlRow[];
    return rows.map(rowToTask);
  }

  update(id: string, patch: CalendarTaskUpdatePatch): CalendarTask | undefined {
    const taskId = requireIdentityPart(id, "id");
    if (!isRecord(patch)) throw new CalendarTaskError("INVALID_INPUT", "task patch must be an object");
    rejectUnknownKeys(patch, ["state", "threadId", "turnId", "result", "error", "question", "proposalIds"]);
    if (patch.state !== undefined && !taskStates.has(patch.state)) {
      throw new CalendarTaskError("INVALID_INPUT", "invalid task state");
    }
    const has = (field: keyof CalendarTaskUpdatePatch) => Object.prototype.hasOwnProperty.call(patch, field);
    const next = {
      threadId: has("threadId") ? optionalText(patch.threadId, "threadId") : undefined,
      turnId: has("turnId") ? optionalText(patch.turnId, "turnId") : undefined,
      result: has("result") ? cloneJsonValue(patch.result) : undefined,
      error: has("error") ? optionalText(patch.error, "error") : undefined,
      question: has("question") ? optionalText(patch.question, "question") : undefined
    };
    if (has("proposalIds") && patch.proposalIds !== undefined) {
      if (!Array.isArray(patch.proposalIds) || patch.proposalIds.some((idValue) => typeof idValue !== "string")) {
        throw new CalendarTaskError("INVALID_INPUT", "proposalIds must be an array of strings");
      }
      if (patch.proposalIds.length > 100 || patch.proposalIds.some((idValue) => idValue.length > MAX_TASK_KEY_LENGTH)) {
        throw new CalendarTaskError("INVALID_INPUT", "proposalIds is too large");
      }
    }

    return this.withTransaction(() => {
      const current = this.getInternal(taskId);
      if (!current) return undefined;
      const updated: CalendarTask = {
        ...current,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(has("threadId") ? { threadId: next.threadId } : {}),
        ...(has("turnId") ? { turnId: next.turnId } : {}),
        ...(has("result") ? { result: next.result } : {}),
        ...(has("error") ? { error: next.error } : {}),
        ...(has("question") ? { question: next.question } : {}),
        ...(has("proposalIds") ? { proposalIds: patch.proposalIds ? [...patch.proposalIds] : [] } : {}),
        updatedAt: now()
      };
      this.writeTask(updated);
      return cloneTask(updated);
    });
  }

  addInput(id: string, input: CalendarTaskInputAdd): CalendarTask | undefined {
    const taskId = requireIdentityPart(id, "id");
    if (!isRecord(input)) throw new CalendarTaskError("INVALID_INPUT", "task input must be an object");
    rejectUnknownKeys(input, ["inputKey", "text"]);
    const inputKey = requireIdentityPart(input.inputKey, "inputKey");
    const text = requireText(input.text, "text", MAX_TASK_TEXT_LENGTH);

    return this.withTransaction(() => {
      const current = this.getInternal(taskId);
      if (!current) return undefined;
      const existing = current.inputs.find((item) => item.inputKey === inputKey);
      if (existing) {
        if (existing.text !== text) {
          throw new CalendarTaskError("INPUT_KEY_CONFLICT", "inputKey already belongs to different input content");
        }
        return current;
      }

      if (current.inputs.length >= MAX_TASK_INPUT_COUNT) {
        throw new CalendarTaskError("INVALID_INPUT", "task has too many inputs");
      }
      const currentInputLength = current.inputs.reduce((total, item) => total + item.text.length, 0);
      if (currentInputLength + text.length > MAX_TASK_INPUT_TOTAL_LENGTH) {
        throw new CalendarTaskError("INVALID_INPUT", "task inputs are too large");
      }

      const updated: CalendarTask = {
        ...current,
        inputs: [...current.inputs, { inputKey, text, at: now() }],
        state: current.state === "running" ? "running" : "queued",
        updatedAt: now()
      };
      this.writeTask(updated);
      return cloneTask(updated);
    });
  }

  recoverInterrupted() {
    return this.withTransaction(() => {
      const timestamp = now();
      const result = this.db.prepare(
        "UPDATE calendar_agent_tasks SET state = 'interrupted', updatedAt = ? WHERE ownerId = ? AND state = 'running'"
      ).run(timestamp, this.ownerId) as { changes?: number };
      return Number(result.changes ?? 0);
    });
  }
}
