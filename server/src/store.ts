import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createAuthSettings, isDefaultPassword, verifyPassword } from "./auth-crypto";
import { decryptCredential, encryptCredential } from "./credential-crypto";
import { publishAppEvent } from "./events";
import type { Cursor, MailKey, RawMail } from "./email/mail-reader";
import type {
  AiSettings,
  AiBillingProvider,
  AiCostSnapshot,
  AiUsageDashboard,
  AiUsageEventInput,
  AiUsageModelBreakdown,
  AiUsageRange,
  AiUsageScope,
  AiUsageScopeBreakdown,
  AiUsageTimelinePoint,
  AiUsageTotals,
  AppState,
  AuthSettings,
  ClassificationResult,
  IncomingEmail,
  MailCategory,
  Mailbox,
  NotificationChannel,
  NotificationDelivery,
  NotificationDeliveryListItem,
  NotificationDeliveryStatus,
  NotificationSettings,
  EmailNotificationStatusSummary,
  ProcessedEmail,
  ProcessedEmailCalendarAnalysis,
  ProcessingRun,
  PublicQqBotSettings,
  QqBotBinding,
  QqBotConfig,
  QqBotSettingsInput,
  QqAgentPermission,
  QqAgentEvent,
  QqAgentRun,
  QqAgentRunStatus,
  QqAgentSettings,
  QqGatewayState,
  QqEmailReadAction,
  QqNotificationReference,
  SystemSettings,
  MailCursor
} from "./types";

const DEFAULT_DATA_DIR = process.env.NODE_TEST_CONTEXT
  ? path.join(tmpdir(), `auto-email-system-test-${process.pid}`)
  : "data";
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
const JSON_DATA_FILE = path.join(DATA_DIR, "app.db.json");
const SQLITE_FILE = path.join(DATA_DIR, "app.sqlite");
const SCHEMA_VERSION = 5;
const PANEL_READ_UNDO_TTL_MS = 10_000;
const EMAIL_DISPLAY_RECEIVED_ORDER_SQL = "COALESCE(receivedAt, processedAt) DESC, processedAt DESC, id DESC";
const EMAIL_QUEUE_RECEIVED_ORDER_SQL = "COALESCE(receivedAt, processedAt) ASC, processedAt ASC, id ASC";
const NOTIFICATION_DELIVERY_RECEIVED_ORDER_SQL = [
  "COALESCE(emails.receivedAt, emails.processedAt, notification_deliveries.createdAt) ASC",
  "notification_deliveries.createdAt ASC",
  "notification_deliveries.id ASC"
].join(", ");

type PanelReadUndoOperation = {
  emailIds: string[];
  expiresAtMs: number;
};

export type DigestStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: "INVALID_INPUT" | "STORAGE"; retryable: boolean; message: string } };

const panelReadUndoOperations = new Map<string, PanelReadUndoOperation>();

const defaultNotifyCategories: Record<MailCategory, boolean> = {
  important: true,
  secondary: true,
  ignore: false
};

const defaultQqAgentPermissions: Record<QqAgentPermission, boolean> = {
  readMail: true,
  sendMailImages: true,
  readAttachments: true,
  sendAttachments: true,
  manageReadState: true,
  manageNotifications: true,
  runProcessing: true,
  checkMailboxes: true,
  reclassifyMail: true
};

const defaultQqAgentSettings: QqAgentSettings = {
  enabled: false,
  requireConfirmation: true,
  maxResults: 6,
  permissions: defaultQqAgentPermissions
};

const defaultQqBotConfig: QqBotConfig = {
  appId: "",
  encryptedAppSecret: "",
  enabled: false,
  notifyCategories: defaultNotifyCategories,
  quoteImageMarksRead: true,
  agent: defaultQqAgentSettings
};

const aiProtocols = new Set(["auto", "openai-chat", "openai-responses", "anthropic", "gemini"]);
const multimodalProtocols = new Set([...aiProtocols, "same"]);

const defaultState: AppState = {
  settings: {
    ai: {
      providerName: "智谱 GLM Coding Plan",
      providerPreset: "custom",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
      model: "glm-5.2",
      temperature: 0.1,
      protocol: "auto",
      multimodalEnabled: true,
      multimodalBaseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      multimodalModel: "glm-5v-turbo",
      multimodalProtocol: "auto",
      multimodalApiKey: "",
      multimodalMaxAttachmentMb: 8,
      multimodalMaxTotalMb: 18
    },
    system: {
      autoProcessEnabled: true,
      autoLoadRemoteImages: false,
      pollIntervalMinutes: 10,
      processLimitPerMailbox: 30
    },
    notification: {
      enabled: false,
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: "",
      importantOnly: true,
      notifyCategories: defaultNotifyCategories
    },
    auth: createAuthSettings()
  },
  mailboxes: [],
  emails: [],
  runs: []
};

type SqlRow = Record<string, unknown>;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(SQLITE_FILE);

// Calendar composition uses the same local database through its restricted
// application router.
export function getAppDatabase(): DatabaseSync {
  return db;
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mail_cursors (
    ownerId TEXT NOT NULL,
    mailboxId TEXT NOT NULL,
    folder TEXT NOT NULL,
    uidValidity TEXT NOT NULL,
    lastUid TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (ownerId, mailboxId, folder)
  );

  CREATE TABLE IF NOT EXISTS fetched_mails (
    ownerId TEXT NOT NULL,
    mailboxId TEXT NOT NULL,
    folder TEXT NOT NULL,
    uidValidity TEXT NOT NULL,
    uid TEXT NOT NULL,
    receivedAt TEXT NOT NULL,
    oversized INTEGER NOT NULL,
    sizeBytes INTEGER NOT NULL,
    rawBytes BLOB,
    storedAt TEXT NOT NULL,
    PRIMARY KEY (ownerId, mailboxId, folder, uidValidity, uid)
  );

  CREATE INDEX IF NOT EXISTS idx_fetched_mails_scope
    ON fetched_mails(ownerId, mailboxId, folder, uidValidity, uid);

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailboxId TEXT NOT NULL,
    externalUid TEXT NOT NULL,
    messageId TEXT,
    subject TEXT NOT NULL,
    fromName TEXT,
    fromAddress TEXT,
    toText TEXT,
    receivedAt TEXT,
    processedAt TEXT NOT NULL,
    category TEXT NOT NULL,
    summaryZh TEXT NOT NULL,
    panelRead INTEGER NOT NULL DEFAULT 0,
    readMarked INTEGER NOT NULL DEFAULT 0,
    notifiedAt TEXT,
    notificationError TEXT,
    contentFingerprint TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_mailbox_uid ON emails(mailboxId, externalUid);
  CREATE INDEX IF NOT EXISTS idx_emails_category_processed ON emails(category, processedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox_processed ON emails(mailboxId, processedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_panel_read ON emails(category, panelRead);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(mailboxId, messageId);
  CREATE INDEX IF NOT EXISTS idx_emails_fingerprint ON emails(mailboxId, contentFingerprint);
  CREATE INDEX IF NOT EXISTS idx_emails_notification_retry ON emails(notificationError, notifiedAt);
  CREATE INDEX IF NOT EXISTS idx_emails_received_order
    ON emails(COALESCE(receivedAt, processedAt), processedAt, id);
  CREATE INDEX IF NOT EXISTS idx_emails_category_received
    ON emails(category, COALESCE(receivedAt, processedAt), processedAt, id);
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox_received
    ON emails(mailboxId, COALESCE(receivedAt, processedAt), processedAt, id);

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    mailboxId TEXT,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, startedAt DESC);

  CREATE TABLE IF NOT EXISTS processing_events (
    id TEXT PRIMARY KEY,
    runId TEXT,
    mailboxId TEXT,
    emailId TEXT,
    subject TEXT,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_processing_events_run ON processing_events(runId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_processing_events_mailbox ON processing_events(mailboxId, createdAt DESC);

  CREATE TABLE IF NOT EXISTS credentials (
    key TEXT PRIMARY KEY,
    envelope TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS qq_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS qq_event_dedupe (
    eventId TEXT PRIMARY KEY,
    receivedAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_qq_event_dedupe_expires ON qq_event_dedupe(expiresAt);

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    emailId TEXT NOT NULL,
    channel TEXT NOT NULL,
    bypassCategoryFilter INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    attemptCount INTEGER NOT NULL DEFAULT 0,
    nextAttemptAt TEXT,
    sentAt TEXT,
    lastError TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(emailId, channel)
  );

  CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_next_attempt
    ON notification_deliveries(status, nextAttemptAt);
`);

db.exec([
  "CREATE TABLE IF NOT EXISTS qq_notification_refs (",
  "  id TEXT PRIMARY KEY,",
  "  emailId TEXT NOT NULL,",
  "  userOpenId TEXT NOT NULL,",
  "  messageId TEXT,",
  "  refIndex TEXT,",
  "  createdAt TEXT NOT NULL,",
  "  FOREIGN KEY(emailId) REFERENCES emails(id) ON DELETE CASCADE",
  ");",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_qq_notification_refs_message",
  "  ON qq_notification_refs(userOpenId, messageId) WHERE messageId IS NOT NULL;",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_qq_notification_refs_ref",
  "  ON qq_notification_refs(userOpenId, refIndex) WHERE refIndex IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS idx_qq_notification_refs_created",
  "  ON qq_notification_refs(createdAt DESC);"
].join("\n"));

db.exec(`
  CREATE TABLE IF NOT EXISTS qq_email_read_actions (
    token TEXT PRIMARY KEY,
    emailId TEXT NOT NULL,
    userOpenId TEXT NOT NULL,
    messageId TEXT,
    refIndex TEXT,
    usedAt TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY(emailId) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_qq_email_read_actions_user
    ON qq_email_read_actions(userOpenId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_qq_email_read_actions_created
    ON qq_email_read_actions(createdAt DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS qq_agent_runs (
    id TEXT PRIMARY KEY,
    userOpenId TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    reply TEXT,
    error TEXT,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    durationMs INTEGER,
    stepCount INTEGER NOT NULL DEFAULT 0,
    toolCallCount INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_qq_agent_runs_started
    ON qq_agent_runs(startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_qq_agent_runs_user
    ON qq_agent_runs(userOpenId, startedAt DESC);

  CREATE TABLE IF NOT EXISTS qq_agent_events (
    id TEXT PRIMARY KEY,
    runId TEXT,
    userOpenId TEXT NOT NULL,
    kind TEXT NOT NULL,
    toolName TEXT,
    status TEXT NOT NULL,
    message TEXT,
    data TEXT NOT NULL,
    step INTEGER,
    durationMs INTEGER,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_qq_agent_events_user
    ON qq_agent_events(userOpenId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_qq_agent_events_tool
    ON qq_agent_events(toolName, createdAt DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage_events (
    id TEXT PRIMARY KEY,
    occurredAt TEXT NOT NULL,
    scope TEXT NOT NULL,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    protocol TEXT NOT NULL,
    model TEXT NOT NULL,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cachedInputTokens INTEGER NOT NULL DEFAULT 0,
    cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
    totalTokens INTEGER NOT NULL DEFAULT 0,
    usageReported INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    latencyMs INTEGER NOT NULL DEFAULT 0,
    requestId TEXT,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ai_usage_occurred
    ON ai_usage_events(occurredAt DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_scope_occurred
    ON ai_usage_events(scope, occurredAt DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_model_occurred
    ON ai_usage_events(provider, model, occurredAt DESC);

  CREATE TABLE IF NOT EXISTS ai_cost_snapshots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    rangeKey TEXT NOT NULL,
    startAt TEXT NOT NULL,
    endAt TEXT NOT NULL,
    queriedAt TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE(provider, rangeKey)
  );
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  if (columns.some((item) => String(item.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("qq_agent_events", "runId", "TEXT");
ensureColumn("qq_agent_events", "step", "INTEGER");
ensureColumn("qq_agent_events", "durationMs", "INTEGER");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_qq_agent_events_run
    ON qq_agent_events(runId, createdAt ASC);
`);
const interruptedAgentRuns = db.prepare("SELECT id, startedAt FROM qq_agent_runs WHERE status = 'running'").all() as SqlRow[];
const interruptedAgentRunAt = new Date().toISOString();
for (const run of interruptedAgentRuns) {
  db.prepare(
    `UPDATE qq_agent_runs
     SET status = 'failed', error = ?, finishedAt = ?, durationMs = ?
     WHERE id = ?`
  ).run(
    "服务重启，上一轮智能体运行已中断。",
    interruptedAgentRunAt,
    Math.max(0, Date.parse(interruptedAgentRunAt) - Date.parse(String(run.startedAt))),
    String(run.id)
  );
}

type EmailFtsMode = "trigram" | "unicode61" | "disabled";
const EMAIL_FTS_VERSION = "2";
const EMAIL_FTS_REBUILD_BATCH_SIZE = 16;
let emailFtsMode: EmailFtsMode = "disabled";

function initializeEmailFts() {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_fts'").get() as
    | SqlRow
    | undefined;
  if (existing?.sql) {
    emailFtsMode = String(existing.sql).includes("trigram") ? "trigram" : "unicode61";
  } else {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE email_fts USING fts5(
          emailId UNINDEXED,
          subject,
          sender,
          recipients,
          summary,
          body,
          attachmentNames,
          tokenize = 'trigram'
        );
      `);
      emailFtsMode = "trigram";
    } catch {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE email_fts USING fts5(
            emailId UNINDEXED,
            subject,
            sender,
            recipients,
            summary,
            body,
            attachmentNames,
            tokenize = 'unicode61'
          );
        `);
        emailFtsMode = "unicode61";
      } catch {
        emailFtsMode = "disabled";
      }
    }
  }

  if (emailFtsMode !== "disabled") {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS emails_fts_delete
      AFTER DELETE ON emails
      BEGIN
        DELETE FROM email_fts WHERE emailId = OLD.id;
      END;
    `);
  }
}

function emailSearchDocument(email: ProcessedEmail) {
  const attachmentNames = (email.attachments ?? []).map((attachment) => attachment.filename).join("\n");
  const multimodal = email.multimodalAnalysis;
  return {
    subject: email.subject || "",
    sender: [email.fromName, email.fromAddress].filter(Boolean).join(" "),
    recipients: email.toText || "",
    summary: [
      email.summaryZh,
      email.reasonZh,
      ...(email.actionItemsZh ?? []),
      multimodal?.summaryZh,
      multimodal?.reasonZh,
      ...(multimodal?.importantSignalsZh ?? [])
    ].filter(Boolean).join("\n"),
    body: email.originalText || "",
    attachmentNames
  };
}

function writeEmailSearchIndex(emailId: string, document: ReturnType<typeof emailSearchDocument>, replace = true) {
  if (emailFtsMode === "disabled") return;
  if (replace) db.prepare("DELETE FROM email_fts WHERE emailId = ?").run(emailId);
  db.prepare(
    `INSERT INTO email_fts (emailId, subject, sender, recipients, summary, body, attachmentNames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    emailId,
    document.subject,
    document.sender,
    document.recipients,
    document.summary,
    document.body,
    document.attachmentNames
  );
}

function indexEmailForSearch(email: ProcessedEmail) {
  writeEmailSearchIndex(email.id, emailSearchDocument(email));
}

function ftsMatchQuery(value: string) {
  if (emailFtsMode !== "trigram") return undefined;
  const tokens = value
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 12);
  if (!tokens.length) return undefined;
  return tokens.map((item) => `"${item.replaceAll('"', '""')}"`).join(" AND ");
}

initializeEmailFts();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bool(value: unknown) {
  return value ? 1 : 0;
}

function parseBool(value: unknown) {
  return Number(value) === 1;
}

function normalizeQqAgentSettings(input: Partial<QqAgentSettings> | undefined): QqAgentSettings {
  const permissions = {
    ...defaultQqAgentPermissions,
    ...(input?.permissions ?? {})
  };
  const maxResults = Math.floor(Number(input?.maxResults ?? defaultQqAgentSettings.maxResults));
  return {
    enabled: Boolean(input?.enabled ?? defaultQqAgentSettings.enabled),
    requireConfirmation: Boolean(input?.requireConfirmation ?? defaultQqAgentSettings.requireConfirmation),
    maxResults: Math.min(10, Math.max(3, Number.isFinite(maxResults) ? maxResults : defaultQqAgentSettings.maxResults)),
    permissions: {
      readMail: Boolean(permissions.readMail),
      sendMailImages: Boolean(permissions.sendMailImages),
      readAttachments: Boolean(permissions.readAttachments),
      sendAttachments: Boolean(permissions.sendAttachments),
      manageReadState: Boolean(permissions.manageReadState),
      manageNotifications: Boolean(permissions.manageNotifications),
      runProcessing: Boolean(permissions.runProcessing),
      checkMailboxes: Boolean(permissions.checkMailboxes),
      reclassifyMail: Boolean(permissions.reclassifyMail)
    }
  };
}

function normalizeFingerprintText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emailContentFingerprint(email: IncomingEmail | ProcessedEmail) {
  const parts = [
    email.mailboxId,
    normalizeFingerprintText(email.subject),
    normalizeFingerprintText(email.fromAddress),
    normalizeFingerprintText(email.toText),
    email.receivedAt || "",
    normalizeFingerprintText(email.originalText).slice(0, 8000)
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function setMeta(key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function getMeta(key: string) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? String(row.value) : undefined;
}

export function normalizeAiSettings(input: Partial<AiSettings> = {}): AiSettings {
  const merged = { ...defaultState.settings.ai, ...input };

  return {
    ...merged,
    providerPreset:
      typeof merged.providerPreset === "string" && merged.providerPreset.trim() ? merged.providerPreset : "custom",
    apiKey: typeof merged.apiKey === "string" ? merged.apiKey : "",
    protocol: aiProtocols.has(merged.protocol ?? "")
      ? (merged.protocol as NonNullable<AiSettings["protocol"]>)
      : "auto",
    multimodalProtocol: multimodalProtocols.has(merged.multimodalProtocol ?? "")
      ? (merged.multimodalProtocol as NonNullable<AiSettings["multimodalProtocol"]>)
      : "auto",
    multimodalApiKey: typeof merged.multimodalApiKey === "string" ? merged.multimodalApiKey : ""
  };
}

function normalizeState(parsed: Partial<AppState>): AppState {
  const parsedNotification = parsed.settings?.notification as Partial<NotificationSettings> | undefined;
  const parsedAuth = parsed.settings?.auth as Partial<AuthSettings> | undefined;
  const migratedNotifyCategories =
    parsedNotification?.notifyCategories ??
    (parsedNotification
      ? {
          important: true,
          secondary: parsedNotification.importantOnly === false,
          ignore: false
        }
      : defaultNotifyCategories);
  const auth =
    parsedAuth?.passwordHash && parsedAuth.passwordSalt
      ? {
          ...defaultState.settings.auth,
          ...parsedAuth,
          passwordIterations: parsedAuth.passwordIterations ?? defaultState.settings.auth.passwordIterations
        }
      : createAuthSettings();

  return {
    settings: {
      ai: normalizeAiSettings(parsed.settings?.ai),
      system: { ...defaultState.settings.system, ...parsed.settings?.system },
      notification: {
        ...defaultState.settings.notification,
        ...parsed.settings?.notification,
        notifyCategories: {
          ...defaultNotifyCategories,
          ...migratedNotifyCategories
        },
        clawbotApiUrl: "http://127.0.0.1:18011/api/send",
        clawbotRecipientId: ""
      },
      auth
    },
    mailboxes: parsed.mailboxes ?? [],
    emails: (parsed.emails ?? []).map((email) => ({
      ...email,
      panelRead: email.panelRead ?? email.category === "ignore"
    })),
    runs: parsed.runs ?? []
  };
}

function insertSettings(settings: AppState["settings"]) {
  const statement = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  statement.run("ai", JSON.stringify(normalizeAiSettings(settings.ai)));
  statement.run("system", JSON.stringify(settings.system));
  statement.run("notification", JSON.stringify(settings.notification));
  statement.run("auth", JSON.stringify(settings.auth));
}

function insertMailbox(mailbox: Mailbox) {
  db.prepare(
    `INSERT OR REPLACE INTO mailboxes (id, name, email, enabled, createdAt, updatedAt, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    mailbox.id,
    mailbox.name,
    mailbox.email,
    bool(mailbox.enabled),
    mailbox.createdAt,
    mailbox.updatedAt,
    JSON.stringify(mailbox)
  );
}

function insertEmail(email: ProcessedEmail) {
  const normalized: ProcessedEmail = {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  };
  db.prepare(
    `INSERT INTO emails (
      id, mailboxId, externalUid, messageId, subject, fromName, fromAddress, toText, receivedAt,
      processedAt, category, summaryZh, panelRead, readMarked, notifiedAt, notificationError,
      contentFingerprint, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mailboxId = excluded.mailboxId,
      externalUid = excluded.externalUid,
      messageId = excluded.messageId,
      subject = excluded.subject,
      fromName = excluded.fromName,
      fromAddress = excluded.fromAddress,
      toText = excluded.toText,
      receivedAt = excluded.receivedAt,
      processedAt = excluded.processedAt,
      category = excluded.category,
      summaryZh = excluded.summaryZh,
      panelRead = excluded.panelRead,
      readMarked = excluded.readMarked,
      notifiedAt = excluded.notifiedAt,
      notificationError = excluded.notificationError,
      contentFingerprint = excluded.contentFingerprint,
      data = excluded.data`
  ).run(
    normalized.id,
    normalized.mailboxId,
    normalized.externalUid,
    normalizeFingerprintText(normalized.messageId) || null,
    normalized.subject,
    normalized.fromName ?? null,
    normalized.fromAddress ?? null,
    normalized.toText ?? null,
    normalized.receivedAt ?? null,
    normalized.processedAt,
    normalized.category,
    normalized.summaryZh,
    bool(normalized.panelRead),
    bool(normalized.readMarked),
    normalized.notifiedAt ?? null,
    normalized.notificationError ?? null,
    emailContentFingerprint(normalized),
    JSON.stringify(normalized)
  );
  indexEmailForSearch(normalized);
}

function insertRun(run: ProcessingRun) {
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, status, startedAt, finishedAt, mailboxId, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(run.id, run.status, run.startedAt, run.finishedAt ?? null, run.mailboxId ?? null, JSON.stringify(run));
}

function replaceState(state: AppState) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM settings; DELETE FROM mailboxes; DELETE FROM emails; DELETE FROM runs;");
    insertSettings(state.settings);
    for (const mailbox of state.mailboxes) insertMailbox(mailbox);
    for (const email of state.emails) insertEmail(email);
    for (const run of state.runs.slice(0, 100)) insertRun(run);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureInitialized() {
  if (getMeta("schemaVersion")) return;

  let initialState = defaultState;
  if (fs.existsSync(JSON_DATA_FILE)) {
    const raw = fs.readFileSync(JSON_DATA_FILE, "utf8");
    initialState = normalizeState(JSON.parse(raw) as Partial<AppState>);
  }

  replaceState(initialState);
  setMeta("schemaVersion", String(SCHEMA_VERSION));
  if (fs.existsSync(JSON_DATA_FILE)) {
    setMeta("jsonMigratedAt", new Date().toISOString());
  }
}

ensureInitialized();

function ensureNotificationDeliveryColumns() {
  const columns = db.prepare("PRAGMA table_info(notification_deliveries)").all() as SqlRow[];
  if (!columns.some((column) => String(column.name) === "bypassCategoryFilter")) {
    db.exec("ALTER TABLE notification_deliveries ADD COLUMN bypassCategoryFilter INTEGER NOT NULL DEFAULT 0");
  }
}

ensureNotificationDeliveryColumns();

function migrateQqNotificationState() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const legacyNotification = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("notification") as SqlRow | undefined;
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
      "notification.wechat",
      legacyNotification ? String(legacyNotification.value) : JSON.stringify(defaultState.settings.notification)
    );
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
      "notification.qq",
      JSON.stringify(defaultQqBotConfig)
    );
    db.exec(`
      INSERT OR IGNORE INTO notification_deliveries (
        id, emailId, channel, status, attemptCount, nextAttemptAt, sentAt, lastError, createdAt, updatedAt
      )
      SELECT
        lower(hex(randomblob(16))),
        id,
        'wechat',
        CASE WHEN notifiedAt IS NOT NULL THEN 'sent' ELSE 'retry' END,
        0,
        CASE WHEN notifiedAt IS NULL THEN processedAt ELSE NULL END,
        notifiedAt,
        notificationError,
        processedAt,
        COALESCE(notifiedAt, processedAt)
      FROM emails
      WHERE notifiedAt IS NOT NULL OR COALESCE(notificationError, '') <> ''
    `);
    setMeta("schemaVersion", String(SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

migrateQqNotificationState();

function rebuildEmailSearchIndexIfNeeded() {
  if (emailFtsMode === "disabled") return;
  const emailCount = Number((db.prepare("SELECT COUNT(*) AS total FROM emails").get() as SqlRow).total ?? 0);
  const ftsCount = Number((db.prepare("SELECT COUNT(*) AS total FROM email_fts").get() as SqlRow).total ?? 0);
  if (getMeta("emailFtsVersion") === EMAIL_FTS_VERSION && emailCount === ftsCount) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM email_fts").run();
    const selectBatch = db.prepare(`
      SELECT
        rowid AS sourceRowId,
        id AS emailId,
        COALESCE(subject, '') AS subject,
        trim(COALESCE(fromName, '') || ' ' || COALESCE(fromAddress, '')) AS sender,
        COALESCE(toText, '') AS recipients,
        COALESCE(summaryZh, '') AS summaryZh,
        CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.reasonZh'), '') ELSE '' END AS reasonZh,
        COALESCE((
          SELECT group_concat(value, char(10))
          FROM json_each(CASE WHEN json_valid(emails.data) THEN emails.data ELSE '{}' END, '$.actionItemsZh')
        ), '') AS actionItemsZh,
        CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.multimodalAnalysis.summaryZh'), '') ELSE '' END AS multimodalSummaryZh,
        CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.multimodalAnalysis.reasonZh'), '') ELSE '' END AS multimodalReasonZh,
        COALESCE((
          SELECT group_concat(value, char(10))
          FROM json_each(CASE WHEN json_valid(emails.data) THEN emails.data ELSE '{}' END, '$.multimodalAnalysis.importantSignalsZh')
        ), '') AS multimodalSignalsZh,
        CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.originalText'), '') ELSE '' END AS body,
        COALESCE((
          SELECT group_concat(json_extract(value, '$.filename'), char(10))
          FROM json_each(CASE WHEN json_valid(emails.data) THEN emails.data ELSE '{}' END, '$.attachments')
          WHERE json_extract(value, '$.filename') IS NOT NULL
        ), '') AS attachmentNames
      FROM emails
      WHERE rowid > ?
      ORDER BY rowid ASC
      LIMIT ?
    `);
    let cursor = 0;
    while (true) {
      const rows = selectBatch.all(cursor, EMAIL_FTS_REBUILD_BATCH_SIZE) as SqlRow[];
      if (!rows.length) break;
      for (const row of rows) {
        writeEmailSearchIndex(String(row.emailId), {
          subject: String(row.subject ?? ""),
          sender: String(row.sender ?? ""),
          recipients: String(row.recipients ?? ""),
          summary: [
            row.summaryZh,
            row.reasonZh,
            row.actionItemsZh,
            row.multimodalSummaryZh,
            row.multimodalReasonZh,
            row.multimodalSignalsZh
          ].filter(Boolean).join("\n"),
          body: String(row.body ?? ""),
          attachmentNames: String(row.attachmentNames ?? "")
        }, false);
      }
      cursor = Number(rows.at(-1)?.sourceRowId ?? cursor);
    }
    setMeta("emailFtsVersion", EMAIL_FTS_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

rebuildEmailSearchIndexIfNeeded();

function getSetting<T>(key: keyof AppState["settings"], fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(String(key)) as SqlRow | undefined;
  return row ? parseJson<T>(row.value) : clone(fallback);
}

function getSettings(): AppState["settings"] {
  const notification = getSetting<NotificationSettings>("notification", defaultState.settings.notification);
  return {
    ai: normalizeAiSettings(getSetting<AiSettings>("ai", defaultState.settings.ai)),
    system: getSetting<SystemSettings>("system", defaultState.settings.system),
    notification: {
      ...defaultState.settings.notification,
      ...notification,
      notifyCategories: {
        ...defaultNotifyCategories,
        ...notification.notifyCategories
      },
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: ""
    },
    auth: getSetting<AuthSettings>("auth", defaultState.settings.auth)
  };
}

function rowToMailbox(row: SqlRow): Mailbox {
  return parseJson<Mailbox>(row.data);
}

function rowToEmail(row: SqlRow): ProcessedEmail {
  const email = parseJson<ProcessedEmail>(row.data);
  return {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  };
}

function rowToRun(row: SqlRow): ProcessingRun {
  return parseJson<ProcessingRun>(row.data);
}

function getAllMailboxes() {
  return (db.prepare("SELECT data FROM mailboxes ORDER BY createdAt ASC, name ASC").all() as SqlRow[]).map(rowToMailbox);
}

function getAllEmails() {
  return (db.prepare(`SELECT data FROM emails ORDER BY ${EMAIL_DISPLAY_RECEIVED_ORDER_SQL}`).all() as SqlRow[]).map(rowToEmail);
}

function getRuns(limit = 100) {
  return (db.prepare("SELECT data FROM runs ORDER BY startedAt DESC LIMIT ?").all(limit) as SqlRow[]).map(rowToRun);
}

export function readSettings() {
  return clone(getSettings());
}

export function readMailboxes() {
  return clone(getAllMailboxes());
}

export function readMailCursor(ownerId: string, mailboxId: string, folder: string): MailCursor | undefined {
  const row = db
    .prepare(
      `SELECT ownerId, mailboxId, folder, uidValidity, lastUid, updatedAt
       FROM mail_cursors
       WHERE ownerId = ? AND mailboxId = ? AND folder = ?`
    )
    .get(ownerId, mailboxId, folder) as Partial<MailCursor> | undefined;
  if (!row) return undefined;
  return {
    ownerId: String(row.ownerId),
    mailboxId: String(row.mailboxId),
    folder: String(row.folder),
    uidValidity: String(row.uidValidity),
    lastUid: String(row.lastUid),
    updatedAt: String(row.updatedAt)
  };
}

export function saveMailCursor(cursor: Omit<MailCursor, "updatedAt">): MailCursor {
  const saved = { ...cursor, updatedAt: new Date().toISOString() };
  db.prepare(
    `INSERT INTO mail_cursors (ownerId, mailboxId, folder, uidValidity, lastUid, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (ownerId, mailboxId, folder) DO UPDATE SET
       uidValidity = excluded.uidValidity,
       lastUid = excluded.lastUid,
       updatedAt = excluded.updatedAt`
  ).run(
    saved.ownerId,
    saved.mailboxId,
    saved.folder,
    saved.uidValidity,
    saved.lastUid,
    saved.updatedAt
  );
  return saved;
}

function fetchedMailError(message: string): DigestStoreResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", retryable: false, message } };
}

function numericUid(value: string) {
  if (!/^\d+$/.test(value)) return undefined;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : undefined;
}

function validateFetchedBatch(batch: RawMail[], cursor: Cursor) {
  if (!cursor.ownerId || !cursor.mailboxId || !cursor.folder || !cursor.uidValidity) return "游标缺少归属、邮箱、文件夹或 UIDVALIDITY";
  const lastUid = numericUid(cursor.lastUid);
  if (lastUid === undefined) return "游标 UID 无效";

  let previousUid = 0;
  const keys = new Set<string>();
  for (const mail of batch) {
    if (
      mail.key.ownerId !== cursor.ownerId ||
      mail.key.mailboxId !== cursor.mailboxId ||
      mail.key.folder !== cursor.folder ||
      mail.key.uidValidity !== cursor.uidValidity
    ) return "邮件键与游标不匹配";
    const uid = numericUid(mail.key.uid);
    if (uid === undefined || uid <= previousUid || uid > lastUid) return "邮件 UID 必须升序且不超过游标";
    if (keys.has(mail.key.uid)) return "批次包含重复邮件 UID";
    if (!mail.oversized && !mail.rawBytes) return "非超大邮件必须包含原文";
    keys.add(mail.key.uid);
    previousUid = uid;
  }
  return undefined;
}

export function commitFetched(batch: RawMail[], cursor: Cursor): DigestStoreResult<void> {
  const validationError = validateFetchedBatch(batch, cursor);
  if (validationError) return fetchedMailError(validationError);

  const current = readMailCursor(cursor.ownerId, cursor.mailboxId, cursor.folder);
  const currentUid = current && current.uidValidity === cursor.uidValidity ? numericUid(current.lastUid) : undefined;
  const nextUid = numericUid(cursor.lastUid)!;
  if (currentUid !== undefined && nextUid < currentUid) return fetchedMailError("游标不能倒退");

  const storedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO fetched_mails (
        ownerId, mailboxId, folder, uidValidity, uid, receivedAt, oversized, sizeBytes, rawBytes, storedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const mail of batch) {
      insert.run(
        mail.key.ownerId,
        mail.key.mailboxId,
        mail.key.folder,
        mail.key.uidValidity,
        mail.key.uid,
        mail.receivedAt,
        mail.oversized ? 1 : 0,
        mail.sizeBytes,
        mail.rawBytes ? Buffer.from(mail.rawBytes) : null,
        storedAt
      );
    }
    saveMailCursor({
      ownerId: cursor.ownerId,
      mailboxId: cursor.mailboxId,
      folder: cursor.folder,
      uidValidity: cursor.uidValidity,
      lastUid: cursor.lastUid
    });
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    return { ok: false, error: { code: "STORAGE", retryable: true, message: "邮件状态保存失败" } };
  }
  publishAppEvent("mail-cursor", { mailboxId: cursor.mailboxId, folder: cursor.folder, lastUid: cursor.lastUid });
  return { ok: true, value: undefined };
}

function rowToFetchedMail(row: SqlRow): RawMail {
  const rawBytes = row.rawBytes instanceof Uint8Array ? new Uint8Array(row.rawBytes) : undefined;
  return {
    key: {
      ownerId: String(row.ownerId),
      mailboxId: String(row.mailboxId),
      folder: String(row.folder),
      uidValidity: String(row.uidValidity),
      uid: String(row.uid)
    },
    receivedAt: String(row.receivedAt),
    ...(rawBytes ? { rawBytes } : {}),
    oversized: Number(row.oversized) === 1,
    sizeBytes: Number(row.sizeBytes)
  };
}

export function readFetchedMails(ownerId: string, mailboxId: string, folder: string, limit = 20) {
  const cursor = readMailCursor(ownerId, mailboxId, folder);
  if (!cursor) return [];
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  return (db.prepare(
    `SELECT ownerId, mailboxId, folder, uidValidity, uid, receivedAt, oversized, sizeBytes, rawBytes
     FROM fetched_mails
     WHERE ownerId = ? AND mailboxId = ? AND folder = ? AND uidValidity = ?
     ORDER BY CAST(uid AS INTEGER) ASC
     LIMIT ?`
  ).all(ownerId, mailboxId, folder, cursor.uidValidity, safeLimit) as SqlRow[]).map(rowToFetchedMail);
}

// Include owner and UID generation: IMAP UIDs are only unique within one
// folder and UIDVALIDITY generation, and the legacy emails table has no owner.
export function fetchedMailExternalUid(key: MailKey): string {
  return JSON.stringify([key.ownerId, key.folder, key.uidValidity, key.uid]);
}

export function readPendingFetchedMails(ownerId: string, mailboxId: string, folder: string, limit = 20): RawMail[] {
  const cursor = readMailCursor(ownerId, mailboxId, folder);
  if (!cursor) return [];
  const safeLimit = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.floor(limit))) : 20;
  return (db.prepare(
    `SELECT f.ownerId, f.mailboxId, f.folder, f.uidValidity, f.uid,
            f.receivedAt, f.oversized, f.sizeBytes, f.rawBytes
     FROM fetched_mails AS f
     WHERE f.ownerId = ? AND f.mailboxId = ? AND f.folder = ? AND f.uidValidity = ?
       AND NOT EXISTS (
         SELECT 1 FROM emails AS e
         WHERE e.mailboxId = f.mailboxId
           AND e.externalUid = json_array(f.ownerId, f.folder, f.uidValidity, f.uid)
       )
     ORDER BY CAST(f.uid AS INTEGER) ASC
     LIMIT ?`
  ).all(ownerId, mailboxId, folder, cursor.uidValidity, safeLimit) as SqlRow[]).map(rowToFetchedMail);
}

export function readProcessingRuns(limit = 100) {
  return clone(getRuns(limit));
}

export function readState(): AppState {
  return {
    settings: clone(getSettings()),
    mailboxes: getAllMailboxes(),
    emails: getAllEmails(),
    runs: getRuns(100)
  };
}

export function updateState(mutator: (state: AppState) => void): AppState {
  const next = readState();
  mutator(next);
  replaceState(next);
  publishAppEvent("state", {});
  return clone(next);
}

export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export function publicMailbox(mailbox: Mailbox) {
  return {
    ...mailbox,
    password: "",
    hasPassword: Boolean(mailbox.password)
  };
}

export function publicAiSettings(settings: AiSettings) {
  const normalized = normalizeAiSettings(settings);
  return {
    ...normalized,
    apiKey: "",
    hasApiKey: Boolean(normalized.apiKey),
    maskedApiKey: maskSecret(normalized.apiKey),
    multimodalApiKey: "",
    hasMultimodalApiKey: Boolean(normalized.multimodalApiKey),
    maskedMultimodalApiKey: maskSecret(normalized.multimodalApiKey ?? "")
  };
}

export function publicAuthSettings(settings: AuthSettings) {
  return {
    passwordUpdatedAt: settings.passwordUpdatedAt,
    sessionDays: 7
  };
}

export function upsertMailbox(input: Omit<Mailbox, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
  const now = new Date().toISOString();
  let saved: Mailbox;
  if (input.id) {
    const existing = getAllMailboxes().find((mailbox) => mailbox.id === input.id);
    if (!existing) throw new Error("邮箱不存在");
    saved = {
      ...existing,
      ...input,
      password: input.password || existing.password,
      updatedAt: now
    };
  } else {
    saved = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
  }

  insertMailbox(saved);
  publishAppEvent("mailboxes", { id: saved.id });
  return readMailboxes();
}

export function removeMailbox(id: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM mail_cursors WHERE mailboxId = ?").run(id);
    db.prepare("DELETE FROM fetched_mails WHERE mailboxId = ?").run(id);
    db.prepare("DELETE FROM emails WHERE mailboxId = ?").run(id);
    db.prepare("DELETE FROM mailboxes WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  publishAppEvent("mailboxes", { id });
  publishAppEvent("emails", { mailboxId: id });
  return { mailboxes: readMailboxes() };
}

export function updateAiSettings(input: Partial<AiSettings>) {
  const current = getSettings().ai;
  const next = normalizeAiSettings({
    ...current,
    ...input,
    apiKey: input.apiKey || current.apiKey,
    multimodalApiKey: input.multimodalApiKey || current.multimodalApiKey
  });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("ai", JSON.stringify(next));
  publishAppEvent("settings", { key: "ai" });
  return next;
}

export function updateSystemSettings(input: Partial<SystemSettings>) {
  const next = {
    ...getSettings().system,
    ...input
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("system", JSON.stringify(next));
  publishAppEvent("settings", { key: "system" });
  return next;
}

export function updateNotificationSettings(input: Partial<NotificationSettings>) {
  const current = getSettings().notification;
  const notifyCategories = {
    ...defaultNotifyCategories,
    ...current.notifyCategories,
    ...input.notifyCategories
  };
  const next = {
    ...current,
    ...input,
    clawbotApiUrl: "http://127.0.0.1:18011/api/send",
    clawbotRecipientId: "",
    notifyCategories,
    importantOnly: notifyCategories.important && !notifyCategories.secondary && !notifyCategories.ignore
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("notification", JSON.stringify(next));
  publishAppEvent("settings", { key: "notification" });
  return next;
}

export function verifyAdminPassword(password: string) {
  return verifyPassword(password, getSettings().auth);
}

export function isAdminPasswordChanged() {
  return !isDefaultPassword(getSettings().auth);
}

export function updateAuthPassword(currentPassword: string, newPassword: string) {
  const current = getSettings().auth;
  if (!verifyPassword(currentPassword, current)) {
    throw new Error("当前登录密码不正确。");
  }

  const next = createAuthSettings(newPassword);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("auth", JSON.stringify(next));
  publishAppEvent("settings", { key: "auth" });
  return next;
}

export function hasProcessed(mailboxId: string, externalUid: string) {
  const row = db
    .prepare("SELECT 1 FROM emails WHERE mailboxId = ? AND externalUid = ? LIMIT 1")
    .get(mailboxId, externalUid);
  return Boolean(row);
}

export function getProcessedEmail(mailboxId: string, externalUid: string) {
  const row = db
    .prepare("SELECT data FROM emails WHERE mailboxId = ? AND externalUid = ? LIMIT 1")
    .get(mailboxId, externalUid) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function getProcessedEmailById(id: string) {
  const row = db.prepare("SELECT data FROM emails WHERE id = ? LIMIT 1").get(id) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function findProcessedEmailDuplicate(email: IncomingEmail | ProcessedEmail) {
  const messageId = normalizeFingerprintText(email.messageId);
  if (messageId) {
    const byMessageId = db
      .prepare("SELECT data FROM emails WHERE mailboxId = ? AND messageId = ? LIMIT 1")
      .get(email.mailboxId, messageId) as SqlRow | undefined;
    if (byMessageId) return clone(rowToEmail(byMessageId));
  }

  const fingerprint = emailContentFingerprint(email);
  const row = db
    .prepare(
      "SELECT data FROM emails WHERE mailboxId = ? AND externalUid <> ? AND contentFingerprint = ? LIMIT 1"
    )
    .get(email.mailboxId, email.externalUid, fingerprint) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function addProcessedEmail(email: ProcessedEmail) {
  const messageId = normalizeFingerprintText(email.messageId);
  const fingerprint = emailContentFingerprint(email);
  const existing = messageId
    ? db
        .prepare(
          `SELECT id FROM emails
           WHERE mailboxId = ? AND (externalUid = ? OR messageId = ? OR contentFingerprint = ?)
           LIMIT 1`
        )
        .get(email.mailboxId, email.externalUid, messageId, fingerprint)
    : db
        .prepare(
          `SELECT id FROM emails
           WHERE mailboxId = ? AND (externalUid = ? OR contentFingerprint = ?)
           LIMIT 1`
        )
        .get(email.mailboxId, email.externalUid, fingerprint);
  if (existing) return undefined;

  insertEmail(email);
  publishAppEvent("email", { id: email.id, mailboxId: email.mailboxId, category: email.category });
  return clone({
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  });
}

// The new UID-based pipeline treats each fetched message as distinct, even if
// Message-ID or content matches another message. Its notification writes must
// commit together with the processed email, or both remain pending for replay.
export function commitProcessedEmailWithNotifications(
  email: ProcessedEmail,
  enqueue: () => number,
  prepare?: () => void
): ProcessedEmail | undefined {
  db.exec("BEGIN IMMEDIATE");
  let inserted: ProcessedEmail | undefined;
  try {
    const existing = db.prepare(
      "SELECT 1 FROM emails WHERE mailboxId = ? AND externalUid = ? LIMIT 1"
    ).get(email.mailboxId, email.externalUid);
    if (existing) {
      db.exec("COMMIT");
      return undefined;
    }
    if (db.prepare("SELECT 1 FROM emails WHERE id = ? LIMIT 1").get(email.id)) {
      throw new Error("processed email ID already belongs to another message");
    }
    // Intake hooks run after duplicate checks but before the email row and its
    // notification outbox entries are inserted, so their state is atomic with
    // the email commit and replaying a duplicate cannot create a second task.
    prepare?.();
    insertEmail(email);
    enqueue();
    db.exec("COMMIT");
    inserted = clone({ ...email, panelRead: email.panelRead ?? email.category === "ignore" });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  publishAppEvent("email", { id: email.id, mailboxId: email.mailboxId, category: email.category });
  return inserted;
}

export function updateProcessedEmailCalendar(
  id: string,
  calendarAnalysis: ProcessedEmailCalendarAnalysis
) {
  const email = getProcessedEmailById(id);
  if (!email) return undefined;
  email.calendarAnalysis = clone(calendarAnalysis);
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
  return email;
}

function updateEmailByLookup(mailboxId: string, externalUid: string, mutator: (email: ProcessedEmail) => void) {
  const email = getProcessedEmail(mailboxId, externalUid);
  if (!email) return undefined;
  mutator(email);
  insertEmail(email);
  publishAppEvent("email", { id: email.id, mailboxId, category: email.category });
  return email;
}

export function updateProcessedEmailReadMark(
  mailboxId: string,
  externalUid: string,
  readMark: { marked: boolean; note?: string }
) {
  updateEmailByLookup(mailboxId, externalUid, (email) => {
    email.readMarked = readMark.marked;
    email.readMarkNote = readMark.note;
  });
}

export function updateProcessedEmailNotification(
  id: string,
  patch: Pick<ProcessedEmail, "notifiedAt" | "notificationError">
) {
  const email = getProcessedEmailById(id);
  if (!email) return;
  email.notifiedAt = patch.notifiedAt;
  email.notificationError = patch.notificationError;
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
}

export function updateProcessedEmailPanelRead(id: string, panelRead: boolean) {
  const email = getProcessedEmailById(id);
  if (!email) throw new Error("邮件不存在");

  email.panelRead = panelRead;
  email.panelReadAt = panelRead ? new Date().toISOString() : undefined;
  insertEmail(email);
  publishAppEvent("email-read-state", {
    id,
    mailboxId: email.mailboxId,
    category: email.category,
    panelRead: email.panelRead,
    panelReadAt: email.panelReadAt
  });
  return email;
}

export function updateProcessedEmailCategory(id: string, category: MailCategory) {
  const email = getProcessedEmailById(id);
  if (!email) throw new Error("邮件不存在");

  email.category = category;
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
  return email;
}

export function updateProcessedEmailClassification(id: string, result: ClassificationResult) {
  const email = getProcessedEmailById(id);
  if (!email) throw new Error("邮件不存在");

  email.category = result.category;
  email.summaryZh = result.summaryZh;
  email.reasonZh = result.reasonZh;
  email.actionItemsZh = result.actionItemsZh;
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
  return email;
}

export function markProcessedEmailsPanelRead(options: { category?: MailCategory; mailboxId?: string }) {
  const where = ["panelRead = 0"];
  const params: SQLInputValue[] = [];
  if (options.category) {
    where.push("category = ?");
    params.push(options.category);
  }
  if (options.mailboxId && options.mailboxId !== "all") {
    where.push("mailboxId = ?");
    params.push(options.mailboxId);
  }

  const rows = db
    .prepare("SELECT id, data FROM emails WHERE " + where.join(" AND "))
    .all(...params) as SqlRow[];
  const updatedAt = new Date().toISOString();
  if (!rows.length) return { updatedCount: 0, updatedAt };

  const update = db.prepare("UPDATE emails SET panelRead = 1, data = ? WHERE id = ? AND panelRead = 0");
  const updatedIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const email = rowToEmail(row);
      email.panelRead = true;
      email.panelReadAt = updatedAt;
      const emailId = String(row.id);
      const result = update.run(JSON.stringify(email), emailId);
      if (Number(result.changes) > 0) updatedIds.push(emailId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const operationId = randomUUID();
  const undoExpiresAtMs = Date.now() + PANEL_READ_UNDO_TTL_MS;
  panelReadUndoOperations.set(operationId, {
    emailIds: updatedIds,
    expiresAtMs: undoExpiresAtMs
  });
  const expiryTimer = setTimeout(() => {
    const current = panelReadUndoOperations.get(operationId);
    if (current?.expiresAtMs === undoExpiresAtMs) panelReadUndoOperations.delete(operationId);
  }, PANEL_READ_UNDO_TTL_MS + 250);
  expiryTimer.unref();

  publishAppEvent("email-bulk-read", {
    category: options.category ?? "all",
    mailboxId: options.mailboxId ?? "all",
    updatedCount: updatedIds.length
  });
  return {
    updatedCount: updatedIds.length,
    updatedAt,
    operationId,
    undoExpiresAt: new Date(undoExpiresAtMs).toISOString()
  };
}

export function undoProcessedEmailsPanelRead(operationId: string) {
  const operation = panelReadUndoOperations.get(operationId);
  if (!operation || Date.now() >= operation.expiresAtMs) {
    panelReadUndoOperations.delete(operationId);
    return undefined;
  }

  const select = db.prepare("SELECT id, data FROM emails WHERE id = ? AND panelRead = 1");
  const update = db.prepare("UPDATE emails SET panelRead = 0, data = ? WHERE id = ? AND panelRead = 1");
  let restoredCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const emailId of operation.emailIds) {
      const row = select.get(emailId) as SqlRow | undefined;
      if (!row) continue;
      const email = rowToEmail(row);
      email.panelRead = false;
      email.panelReadAt = undefined;
      const result = update.run(JSON.stringify(email), emailId);
      restoredCount += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  panelReadUndoOperations.delete(operationId);
  const restoredAt = new Date().toISOString();
  publishAppEvent("email-bulk-read-undone", { restoredCount });
  return { restoredCount, restoredAt };
}

export function addRun(run: ProcessingRun) {
  insertRun(run);
  const rows = db.prepare("SELECT id FROM runs ORDER BY startedAt DESC LIMIT -1 OFFSET 100").all() as SqlRow[];
  for (const row of rows) db.prepare("DELETE FROM runs WHERE id = ?").run(String(row.id));
  publishAppEvent("run", { id: run.id, status: run.status });
}

export function updateRun(run: ProcessingRun) {
  insertRun(run);
  publishAppEvent("run", { id: run.id, status: run.status });
}

export function markInterruptedRuns() {
  const runningRuns = (db.prepare("SELECT data FROM runs WHERE status = ?").all("running") as SqlRow[]).map(rowToRun);
  const now = new Date().toISOString();
  for (const run of runningRuns) {
    run.status = "failed";
    run.finishedAt = now;
    run.currentStage = "服务重启后已中断";
    run.errors.push("服务重启，上一轮处理任务已中断。");
    insertRun(run);
  }
  if (runningRuns.length) publishAppEvent("run", { interruptedCount: runningRuns.length });
  return runningRuns.length;
}

export function hasInterruptedRecoveryRetry() {
  return readMailboxes().some((mailbox) => mailbox.lastError?.includes("中断恢复扫描超时"));
}

export function updateMailboxSync(id: string, patch: Partial<Pick<Mailbox, "lastSyncAt" | "lastError">>) {
  const mailbox = readMailboxes().find((item) => item.id === id);
  if (!mailbox) return;
  insertMailbox({
    ...mailbox,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  publishAppEvent("mailboxes", { id });
}

export function queryProcessedEmails(options: {
  category?: string;
  mailboxId?: string;
  q?: string;
  since?: string;
  until?: string;
  offset?: number;
  limit?: number;
}) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const allowedCategories = new Set(["important", "secondary", "ignore"]);

  if (options.category && allowedCategories.has(options.category)) {
    where.push("category = ?");
    params.push(options.category);
  }
  if (options.mailboxId && options.mailboxId !== "all") {
    where.push("mailboxId = ?");
    params.push(options.mailboxId);
  }
  if (options.q?.trim()) {
    const matchQuery = ftsMatchQuery(options.q);
    if (matchQuery) {
      where.push("id IN (SELECT emailId FROM email_fts WHERE email_fts MATCH ?)");
      params.push(matchQuery);
    } else {
      where.push("(subject LIKE ? OR fromName LIKE ? OR fromAddress LIKE ? OR summaryZh LIKE ? OR data LIKE ?)");
      const query = `%${options.q.trim()}%`;
      params.push(query, query, query, query, query);
    }
  }
  if (options.since) {
    where.push("COALESCE(receivedAt, processedAt) >= ?");
    params.push(options.since);
  }
  if (options.until) {
    where.push("COALESCE(receivedAt, processedAt) < ?");
    params.push(options.until);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM emails ${whereSql}`).get(...params) as SqlRow;
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 40)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = db
    .prepare(`SELECT data FROM emails ${whereSql} ORDER BY ${EMAIL_DISPLAY_RECEIVED_ORDER_SQL} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SqlRow[];

  const total = Number(totalRow.total ?? 0);
  return {
    items: rows.map(rowToEmail),
    total,
    offset,
    limit,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + rows.length < total
  };
}

export function getEmailStats(options: {
  mailboxId?: string;
  since?: string;
  until?: string;
} = {}) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (options.mailboxId && options.mailboxId !== "all") {
    where.push("mailboxId = ?");
    params.push(options.mailboxId);
  }
  if (options.since) {
    where.push("COALESCE(receivedAt, processedAt) >= ?");
    params.push(options.since);
  }
  if (options.until) {
    where.push("COALESCE(receivedAt, processedAt) < ?");
    params.push(options.until);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const counts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  const unreadCounts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${whereSql} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    counts[row.category as MailCategory] = Number(row.total ?? 0);
  }
  const unreadWhereSql = `${whereSql}${whereSql ? " AND" : "WHERE"} panelRead = 0`;
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${unreadWhereSql} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    unreadCounts[row.category as MailCategory] = Number(row.total ?? 0);
  }

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS total FROM emails ${whereSql}`).get(...params) as SqlRow).total ?? 0
  );
  const unreadTotal = Number(
    (db.prepare(`SELECT COUNT(*) AS total FROM emails ${unreadWhereSql}`).get(...params) as SqlRow).total ?? 0
  );
  return { counts, unreadCounts, total, unreadTotal };
}

export function getDashboardData(mailboxId?: string) {
  const selectedMailbox = mailboxId && mailboxId !== "all" ? mailboxId : undefined;
  const whereSql = selectedMailbox ? "WHERE mailboxId = ?" : "";
  const params = selectedMailbox ? [selectedMailbox] : [];

  const counts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  const unreadCounts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${whereSql} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    counts[row.category as MailCategory] = Number(row.total ?? 0);
  }
  const unreadWhere = `${whereSql}${whereSql ? " AND" : "WHERE"} panelRead = 0`;
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${unreadWhere} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    unreadCounts[row.category as MailCategory] = Number(row.total ?? 0);
  }

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS total FROM emails ${whereSql}`).get(...params) as SqlRow).total ?? 0
  );
  const allTotal = Number((db.prepare("SELECT COUNT(*) AS total FROM emails").get() as SqlRow).total ?? 0);
  const recentEmails = (
    db.prepare(`SELECT data FROM emails ${whereSql} ORDER BY ${EMAIL_DISPLAY_RECEIVED_ORDER_SQL} LIMIT 8`).all(...params) as SqlRow[]
  ).map(rowToEmail);
  const currentRunRow = db
    .prepare("SELECT data FROM runs WHERE status = ? ORDER BY startedAt DESC LIMIT 1")
    .get("running") as SqlRow | undefined;

  return {
    state: {
      settings: getSettings(),
      mailboxes: getAllMailboxes(),
      runs: getRuns(10)
    },
    counts,
    unreadCounts,
    total,
    allTotal,
    recentEmails,
    currentRun: currentRunRow ? rowToRun(currentRunRow) : null
  };
}

export function getMaxProcessedUid(mailboxId: string) {
  const rows = db.prepare("SELECT externalUid FROM emails WHERE mailboxId = ?").all(mailboxId) as SqlRow[];
  let max = 0;
  for (const row of rows) {
    const uid = Number(row.externalUid);
    if (Number.isFinite(uid) && uid > max) max = uid;
  }
  return max;
}

export function getPendingNotificationEmails(limit = 20) {
  return (
    db
      .prepare(
        `SELECT data FROM emails
         WHERE COALESCE(notificationError, '') <> '' AND notifiedAt IS NULL
         ORDER BY ${EMAIL_QUEUE_RECEIVED_ORDER_SQL}
         LIMIT ?`
      )
      .all(limit) as SqlRow[]
  ).map(rowToEmail);
}

export function recordProcessingEvent(input: {
  runId?: string;
  mailboxId?: string;
  emailId?: string;
  subject?: string;
  stage: string;
  status: string;
  message?: string;
}) {
  const event = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input
  };
  db.prepare(
    `INSERT INTO processing_events (id, runId, mailboxId, emailId, subject, stage, status, message, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.runId ?? null,
    event.mailboxId ?? null,
    event.emailId ?? null,
    event.subject ?? null,
    event.stage,
    event.status,
    event.message ?? null,
    event.createdAt
  );
  publishAppEvent("processing-event", event);
  return event;
}

const sensitiveAgentDataKeys = new Set([
  "apiKey",
  "appSecret",
  "authorization",
  "bodyExcerpt",
  "contentBase64",
  "originalHtml",
  "originalText",
  "password",
  "rawSource",
  "textExcerpt",
  "token"
]);

function redactAgentLogText(value: string, limit: number) {
  return value
    .replace(/\b(api[_ -]?key|app[_ -]?secret|password|token|authorization)\s*[:=：]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function sanitizeAgentEventData(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 320);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAgentEventData(item, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, entry]) => [
        key.slice(0, 80),
        sensitiveAgentDataKeys.has(key) ? "[REDACTED]" : sanitizeAgentEventData(entry, depth + 1)
      ])
  );
}

function maskAgentUser(userOpenId: string) {
  if (userOpenId.length <= 8) return "****";
  return `${userOpenId.slice(0, 4)}...${userOpenId.slice(-4)}`;
}

function rowToQqAgentEvent(row: SqlRow): QqAgentEvent {
  return {
    id: String(row.id),
    runId: row.runId ? String(row.runId) : undefined,
    kind: String(row.kind),
    toolName: row.toolName ? String(row.toolName) : undefined,
    status: String(row.status),
    message: row.message ? String(row.message) : undefined,
    data: row.data ? parseJson<unknown>(row.data) : {},
    step: row.step === null || row.step === undefined ? undefined : Number(row.step),
    durationMs: row.durationMs === null || row.durationMs === undefined ? undefined : Number(row.durationMs),
    createdAt: String(row.createdAt)
  };
}

export function startQqAgentRun(input: { userOpenId: string; message: string }) {
  const run = {
    id: randomUUID(),
    userOpenId: input.userOpenId,
    status: "running" as QqAgentRunStatus,
    message: redactAgentLogText(input.message, 600),
    startedAt: new Date().toISOString()
  };
  db.prepare(
    `INSERT INTO qq_agent_runs (id, userOpenId, status, message, startedAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(run.id, run.userOpenId, run.status, run.message, run.startedAt);
  publishAppEvent("qq-agent-run", { id: run.id, status: run.status, startedAt: run.startedAt });
  return run;
}

export function finishQqAgentRun(
  id: string,
  input: { status: Exclude<QqAgentRunStatus, "running">; reply?: string; error?: string }
) {
  const row = db.prepare("SELECT startedAt FROM qq_agent_runs WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(String(row.startedAt)));
  const counts = db.prepare(
    `SELECT COALESCE(MAX(step), 0) AS stepCount,
            SUM(CASE WHEN kind = 'tool' AND status <> 'pending' THEN 1 ELSE 0 END) AS toolCallCount
     FROM qq_agent_events WHERE runId = ?`
  ).get(id) as SqlRow;
  db.prepare(
    `UPDATE qq_agent_runs
     SET status = ?, reply = ?, error = ?, finishedAt = ?, durationMs = ?, stepCount = ?, toolCallCount = ?
     WHERE id = ?`
  ).run(
    input.status,
    input.reply ? redactAgentLogText(input.reply, 600) : null,
    input.error ? redactAgentLogText(input.error, 400) : null,
    finishedAt,
    durationMs,
    Number(counts.stepCount ?? 0),
    Number(counts.toolCallCount ?? 0),
    id
  );

  const staleRuns = db.prepare("SELECT id FROM qq_agent_runs ORDER BY startedAt DESC LIMIT -1 OFFSET 200").all() as SqlRow[];
  for (const stale of staleRuns) {
    db.prepare("DELETE FROM qq_agent_events WHERE runId = ?").run(String(stale.id));
    db.prepare("DELETE FROM qq_agent_runs WHERE id = ?").run(String(stale.id));
  }
  publishAppEvent("qq-agent-run", { id, status: input.status, finishedAt, durationMs });
  return { id, status: input.status, finishedAt, durationMs };
}

export function readQqAgentRuns(limit = 12): QqAgentRun[] {
  const boundedLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const rows = db.prepare("SELECT * FROM qq_agent_runs ORDER BY startedAt DESC LIMIT ?").all(boundedLimit) as SqlRow[];
  const eventsStatement = db.prepare("SELECT * FROM qq_agent_events WHERE runId = ? ORDER BY createdAt ASC, id ASC");
  return rows.map((row) => ({
    id: String(row.id),
    status: String(row.status) as QqAgentRunStatus,
    maskedUser: maskAgentUser(String(row.userOpenId)),
    message: String(row.message),
    reply: row.reply ? String(row.reply) : undefined,
    error: row.error ? String(row.error) : undefined,
    startedAt: String(row.startedAt),
    finishedAt: row.finishedAt ? String(row.finishedAt) : undefined,
    durationMs: row.durationMs === null || row.durationMs === undefined ? undefined : Number(row.durationMs),
    stepCount: Number(row.stepCount ?? 0),
    toolCallCount: Number(row.toolCallCount ?? 0),
    events: (eventsStatement.all(String(row.id)) as SqlRow[]).map(rowToQqAgentEvent)
  }));
}

export function recordQqAgentEvent(input: {
  userOpenId: string;
  runId?: string;
  kind: string;
  status: string;
  toolName?: string;
  message?: string;
  data?: unknown;
  step?: number;
  durationMs?: number;
}) {
  const event = {
    id: randomUUID(),
    runId: input.runId,
    userOpenId: input.userOpenId,
    kind: input.kind.slice(0, 64),
    toolName: input.toolName?.slice(0, 80),
    status: input.status.slice(0, 32),
    message: input.message ? redactAgentLogText(input.message, 240) : undefined,
    data: sanitizeAgentEventData(input.data ?? {}),
    step: input.step,
    durationMs: input.durationMs,
    createdAt: new Date().toISOString()
  };
  db.prepare(
    `INSERT INTO qq_agent_events (id, runId, userOpenId, kind, toolName, status, message, data, step, durationMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.runId ?? null,
    event.userOpenId,
    event.kind,
    event.toolName ?? null,
    event.status,
    event.message ?? null,
    JSON.stringify(event.data).slice(0, 12000),
    event.step ?? null,
    event.durationMs ?? null,
    event.createdAt
  );
  publishAppEvent("qq-agent", {
    kind: event.kind,
    status: event.status,
    toolName: event.toolName,
    runId: event.runId,
    createdAt: event.createdAt
  });
  return event;
}

function rowToNotificationDelivery(row: SqlRow): NotificationDelivery {
  return {
    id: String(row.id),
    emailId: String(row.emailId),
    channel: String(row.channel) as NotificationChannel,
    bypassCategoryFilter: Number(row.bypassCategoryFilter ?? 0) === 1,
    status: String(row.status) as NotificationDeliveryStatus,
    attemptCount: Number(row.attemptCount),
    nextAttemptAt: row.nextAttemptAt ? String(row.nextAttemptAt) : undefined,
    sentAt: row.sentAt ? String(row.sentAt) : undefined,
    lastError: row.lastError ? String(row.lastError) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

function rowToNotificationSummary(row: SqlRow): EmailNotificationStatusSummary {
  return {
    channel: String(row.channel) as NotificationChannel,
    status: String(row.status) as NotificationDeliveryStatus,
    attemptCount: Number(row.attemptCount ?? 0),
    nextAttemptAt: row.nextAttemptAt ? String(row.nextAttemptAt) : undefined,
    sentAt: row.sentAt ? String(row.sentAt) : undefined,
    lastError: row.lastError ? String(row.lastError) : undefined
  };
}

function notificationDeliveryListItem(row: SqlRow): NotificationDeliveryListItem {
  const delivery = rowToNotificationDelivery(row);
  if (!row.emailData) return delivery;
  const email = rowToEmail({ data: row.emailData });
  return {
    ...delivery,
    email: {
      id: email.id,
      mailboxId: email.mailboxId,
      mailboxName: row.mailboxData ? rowToMailbox({ data: row.mailboxData }).name : "未知邮箱",
      subject: email.subject,
      fromName: email.fromName,
      fromAddress: email.fromAddress,
      receivedAt: email.receivedAt,
      processedAt: email.processedAt,
      category: email.category,
      summaryZh: email.summaryZh,
      panelRead: email.panelRead ?? email.category === "ignore",
      readMarked: email.readMarked
    }
  };
}

export function getEmailNotificationSummary(emailId: string, channel: NotificationChannel) {
  const row = db
    .prepare("SELECT channel, status, attemptCount, nextAttemptAt, sentAt, lastError FROM notification_deliveries WHERE emailId = ? AND channel = ? LIMIT 1")
    .get(emailId, channel) as SqlRow | undefined;
  return row ? rowToNotificationSummary(row) : undefined;
}

function safeUsageInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function usageTotalsFromRow(row: SqlRow | undefined): AiUsageTotals {
  const inputTokens = safeUsageInteger(row?.inputTokens);
  const cachedInputTokens = safeUsageInteger(row?.cachedInputTokens);
  return {
    calls: safeUsageInteger(row?.calls),
    successfulCalls: safeUsageInteger(row?.successfulCalls),
    failedCalls: safeUsageInteger(row?.failedCalls),
    usageReportedCalls: safeUsageInteger(row?.usageReportedCalls),
    inputTokens,
    outputTokens: safeUsageInteger(row?.outputTokens),
    cachedInputTokens,
    cacheWriteTokens: safeUsageInteger(row?.cacheWriteTokens),
    totalTokens: safeUsageInteger(row?.totalTokens),
    cacheHitRate: inputTokens > 0 ? Math.min(1, cachedInputTokens / inputTokens) : 0
  };
}

const usageAggregateSql = `
  COUNT(*) AS calls,
  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successfulCalls,
  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failedCalls,
  SUM(CASE WHEN usageReported = 1 THEN 1 ELSE 0 END) AS usageReportedCalls,
  COALESCE(SUM(inputTokens), 0) AS inputTokens,
  COALESCE(SUM(outputTokens), 0) AS outputTokens,
  COALESCE(SUM(cachedInputTokens), 0) AS cachedInputTokens,
  COALESCE(SUM(cacheWriteTokens), 0) AS cacheWriteTokens,
  COALESCE(SUM(totalTokens), 0) AS totalTokens
`;

export function recordAiUsageEvent(input: AiUsageEventInput) {
  const occurredAt = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt))
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString();
  const saved = {
    ...input,
    id: randomUUID(),
    occurredAt,
    provider: input.provider.trim().slice(0, 120) || "未命名服务",
    model: input.model.trim().slice(0, 160) || "未知模型",
    inputTokens: safeUsageInteger(input.inputTokens),
    outputTokens: safeUsageInteger(input.outputTokens),
    cachedInputTokens: safeUsageInteger(input.cachedInputTokens),
    cacheWriteTokens: safeUsageInteger(input.cacheWriteTokens),
    totalTokens: safeUsageInteger(input.totalTokens),
    latencyMs: safeUsageInteger(input.latencyMs),
    requestId: input.requestId?.slice(0, 200),
    error: input.error?.replace(/\s+/g, " ").trim().slice(0, 300)
  };

  db.prepare(
    `INSERT INTO ai_usage_events (
      id, occurredAt, scope, purpose, provider, protocol, model,
      inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, totalTokens,
      usageReported, success, latencyMs, requestId, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    saved.id,
    saved.occurredAt,
    saved.scope,
    saved.purpose,
    saved.provider,
    saved.protocol,
    saved.model,
    saved.inputTokens,
    saved.outputTokens,
    saved.cachedInputTokens,
    saved.cacheWriteTokens,
    saved.totalTokens,
    bool(saved.usageReported),
    bool(saved.success),
    saved.latencyMs,
    saved.requestId ?? null,
    saved.error ?? null
  );
  publishAppEvent("ai-usage", { id: saved.id, scope: saved.scope });
  return clone(saved);
}

function aiUsageWhere(startAt?: string, endAt?: string) {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (startAt) {
    clauses.push("occurredAt >= ?");
    params.push(startAt);
  }
  if (endAt) {
    clauses.push("occurredAt < ?");
    params.push(endAt);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function validTimeZone(value?: string) {
  const fallback = "UTC";
  if (!value) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return fallback;
  }
}

function timelineBucket(value: string, range: AiUsageRange, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(range === "today" ? { hour: "2-digit", hourCycle: "h23" as const } : {})
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  if (range === "today") return `${day}T${part("hour")}`;
  if (range === "all") return day.slice(0, 7);
  return day;
}

function readBillingProvider(): AiBillingProvider {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("ai.billing") as SqlRow | undefined;
  if (!row) return "none";
  try {
    const parsed = parseJson<{ provider?: unknown }>(row.value);
    return parsed.provider === "openai" || parsed.provider === "anthropic" ? parsed.provider : "none";
  } catch {
    return "none";
  }
}

function billingCredentialKey(provider: Exclude<AiBillingProvider, "none">) {
  return `ai-billing-${provider}-admin-key`;
}

export function publicAiBillingSettings() {
  const provider = readBillingProvider();
  const envelope = provider === "none" ? "" : readStoredCredentialEnvelope(billingCredentialKey(provider));
  return {
    provider,
    hasAdminKey: Boolean(envelope),
    maskedAdminKey: envelope ? "已安全保存" : ""
  };
}

export function updateAiBillingSettings(input: { provider: AiBillingProvider; adminKey?: string }) {
  const provider = input.provider;
  const adminKey = input.adminKey?.trim() ?? "";
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "ai.billing",
      JSON.stringify({ provider })
    );
    if (provider !== "none" && adminKey) {
      db.prepare("INSERT OR REPLACE INTO credentials (key, envelope, updatedAt) VALUES (?, ?, ?)").run(
        billingCredentialKey(provider),
        encryptCredential(adminKey),
        now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  publishAppEvent("settings", { key: "ai.billing" });
  return publicAiBillingSettings();
}

export function readAiBillingAdminKey(provider: Exclude<AiBillingProvider, "none">) {
  const envelope = readStoredCredentialEnvelope(billingCredentialKey(provider));
  return envelope ? decryptCredential(envelope) : "";
}

export function saveAiCostSnapshot(snapshot: AiCostSnapshot) {
  db.prepare(
    `INSERT OR REPLACE INTO ai_cost_snapshots (
      id, provider, rangeKey, startAt, endAt, queriedAt, data
    ) VALUES (
      COALESCE((SELECT id FROM ai_cost_snapshots WHERE provider = ? AND rangeKey = ?), ?),
      ?, ?, ?, ?, ?, ?
    )`
  ).run(
    snapshot.provider,
    snapshot.range,
    randomUUID(),
    snapshot.provider,
    snapshot.range,
    snapshot.startAt,
    snapshot.endAt,
    snapshot.queriedAt,
    JSON.stringify(snapshot)
  );
  publishAppEvent("ai-usage", { billing: snapshot.provider, range: snapshot.range });
  return clone(snapshot);
}

function latestAiCostSnapshot(provider: AiBillingProvider, range: AiUsageRange) {
  if (provider === "none") return undefined;
  const row = db.prepare(
    "SELECT data FROM ai_cost_snapshots WHERE provider = ? AND rangeKey = ? LIMIT 1"
  ).get(provider, range) as SqlRow | undefined;
  return row ? parseJson<AiCostSnapshot>(row.data) : undefined;
}

export function firstAiUsageOccurredAt() {
  const row = db.prepare("SELECT MIN(occurredAt) AS occurredAt FROM ai_usage_events").get() as SqlRow;
  return typeof row.occurredAt === "string" ? row.occurredAt : undefined;
}

export function queryAiUsageDashboard(input: {
  range: AiUsageRange;
  startAt?: string;
  endAt: string;
  timeZone?: string;
  recentLimit?: number;
}): AiUsageDashboard {
  const { sql: whereSql, params } = aiUsageWhere(input.startAt, input.endAt);
  const totalRow = db.prepare(`SELECT ${usageAggregateSql} FROM ai_usage_events ${whereSql}`).get(...params) as SqlRow;
  const totals = usageTotalsFromRow(totalRow);

  const scopeRows = db.prepare(
    `SELECT scope, ${usageAggregateSql} FROM ai_usage_events ${whereSql} GROUP BY scope`
  ).all(...params) as SqlRow[];
  const scopeMap = new Map(scopeRows.map((row) => [String(row.scope), usageTotalsFromRow(row)]));
  const scopes: AiUsageScope[] = ["email", "agent", "system"];
  const byScope: AiUsageScopeBreakdown[] = scopes.map((scope) => ({
    scope,
    ...(scopeMap.get(scope) ?? usageTotalsFromRow(undefined))
  }));

  const modelRows = db.prepare(
    `SELECT provider, protocol, model, ${usageAggregateSql}
     FROM ai_usage_events ${whereSql}
     GROUP BY provider, protocol, model
     ORDER BY totalTokens DESC, calls DESC, provider ASC, model ASC`
  ).all(...params) as SqlRow[];
  const byModel: AiUsageModelBreakdown[] = modelRows.map((row) => ({
    key: `${String(row.provider)}\u0000${String(row.protocol)}\u0000${String(row.model)}`,
    provider: String(row.provider),
    protocol: String(row.protocol) as AiUsageModelBreakdown["protocol"],
    model: String(row.model),
    ...usageTotalsFromRow(row)
  }));

  const timeZone = validTimeZone(input.timeZone);
  const timelineRows = db.prepare(
    `SELECT occurredAt, totalTokens FROM ai_usage_events ${whereSql} ORDER BY occurredAt ASC`
  ).all(...params) as SqlRow[];
  const timelineMap = new Map<string, AiUsageTimelinePoint>();
  for (const row of timelineRows) {
    const bucket = timelineBucket(String(row.occurredAt), input.range, timeZone);
    const current = timelineMap.get(bucket) ?? { bucket, calls: 0, totalTokens: 0 };
    current.calls += 1;
    current.totalTokens += safeUsageInteger(row.totalTokens);
    timelineMap.set(bucket, current);
  }

  const recentLimit = Math.min(100, Math.max(1, Math.floor(input.recentLimit ?? 30)));
  const recentRows = db.prepare(
    `SELECT * FROM ai_usage_events ${whereSql} ORDER BY occurredAt DESC, id DESC LIMIT ?`
  ).all(...params, recentLimit) as SqlRow[];
  const recent = recentRows.map((row) => ({
    id: String(row.id),
    occurredAt: String(row.occurredAt),
    scope: String(row.scope) as AiUsageEventInput["scope"],
    purpose: String(row.purpose) as AiUsageEventInput["purpose"],
    provider: String(row.provider),
    protocol: String(row.protocol) as AiUsageEventInput["protocol"],
    model: String(row.model),
    inputTokens: safeUsageInteger(row.inputTokens),
    outputTokens: safeUsageInteger(row.outputTokens),
    cachedInputTokens: safeUsageInteger(row.cachedInputTokens),
    cacheWriteTokens: safeUsageInteger(row.cacheWriteTokens),
    totalTokens: safeUsageInteger(row.totalTokens),
    usageReported: parseBool(row.usageReported),
    success: parseBool(row.success),
    latencyMs: safeUsageInteger(row.latencyMs),
    requestId: typeof row.requestId === "string" ? row.requestId : undefined,
    error: typeof row.error === "string" ? row.error : undefined
  }));
  const billingSettings = publicAiBillingSettings();

  return {
    range: input.range,
    startAt: input.startAt,
    endAt: input.endAt,
    generatedAt: new Date().toISOString(),
    totals,
    byScope,
    byModel,
    timeline: [...timelineMap.values()],
    recent,
    billing: {
      settings: billingSettings,
      latestCost: latestAiCostSnapshot(billingSettings.provider, input.range)
    }
  };
}

export function readStoredCredentialEnvelope(key: string) {
  const row = db.prepare("SELECT envelope FROM credentials WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? String(row.envelope) : "";
}

export function storeCredentialEnvelope(key: string, envelope: string) {
  db.prepare("INSERT OR REPLACE INTO credentials (key, envelope, updatedAt) VALUES (?, ?, ?)").run(
    key,
    envelope,
    new Date().toISOString()
  );
}

function readStoredQqBotSettings(): QqBotConfig {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("notification.qq") as SqlRow | undefined;
  const saved = row ? parseJson<Partial<QqBotConfig>>(row.value) : {};
  return {
    ...defaultQqBotConfig,
    ...saved,
    encryptedAppSecret: readStoredCredentialEnvelope("qq-app-secret"),
    notifyCategories: {
      ...defaultNotifyCategories,
      ...saved.notifyCategories
    },
    agent: normalizeQqAgentSettings(saved.agent)
  };
}

export function readQqBotConfig(): QqBotConfig {
  return clone(readStoredQqBotSettings());
}

export function publicQqBotSettings(config: QqBotConfig): PublicQqBotSettings {
  return {
    appId: config.appId,
    enabled: config.enabled,
    notifyCategories: clone(config.notifyCategories),
    quoteImageMarksRead: config.quoteImageMarksRead,
    agent: clone(normalizeQqAgentSettings(config.agent)),
    hasAppSecret: Boolean(config.encryptedAppSecret),
    maskedAppSecret: config.encryptedAppSecret ? "configured" : ""
  };
}

export function updateQqBotSettings(input: QqBotSettingsInput): PublicQqBotSettings {
  const current = readStoredQqBotSettings();
  const notifyCategories = {
    ...defaultNotifyCategories,
    ...current.notifyCategories,
    ...input.notifyCategories
  };
  const hasNewAppSecret = typeof input.appSecret === "string" && Boolean(input.appSecret.trim());
  const encryptedAppSecret = hasNewAppSecret ? encryptCredential(input.appSecret!) : current.encryptedAppSecret;
  const next: QqBotConfig = {
    appId: input.appId ?? current.appId,
    enabled: input.enabled ?? current.enabled,
    notifyCategories,
    quoteImageMarksRead: input.quoteImageMarksRead ?? current.quoteImageMarksRead,
    agent: normalizeQqAgentSettings({
      ...current.agent,
      ...input.agent,
      permissions: {
        ...current.agent.permissions,
        ...input.agent?.permissions
      }
    }),
    encryptedAppSecret
  };
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    if (hasNewAppSecret) {
      db.prepare("INSERT OR REPLACE INTO credentials (key, envelope, updatedAt) VALUES (?, ?, ?)").run(
        "qq-app-secret",
        encryptedAppSecret,
        now
      );
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "notification.qq",
      JSON.stringify({ ...next, encryptedAppSecret: "" })
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  publishAppEvent("settings", { key: "notification.qq" });
  return publicQqBotSettings(next);
}

export function readQqState<T>(key: string): T | undefined {
  const row = db.prepare("SELECT value FROM qq_state WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? clone(parseJson<T>(row.value)) : undefined;
}

export function updateQqState<T>(key: string, value: T) {
  db.prepare("INSERT OR REPLACE INTO qq_state (key, value, updatedAt) VALUES (?, ?, ?)").run(
    key,
    JSON.stringify(value),
    new Date().toISOString()
  );
}

export function readQqGatewayState(): QqGatewayState | undefined {
  return readQqState<QqGatewayState>("gateway");
}

export function updateQqGatewayState(state: Omit<QqGatewayState, "updatedAt">): QqGatewayState {
  const next = { ...state, updatedAt: new Date().toISOString() };
  updateQqState("gateway", next);
  return next;
}

export function readQqBotBindings() {
  return (db.prepare("SELECT value FROM qq_state WHERE key LIKE ? ORDER BY key ASC").all("binding:%") as SqlRow[]).map((row) =>
    parseJson<QqBotBinding>(row.value)
  );
}

export function upsertQqBotBinding(input: Omit<QqBotBinding, "createdAt" | "updatedAt">): QqBotBinding {
  const existing = readQqState<QqBotBinding>(`binding:${input.id}`);
  const now = new Date().toISOString();
  const next: QqBotBinding = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now };
  updateQqState(`binding:${input.id}`, next);
  return next;
}

export function consumeQqBindingChallenge(
  challengeKey: string,
  challengeId: string,
  input: Omit<QqBotBinding, "createdAt" | "updatedAt">,
  consumedAt: string
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const challenge = readQqState<{
      id: string;
      expiresAt: string;
      consumedAt?: string;
      [key: string]: unknown;
    }>(challengeKey);
    if (!challenge || challenge.id !== challengeId || challenge.consumedAt || challenge.expiresAt <= consumedAt) {
      db.exec("ROLLBACK");
      return undefined;
    }

    const existing = readQqState<QqBotBinding>(`binding:${input.id}`);
    const next: QqBotBinding = {
      ...input,
      createdAt: existing?.createdAt ?? consumedAt,
      updatedAt: consumedAt
    };
    db.prepare("INSERT OR REPLACE INTO qq_state (key, value, updatedAt) VALUES (?, ?, ?)").run(
      challengeKey,
      JSON.stringify({ ...challenge, consumedAt }),
      consumedAt
    );
    db.prepare("INSERT OR REPLACE INTO qq_state (key, value, updatedAt) VALUES (?, ?, ?)").run(
      `binding:${input.id}`,
      JSON.stringify(next),
      consumedAt
    );
    db.exec("COMMIT");
    publishAppEvent("qq-binding", { bound: true, updatedAt: consumedAt });
    return next;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToQqNotificationReference(row: SqlRow): QqNotificationReference {
  return {
    emailId: String(row.emailId),
    userOpenId: String(row.userOpenId),
    messageId: row.messageId ? String(row.messageId) : undefined,
    refIndex: row.refIndex ? String(row.refIndex) : undefined,
    createdAt: String(row.createdAt)
  };
}

export function recordQqNotificationReference(input: {
  emailId: string;
  userOpenId: string;
  messageId?: string;
  refIndex?: string;
}) {
  const messageId = input.messageId?.trim() || undefined;
  const refIndex = input.refIndex?.trim() || undefined;
  if (!input.emailId.trim() || !input.userOpenId.trim() || (!messageId && !refIndex)) return undefined;
  const reference: QqNotificationReference = {
    emailId: input.emailId,
    userOpenId: input.userOpenId,
    ...(messageId ? { messageId } : {}),
    ...(refIndex ? { refIndex } : {}),
    createdAt: new Date().toISOString()
  };
  db.prepare(
    "INSERT OR REPLACE INTO qq_notification_refs " +
    "(id, emailId, userOpenId, messageId, refIndex, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    randomUUID(),
    reference.emailId,
    reference.userOpenId,
    reference.messageId ?? null,
    reference.refIndex ?? null,
    reference.createdAt
  );
  return reference;
}

export function findQqNotificationReference(input: {
  userOpenId: string;
  messageId?: string;
  refIndex?: string;
}) {
  const userOpenId = input.userOpenId.trim();
  if (!userOpenId) return undefined;
  const candidates: Array<["refIndex" | "messageId", string]> = [];
  if (input.refIndex?.trim()) candidates.push(["refIndex", input.refIndex.trim()]);
  if (input.messageId?.trim()) candidates.push(["messageId", input.messageId.trim()]);
  for (const [column, value] of candidates) {
    const row = db.prepare(
      "SELECT * FROM qq_notification_refs WHERE userOpenId = ? AND " + column + " = ? LIMIT 1"
    ).get(userOpenId, value) as SqlRow | undefined;
    if (row) return rowToQqNotificationReference(row);
  }
  return undefined;
}

function rowToQqEmailReadAction(row: SqlRow): QqEmailReadAction {
  return {
    token: String(row.token),
    emailId: String(row.emailId),
    userOpenId: String(row.userOpenId),
    messageId: row.messageId ? String(row.messageId) : undefined,
    refIndex: row.refIndex ? String(row.refIndex) : undefined,
    usedAt: row.usedAt ? String(row.usedAt) : undefined,
    createdAt: String(row.createdAt)
  };
}

export function createQqEmailReadAction(input: { emailId: string; userOpenId: string }) {
  const token = randomUUID().replaceAll("-", "");
  const action: QqEmailReadAction = {
    token,
    emailId: input.emailId,
    userOpenId: input.userOpenId,
    createdAt: new Date().toISOString()
  };
  db.prepare("DELETE FROM qq_email_read_actions WHERE createdAt < ?").run(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  );
  db.prepare(
    "INSERT INTO qq_email_read_actions (token, emailId, userOpenId, createdAt) VALUES (?, ?, ?, ?)"
  ).run(action.token, action.emailId, action.userOpenId, action.createdAt);
  return action;
}

export function finalizeQqEmailReadAction(
  token: string,
  input: { messageId?: string; refIndex?: string }
) {
  db.prepare(
    "UPDATE qq_email_read_actions SET messageId = ?, refIndex = ? WHERE token = ?"
  ).run(input.messageId ?? null, input.refIndex ?? null, token);
}

export function deleteQqEmailReadAction(token: string) {
  db.prepare("DELETE FROM qq_email_read_actions WHERE token = ?").run(token);
}

export function findQqEmailReadAction(token: string, userOpenId: string) {
  const row = db.prepare(
    "SELECT * FROM qq_email_read_actions WHERE token = ? AND userOpenId = ? LIMIT 1"
  ).get(token, userOpenId) as SqlRow | undefined;
  return row ? rowToQqEmailReadAction(row) : undefined;
}

export function markQqEmailReadActionUsed(token: string) {
  const usedAt = new Date().toISOString();
  db.prepare("UPDATE qq_email_read_actions SET usedAt = COALESCE(usedAt, ?) WHERE token = ?").run(usedAt, token);
  return usedAt;
}

export function rememberQqEvent(eventId: string, expiresAt: string) {
  const result = db.prepare(
    "INSERT OR IGNORE INTO qq_event_dedupe (eventId, receivedAt, expiresAt) VALUES (?, ?, ?)"
  ).run(eventId, new Date().toISOString(), expiresAt) as { changes?: number };
  return Number(result.changes ?? 0) > 0;
}

export function deleteExpiredQqEvents(now = new Date().toISOString()) {
  return db.prepare("DELETE FROM qq_event_dedupe WHERE expiresAt <= ?").run(now) as { changes?: number };
}

function publishNotificationDeliveryStatus(channel: NotificationChannel, status: NotificationDeliveryStatus) {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM notification_deliveries WHERE channel = ? AND status IN ('pending', 'sending', 'retry')"
  ).get(channel) as { count?: number } | undefined;
  publishAppEvent("notification-delivery", {
    channel,
    status,
    pendingCount: Number(row?.count ?? 0)
  });
}

export function enqueueNotificationDelivery(
  emailId: string,
  channel: NotificationChannel,
  options: { bypassCategoryFilter?: boolean } = {}
): NotificationDelivery {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO notification_deliveries (
      id, emailId, channel, bypassCategoryFilter, status, attemptCount, nextAttemptAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
  ).run(randomUUID(), emailId, channel, options.bypassCategoryFilter ? 1 : 0, now, now, now);
  if (options.bypassCategoryFilter) {
    db.prepare(
      "UPDATE notification_deliveries SET bypassCategoryFilter = 1, updatedAt = ? WHERE emailId = ? AND channel = ?"
    ).run(now, emailId, channel);
  }
  const delivery = getNotificationDelivery(emailId, channel)!;
  publishNotificationDeliveryStatus(channel, delivery.status);
  return delivery;
}

export function getNotificationDelivery(emailId: string, channel: NotificationChannel) {
  const row = db
    .prepare("SELECT * FROM notification_deliveries WHERE emailId = ? AND channel = ?")
    .get(emailId, channel) as SqlRow | undefined;
  return row ? rowToNotificationDelivery(row) : undefined;
}

export function listNotificationDeliveries(options: { emailId?: string; status?: NotificationDeliveryStatus } = {}) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (options.emailId) {
    where.push("notification_deliveries.emailId = ?");
    params.push(options.emailId);
  }
  if (options.status) {
    where.push("notification_deliveries.status = ?");
    params.push(options.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return (db
    .prepare(
      `SELECT notification_deliveries.*
       FROM notification_deliveries
       LEFT JOIN emails ON emails.id = notification_deliveries.emailId
       ${whereSql}
       ORDER BY ${NOTIFICATION_DELIVERY_RECEIVED_ORDER_SQL}`
    )
    .all(...params) as SqlRow[]).map(rowToNotificationDelivery);
}

export function queryNotificationDeliveries(options: {
  channel?: NotificationChannel;
  status?: NotificationDeliveryStatus | "failed";
  offset?: number;
  limit?: number;
}) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (options.channel) {
    where.push("notification_deliveries.channel = ?");
    params.push(options.channel);
  }
  if (options.status === "failed") {
    where.push("notification_deliveries.status IN ('retry', 'paused')");
  } else if (options.status) {
    where.push("notification_deliveries.status = ?");
    params.push(options.status);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM notification_deliveries
       LEFT JOIN emails ON emails.id = notification_deliveries.emailId
       ${whereSql}`
    )
    .get(...params) as SqlRow;
  const limit = Math.min(100, Math.max(10, Math.floor(options.limit ?? 40)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = db
    .prepare(
      `SELECT notification_deliveries.*, emails.data AS emailData, mailboxes.data AS mailboxData
       FROM notification_deliveries
       LEFT JOIN emails ON emails.id = notification_deliveries.emailId
       LEFT JOIN mailboxes ON mailboxes.id = emails.mailboxId
       ${whereSql}
       ORDER BY ${NOTIFICATION_DELIVERY_RECEIVED_ORDER_SQL}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as SqlRow[];

  const total = Number(totalRow.total ?? 0);
  return {
    items: rows.map(notificationDeliveryListItem),
    total,
    offset,
    limit,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + rows.length < total
  };
}

export function claimNotificationDeliveries(
  limit = 20,
  now = new Date().toISOString(),
  staleAfterMs = 5 * 60 * 1000
) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const staleBefore = new Date(Date.parse(now) - staleAfterMs).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE notification_deliveries
       SET status = 'retry', nextAttemptAt = ?, lastError = 'recovered_stale_send', updatedAt = ?
       WHERE status = 'sending' AND updatedAt <= ?`
    ).run(now, now, staleBefore);
    const rows = db.prepare(
      `SELECT notification_deliveries.*
       FROM notification_deliveries
       LEFT JOIN emails ON emails.id = notification_deliveries.emailId
       WHERE notification_deliveries.status IN ('pending', 'retry')
         AND (notification_deliveries.nextAttemptAt IS NULL OR notification_deliveries.nextAttemptAt <= ?)
       ORDER BY ${NOTIFICATION_DELIVERY_RECEIVED_ORDER_SQL}
       LIMIT ?`
    ).all(now, safeLimit) as SqlRow[];
    const claimed: NotificationDelivery[] = [];
    const statement = db.prepare(
      `UPDATE notification_deliveries
       SET status = 'sending', updatedAt = ?
       WHERE id = ? AND status IN ('pending', 'retry')`
    );
    for (const row of rows) {
      const delivery = rowToNotificationDelivery(row);
      const result = statement.run(now, delivery.id) as { changes?: number };
      if (Number(result.changes ?? 0) > 0) claimed.push({ ...delivery, status: "sending", updatedAt: now });
    }
    db.exec("COMMIT");
    return claimed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resumePausedNotificationDeliveries(channel: NotificationChannel) {
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE notification_deliveries SET status = 'retry', nextAttemptAt = ?, lastError = NULL, updatedAt = ? WHERE channel = ? AND status = 'paused'"
  ).run(now, now, channel) as { changes?: number };
  if (Number(result.changes ?? 0) > 0) publishNotificationDeliveryStatus(channel, "retry");
  return Number(result.changes ?? 0);
}

export function retryNotificationDelivery(id: string) {
  const row = db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const delivery = rowToNotificationDelivery(row);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notification_deliveries
     SET status = 'retry', nextAttemptAt = ?, lastError = NULL, updatedAt = ?
     WHERE id = ?`
  ).run(now, now, id);
  publishNotificationDeliveryStatus(delivery.channel, "retry");
  return getNotificationDelivery(delivery.emailId, delivery.channel);
}

export function pauseNotificationDelivery(id: string) {
  const row = db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const delivery = rowToNotificationDelivery(row);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notification_deliveries
     SET status = 'paused', nextAttemptAt = NULL, updatedAt = ?
     WHERE id = ?`
  ).run(now, id);
  publishNotificationDeliveryStatus(delivery.channel, "paused");
  return getNotificationDelivery(delivery.emailId, delivery.channel);
}

export function resumeNotificationDelivery(id: string) {
  const row = db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const delivery = rowToNotificationDelivery(row);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notification_deliveries
     SET status = 'retry', nextAttemptAt = ?, lastError = NULL, updatedAt = ?
     WHERE id = ? AND status = 'paused'`
  ).run(now, now, id);
  publishNotificationDeliveryStatus(delivery.channel, "retry");
  return getNotificationDelivery(delivery.emailId, delivery.channel);
}

export function retryNotificationDeliveriesByChannel(channel: NotificationChannel) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE notification_deliveries
     SET status = 'retry', nextAttemptAt = ?, lastError = NULL, updatedAt = ?
     WHERE channel = ? AND status IN ('retry', 'paused')`
  ).run(now, now, channel) as { changes?: number };
  if (Number(result.changes ?? 0) > 0) publishNotificationDeliveryStatus(channel, "retry");
  return Number(result.changes ?? 0);
}

export function updateNotificationDelivery(
  id: string,
  patch: Partial<Pick<NotificationDelivery, "status" | "attemptCount" | "nextAttemptAt" | "sentAt" | "lastError">>
) {
  const row = db.prepare("SELECT * FROM notification_deliveries WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const current = rowToNotificationDelivery(row);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  db.prepare(
    `UPDATE notification_deliveries
     SET status = ?, attemptCount = ?, nextAttemptAt = ?, sentAt = ?, lastError = ?, updatedAt = ?
     WHERE id = ?`
  ).run(
    next.status,
    next.attemptCount,
    next.nextAttemptAt ?? null,
    next.sentAt ?? null,
    next.lastError ?? null,
    next.updatedAt,
    id
  );
  publishNotificationDeliveryStatus(next.channel, next.status);
  return next;
}
