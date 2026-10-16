import { execFile } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadIlinkImage } from "./media";

type WeclawState = {
  bridgeAbort?: AbortController;
  loginAbort?: AbortController;
  bridgeStartedAt?: string;
  monitorAccountId?: string;
  lastExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  };
};

const state: WeclawState = {};
let qrLogMode = false;
let contextReadyHandler: ((userId: string) => void | Promise<void>) | undefined;
export type WeclawInboundText = {
  botId: string;
  senderId: string;
  messageId: string;
  text: string;
  receivedAt: string;
};
export type WeclawInboundTextHandler = (message: WeclawInboundText) => void | Promise<void>;
let inboundTextHandler: WeclawInboundTextHandler | undefined;
const rootDir = path.resolve(process.cwd());
const toolDir = path.join(rootDir, "tools", "weclaw");
const logDir = path.join(rootDir, "data");
const logFile = path.join(logDir, "weclaw.log");
export const defaultWeclawApiUrl = "http://127.0.0.1:18011/api/send";
const bridgeRuntimeName = "内置 Node iLink 桥接";
const ilinkBaseUrl = "https://ilinkai.weixin.qq.com";
const qrCodeUrl = `${ilinkBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
const qrStatusUrl = `${ilinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode=`;
const sessionExpiredCode = -14;
const contextTokenTtlMs = Math.max(2, Number(process.env.WECLAW_CONTEXT_TOKEN_TTL_HOURS || 24)) * 60 * 60 * 1000;
const contextTokenReminderLeadMs =
  Math.max(0.1, Number(process.env.WECLAW_CONTEXT_TOKEN_REMINDER_LEAD_HOURS || 4)) * 60 * 60 * 1000;
const contextTokenReminderCheckMs = Math.max(
  60,
  Number(process.env.WECLAW_CONTEXT_TOKEN_REMINDER_CHECK_SECONDS || 600)
) * 1000;
let tokenReminderTimer: ReturnType<typeof setInterval> | undefined;

type WeclawCredential = {
  botToken?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
};

type WeclawContextTokenStore = {
  updated_at?: string;
  token_updated_at?: Record<string, string>;
  tokens?: Record<string, string>;
  token_meta?: Record<string, WeclawTokenMetadata>;
  reminders?: Record<string, WeclawTokenReminderMetadata>;
};

export type WeclawTokenReminderMetadata = {
  token_hash?: string;
  reminded_at?: string;
  attempted_at?: string;
  last_error?: string;
};

export type WeclawTokenMetadata = {
  token_hash: string;
  captured_at: string;
  observed_at?: string;
  verified_at?: string;
  failed_at?: string;
  last_error?: string;
};

export type WeclawTokenHealthStatus =
  | "missing"
  | "unverified"
  | "healthy"
  | "refresh-soon"
  | "expired"
  | "invalid";

type WeclawTokenHealthInput = {
  hasToken: boolean;
  capturedAt?: string;
  observedAt?: string;
  verifiedAt?: string;
  failedAt?: string;
  lastError?: string;
};

export type WeclawTokenHealthSnapshot = {
  status: WeclawTokenHealthStatus;
  contextReady: boolean;
  capturedAt?: string;
  observedAt?: string;
  verifiedAt?: string;
  failedAt?: string;
  estimatedExpiresAt?: string;
  reminderAt?: string;
  lastError?: string;
};

function parsedTime(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function deriveWeclawTokenHealth(
  input: WeclawTokenHealthInput,
  now = Date.now(),
  ttlMs = contextTokenTtlMs,
  reminderLeadMs = contextTokenReminderLeadMs
): WeclawTokenHealthSnapshot {
  if (!input.hasToken) return { status: "missing", contextReady: false };

  const captured = parsedTime(input.capturedAt);
  const verified = parsedTime(input.verifiedAt);
  const failed = parsedTime(input.failedAt);
  const base = {
    capturedAt: input.capturedAt,
    observedAt: input.observedAt || input.capturedAt,
    verifiedAt: input.verifiedAt,
    failedAt: input.failedAt,
    lastError: input.lastError,
    estimatedExpiresAt: captured ? new Date(captured + ttlMs).toISOString() : undefined,
    reminderAt: captured ? new Date(captured + ttlMs - reminderLeadMs).toISOString() : undefined
  };

  if (failed && (!verified || failed >= verified)) {
    return { ...base, status: "invalid", contextReady: false };
  }
  if (!captured || !verified) {
    return { ...base, status: "unverified", contextReady: false };
  }
  if (now >= captured + ttlMs) {
    return { ...base, status: "expired", contextReady: false };
  }
  if (now >= captured + ttlMs - reminderLeadMs) {
    return { ...base, status: "refresh-soon", contextReady: true };
  }
  return { ...base, status: "healthy", contextReady: true };
}

export function captureWeclawTokenMetadata(
  current: WeclawTokenMetadata | undefined,
  nextTokenHash: string,
  capturedAt: string
): WeclawTokenMetadata {
  if (current?.token_hash === nextTokenHash) {
    return { ...current, observed_at: capturedAt };
  }
  return { token_hash: nextTokenHash, captured_at: capturedAt, observed_at: capturedAt };
}

export function captureWeclawTokenState(
  current: {
    metadata: WeclawTokenMetadata | undefined;
    reminder: WeclawTokenReminderMetadata | undefined;
  },
  nextTokenHash: string,
  capturedAt: string
) {
  const tokenChanged = current.metadata?.token_hash !== nextTokenHash;
  return {
    metadata: captureWeclawTokenMetadata(current.metadata, nextTokenHash, capturedAt),
    reminder: tokenChanged ? undefined : current.reminder
  };
}

export function recordWeclawTokenSendResult(
  current: WeclawTokenMetadata,
  result: { at: string; success: boolean; error?: string }
): WeclawTokenMetadata {
  if (result.success) {
    const { failed_at: _failedAt, last_error: _lastError, ...rest } = current;
    return { ...rest, verified_at: result.at };
  }
  return {
    ...current,
    failed_at: result.at,
    last_error: (result.error || "iLink send rejected").slice(0, 240)
  };
}

export function isWeclawTokenReminderDue(
  capturedAt: string,
  now = Date.now(),
  ttlMs = contextTokenTtlMs,
  reminderLeadMs = contextTokenReminderLeadMs
) {
  const captured = parsedTime(capturedAt);
  return captured !== undefined && now >= captured + ttlMs - reminderLeadMs;
}

type WeclawCredentialRecord = {
  botToken: string;
  botId: string;
  recipientId: string;
  baseUrl: string;
  path: string;
  updatedAt: string;
};

export type WeclawAccount = {
  botId: string;
  recipientId: string;
  path: string;
  updatedAt: string;
};

export function setWeclawContextReadyHandler(handler: (userId: string) => void | Promise<void>) {
  contextReadyHandler = handler;
}

export function setWeclawInboundTextHandler(handler?: WeclawInboundTextHandler) {
  inboundTextHandler = handler;
}

function executableName() {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "weclaw_windows_arm64.exe" : "weclaw_windows_amd64.exe";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "weclaw_darwin_arm64" : "weclaw_darwin_amd64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "weclaw_linux_arm64" : "weclaw_linux_amd64";
  }
  return "weclaw";
}

function executablePath() {
  return process.env.WECLAW_BIN || path.join(toolDir, "bin", executableName());
}

function credentialsDir() {
  return path.join(os.homedir(), ".weclaw", "accounts");
}

function contextTokensPath() {
  return path.join(os.homedir(), ".weclaw", "context_tokens.json");
}

function normalizeAccountId(raw: string) {
  return raw.replace(/[@.:]/g, "-");
}

function syncBufPath(botId: string) {
  return path.join(credentialsDir(), `${normalizeAccountId(botId)}.sync.json`);
}

function readSyncBuf(botId: string) {
  const filePath = syncBufPath(botId);
  if (!fs.existsSync(filePath)) return "";
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { get_updates_buf?: string };
    return raw.get_updates_buf || "";
  } catch {
    return "";
  }
}

function writeSyncBuf(botId: string, value: string) {
  const filePath = syncBufPath(botId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: value }, null, 2), "utf8");
}

function readWeclawContextTokens() {
  const filePath = contextTokensPath();
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      updatedAt: "",
      tokenUpdatedAt: {} as Record<string, string>,
      tokens: {} as Record<string, string>,
      tokenMeta: {} as Record<string, WeclawTokenMetadata>,
      reminders: {} as NonNullable<WeclawContextTokenStore["reminders"]>
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WeclawContextTokenStore;
    return {
      path: filePath,
      updatedAt: raw.updated_at || "",
      tokenUpdatedAt: raw.token_updated_at || {},
      tokens: raw.tokens || {},
      tokenMeta: raw.token_meta || {},
      reminders: raw.reminders || {}
    };
  } catch {
    return {
      path: filePath,
      updatedAt: "",
      tokenUpdatedAt: {} as Record<string, string>,
      tokens: {} as Record<string, string>,
      tokenMeta: {} as Record<string, WeclawTokenMetadata>,
      reminders: {} as NonNullable<WeclawContextTokenStore["reminders"]>
    };
  }
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function tokenMetadataFor(
  store: ReturnType<typeof readWeclawContextTokens>,
  userId: string,
  token: string
): WeclawTokenMetadata | undefined {
  const existing = store.tokenMeta[userId];
  if (existing) return existing;
  const legacyUpdatedAt = store.tokenUpdatedAt[userId] || store.updatedAt;
  if (!legacyUpdatedAt) return undefined;
  return {
    token_hash: tokenHash(token),
    captured_at: legacyUpdatedAt,
    observed_at: legacyUpdatedAt,
    verified_at: legacyUpdatedAt
  };
}

function writeWeclawContextTokenStore(store: WeclawContextTokenStore) {
  const filePath = contextTokensPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8");
}

function notifyWeclawContextReady(userId: string) {
  if (!contextReadyHandler) return;
  Promise.resolve(contextReadyHandler(userId)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("system", `context ready handler failed: ${message}`);
  });
}

function writeWeclawContextToken(userId: string, contextToken: string) {
  if (!userId || !contextToken) return false;
  const current = readWeclawContextTokens();
  const previous = current.tokens[userId];
  const capturedAt = new Date().toISOString();
  const nextTokenHash = tokenHash(contextToken);
  const capturedState = captureWeclawTokenState(
    {
      metadata: previous ? tokenMetadataFor(current, userId, previous) : undefined,
      reminder: current.reminders[userId]
    },
    nextTokenHash,
    capturedAt
  );
  const reminders = { ...current.reminders };
  if (capturedState.reminder) reminders[userId] = capturedState.reminder;
  else delete reminders[userId];
  const next: WeclawContextTokenStore = {
    updated_at: capturedAt,
    token_updated_at: {
      ...current.tokenUpdatedAt,
      [userId]: capturedAt
    },
    tokens: {
      ...current.tokens,
      [userId]: contextToken
    },
    token_meta: {
      ...current.tokenMeta,
      [userId]: capturedState.metadata
    },
    reminders
  };
  writeWeclawContextTokenStore(next);
  return previous !== contextToken;
}

function recordStoredWeclawTokenSendResult(
  userId: string,
  contextToken: string,
  result: { at: string; success: boolean; error?: string }
) {
  const current = readWeclawContextTokens();
  if (current.tokens[userId] !== contextToken) return;
  const metadata = tokenMetadataFor(current, userId, contextToken);
  if (!metadata) return;
  writeWeclawContextTokenStore({
    updated_at: current.updatedAt,
    token_updated_at: current.tokenUpdatedAt,
    tokens: current.tokens,
    token_meta: {
      ...current.tokenMeta,
      [userId]: recordWeclawTokenSendResult(metadata, result)
    },
    reminders: current.reminders
  });
}

function readWeclawCredentialRecords(): WeclawCredentialRecord[] {
  const dir = credentialsDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".sync.json"))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WeclawCredential;
        const botToken = raw.bot_token || raw.botToken || "";
        const botId = raw.ilink_bot_id || "";
        const recipientId = raw.ilink_user_id || "";
        if (!botToken || !botId || !recipientId) return undefined;
        return {
          botToken,
          botId,
          recipientId,
          baseUrl: raw.baseurl || ilinkBaseUrl,
          path: filePath,
          updatedAt: stat.mtime.toISOString()
        };
      } catch {
        return undefined;
      }
    })
    .filter((account): account is WeclawCredentialRecord => Boolean(account))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function saveWeclawCredentials(record: {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id: string;
  baseurl?: string;
}) {
  fs.mkdirSync(credentialsDir(), { recursive: true });
  const filePath = path.join(credentialsDir(), `${normalizeAccountId(record.ilink_bot_id)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}

export function readWeclawAccounts(): WeclawAccount[] {
  return readWeclawCredentialRecords().map(({ botId, recipientId, path: filePath, updatedAt }) => ({
    botId,
    recipientId,
    path: filePath,
    updatedAt
  }));
}

export function resolveWeclawRecipientId(fallback = "") {
  return fallback.trim() || readWeclawAccounts()[0]?.recipientId || "";
}

function appendLog(source: string, chunk: Buffer | string) {
  fs.mkdirSync(logDir, { recursive: true });
  const text = String(chunk);
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter(Boolean)
    .map((line) => {
      if (line.includes("Scan this QR code with WeChat")) {
        qrLogMode = true;
        return `[${new Date().toISOString()}] [${source}] ${line}`;
      }
      if (qrLogMode && (line.includes("QR URL:") || line.includes("Waiting for scan"))) {
        if (line.includes("Waiting for scan")) qrLogMode = false;
        return `[${new Date().toISOString()}] [${source}] ${line}`;
      }
      if (qrLogMode) return line;
      return `[${new Date().toISOString()}] [${source}] ${line}`;
    })
    .join("\n");
  if (lines) fs.appendFileSync(logFile, `${lines}\n`, "utf8");
}

function readLogTail(lines = 120) {
  if (!fs.existsSync(logFile)) return "";
  const content = fs.readFileSync(logFile, "utf8");
  return content.split(/\r\n|\n|\r/).slice(-lines).join("\n").trim();
}

function logLineTime(line?: string) {
  const match = line?.match(/^\[([^\]]+)\]/);
  return match?.[1] || "";
}

function analyzeWeclawRuntime(logTail: string) {
  const lines = logTail.split(/\r\n|\n|\r/);
  let lastStart = -1;
  let lastLogin = -1;
  let lastSessionExpired = -1;
  let lastMissingContext = -1;

  lines.forEach((line, index) => {
    if (line.includes("starting ") || line.includes("Starting message bridge")) lastStart = index;
    if (line.includes("Login confirmed!") || line.includes("Login successful!")) lastLogin = index;
    if (line.includes("session expired")) lastSessionExpired = index;
    if (line.includes("missing context_token")) lastMissingContext = index;
  });

  const currentRunStart = Math.max(lastStart, lastLogin);
  const sessionExpired = lastSessionExpired > currentRunStart;
  const missingContext = !sessionExpired && lastMissingContext > currentRunStart;

  return {
    sessionExpired,
    sessionExpiredAt: sessionExpired ? logLineTime(lines[lastSessionExpired]) : "",
    missingContext,
    missingContextAt: missingContext ? logLineTime(lines[lastMissingContext]) : ""
  };
}

function execFileQuiet(file: string, args: string[]) {
  return new Promise<void>((resolve) => {
    execFile(file, args, { windowsHide: true }, () => resolve());
  });
}

async function forceStopBundledWeclaw() {
  if (process.platform === "win32") {
    await execFileQuiet("taskkill.exe", ["/F", "/IM", executableName()]);
    return;
  }
  await execFileQuiet("pkill", ["-f", executablePath()]);
}

function clearWeclawBindingFiles() {
  const accountDir = credentialsDir();
  if (fs.existsSync(accountDir)) {
    for (const name of fs.readdirSync(accountDir)) {
      if (name.endsWith(".json")) {
        fs.rmSync(path.join(accountDir, name), { force: true });
      }
    }
  }
  fs.rmSync(contextTokensPath(), { force: true });
  appendLog("system", "cleared WeClaw login credentials, sync cursor, and context tokens for rebinding");
}

function apiUrlToBase(apiUrl: string) {
  const url = new URL(apiUrl || defaultWeclawApiUrl);
  return `${url.protocol}//${url.host}`;
}

function apiUrlToAddr(apiUrl: string) {
  const url = new URL(apiUrl || defaultWeclawApiUrl);
  return url.host;
}

function wechatUin() {
  return Buffer.from(String(randomInt(0, 0xffffffff))).toString("base64");
}

async function fetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function ilinkPost<T>(
  account: WeclawCredentialRecord,
  endpoint: string,
  body: unknown,
  timeoutMs = 15000
) {
  return fetchJson<T>(`${account.baseUrl || ilinkBaseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${account.botToken}`,
      "X-WECHAT-UIN": wechatUin()
    },
    body: JSON.stringify(body),
    timeoutMs
  });
}

function latestAccountForRecipient(recipientId: string) {
  const accounts = readWeclawCredentialRecords();
  return accounts.find((account) => account.recipientId === recipientId) || accounts[0];
}

function weclawDirectContext(recipientId: string) {
  const account = latestAccountForRecipient(recipientId);
  if (!account) throw new Error("未找到微信登录凭据，请先在管理设置里重新绑定微信。");
  const contextToken = readWeclawContextTokens().tokens[recipientId];
  if (!contextToken) {
    throw new Error("missing context_token: 请先打开微信 ClawBot 聊天，发送任意一条消息用于激活通知会话。");
  }
  return { account, contextToken };
}

async function sendWeclawDirectItem(
  recipientId: string,
  item: Record<string, unknown>,
  description: string,
  timeoutMs: number,
  existing?: ReturnType<typeof weclawDirectContext>
) {
  const { account, contextToken } = existing ?? weclawDirectContext(recipientId);
  const response = await ilinkPost<{ ret?: number; errmsg?: string }>(
    account,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: account.botId,
        to_user_id: recipientId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken
      },
      base_info: {}
    },
    timeoutMs
  );

  if (response.ret && response.ret !== 0) {
    const errorMessage = `send message failed: ret=${response.ret} errmsg=${response.errmsg || ""}`;
    if (response.ret === sessionExpiredCode) {
      appendLog("system", "notification bridge session expired; pending notifications are paused until the next WeChat message");
    }
    recordStoredWeclawTokenSendResult(recipientId, contextToken, {
      at: new Date().toISOString(),
      success: false,
      error: errorMessage
    });
    throw new Error(errorMessage);
  }

  recordStoredWeclawTokenSendResult(recipientId, contextToken, {
    at: new Date().toISOString(),
    success: true
  });
  appendLog("system", `direct ${description} sent to ${recipientId}`);
  return JSON.stringify({ status: "ok", mode: "direct", type: description });
}

export async function sendWeclawDirectText(recipientId: string, text: string, timeoutMs = 15000) {
  return sendWeclawDirectItem(
    recipientId,
    { type: 1, text_item: { text } },
    `text notification: ${text.slice(0, 80)}`,
    timeoutMs
  );
}

export async function sendWeclawDirectImage(recipientId: string, image: Buffer, timeoutMs = 20000) {
  const context = weclawDirectContext(recipientId);
  const imageItem = await uploadIlinkImage(image, recipientId, {
    getUploadUrl: (body) => ilinkPost(context.account, "/ilink/bot/getuploadurl", { ...body, base_info: {} }, timeoutMs)
  });
  return sendWeclawDirectItem(recipientId, imageItem, "image notification", timeoutMs, context);
}
function formatReminderTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function buildContextTokenRefreshReminder(updatedAt: string) {
  const updated = new Date(updatedAt);
  const expectedExpiry = new Date(updated.getTime() + contextTokenTtlMs);
  return [
    "⚠️ 自动邮件系统：微信通知需要刷新",
    "",
    `当前 ClawBot 会话 token 已接近预计失效时间：${formatReminderTime(expectedExpiry)}`,
    "",
    "请现在打开微信里的 ClawBot 聊天，发送任意一条消息，例如：1",
    "",
    "系统收到后会验证当前 token，并重试之前失败的邮件通知。"
  ].join("\n");
}

export function buildContextTokenUpdatedMessage(updatedAt = new Date().toISOString(), tokenChanged = true) {
  return [
    tokenChanged ? "✅ 微信通知令牌刷新并验证成功" : "✅ 微信通知当前令牌发送验证成功",
    "",
    tokenChanged
      ? "系统收到了新的 context token，并已完成主动发送验证；过期倒计时已重新开始。"
      : "系统收到了你的消息并验证当前 token 仍可发送，但 token 值没有变化，因此不会重置过期倒计时。",
    "",
    `验证时间：${formatReminderTime(new Date(updatedAt))}`,
    "",
    "接下来重要邮件、次重要邮件会继续按你的通知分类设置推送到这里。",
    "iLink 不提供精确过期时间，系统会在预计失效前约 4 小时提醒你再次验证。",
    "无需重新扫码，也无需在面板里手动填写接收人。"
  ].join("\n");
}

async function notifyWeclawContextTokenUpdated(userId: string, updatedAt: string, tokenChanged: boolean) {
  try {
    await sendWeclawDirectText(userId, buildContextTokenUpdatedMessage(updatedAt, tokenChanged), 12000);
    appendLog("system", `context token refresh confirmation sent to ${userId}`);
    notifyWeclawContextReady(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("system", `context token refresh confirmation failed for ${userId}: ${message}`);
  }
}

function shouldThrottleReminderAttempt(attemptedAt?: string) {
  if (!attemptedAt) return false;
  const attempted = Date.parse(attemptedAt);
  if (!Number.isFinite(attempted)) return false;
  return Date.now() - attempted < 60 * 60 * 1000;
}

export async function sendDueWeclawTokenRefreshReminders() {
  const store = readWeclawContextTokens();
  const accounts = readWeclawCredentialRecords();
  const now = Date.now();
  let checked = 0;
  let sent = 0;
  let failed = 0;

  for (const account of accounts) {
    const recipientId = account.recipientId;
    const token = store.tokens[recipientId];
    if (!token) continue;

    const metadata = tokenMetadataFor(store, recipientId, token);
    const updatedAt = metadata?.captured_at || store.tokenUpdatedAt[recipientId] || store.updatedAt;
    const updated = Date.parse(updatedAt);
    if (!Number.isFinite(updated)) continue;

    checked += 1;
    if (!isWeclawTokenReminderDue(updatedAt, now)) continue;
    const health = deriveWeclawTokenHealth(
      {
        hasToken: true,
        capturedAt: metadata?.captured_at || updatedAt,
        verifiedAt: metadata?.verified_at || updatedAt,
        failedAt: metadata?.failed_at,
        lastError: metadata?.last_error
      },
      now
    );
    if (health.status === "invalid" || health.status === "expired") continue;

    const hash = tokenHash(token);
    const currentStore = readWeclawContextTokens();
    const reminder = currentStore.reminders[recipientId];
    if (reminder?.token_hash === hash && reminder.reminded_at) continue;
    if (reminder?.token_hash === hash && shouldThrottleReminderAttempt(reminder.attempted_at)) continue;

    const attemptedAt = new Date().toISOString();
    writeWeclawContextTokenStore({
      updated_at: currentStore.updatedAt,
      token_updated_at: currentStore.tokenUpdatedAt,
      tokens: currentStore.tokens,
      token_meta: currentStore.tokenMeta,
      reminders: {
        ...currentStore.reminders,
        [recipientId]: {
          token_hash: hash,
          attempted_at: attemptedAt,
          last_error: ""
        }
      }
    });

    try {
      await sendWeclawDirectText(recipientId, buildContextTokenRefreshReminder(updatedAt), 12000);
      const latestStore = readWeclawContextTokens();
      writeWeclawContextTokenStore({
        updated_at: latestStore.updatedAt,
        token_updated_at: latestStore.tokenUpdatedAt,
        tokens: latestStore.tokens,
        token_meta: latestStore.tokenMeta,
        reminders: {
          ...latestStore.reminders,
          [recipientId]: {
            token_hash: hash,
            attempted_at: attemptedAt,
            reminded_at: new Date().toISOString(),
            last_error: ""
          }
        }
      });
      sent += 1;
      appendLog("system", `context token refresh reminder sent to ${recipientId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latestStore = readWeclawContextTokens();
      writeWeclawContextTokenStore({
        updated_at: latestStore.updatedAt,
        token_updated_at: latestStore.tokenUpdatedAt,
        tokens: latestStore.tokens,
        token_meta: latestStore.tokenMeta,
        reminders: {
          ...latestStore.reminders,
          [recipientId]: {
            token_hash: hash,
            attempted_at: attemptedAt,
            last_error: message.slice(0, 240)
          }
        }
      });
      failed += 1;
      appendLog("system", `context token refresh reminder failed for ${recipientId}: ${message}`);
    }
  }

  return { checked, sent, failed };
}

export function startWeclawTokenReminderWorker() {
  if (tokenReminderTimer) return tokenReminderTimer;
  const tick = () => {
    void sendDueWeclawTokenRefreshReminders().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("system", `context token reminder worker failed: ${message}`);
    });
  };
  tokenReminderTimer = setInterval(tick, contextTokenReminderCheckMs);
  setTimeout(tick, 30000);
  return tokenReminderTimer;
}

function textFromIlinkMessage(msg: any) {
  const item = Array.isArray(msg?.item_list) ? msg.item_list.find((entry: any) => entry?.type === 1) : undefined;
  return String(item?.text_item?.text || "");
}

function receivedAtFromIlinkMessage(msg: any) {
  const value = msg?.create_time ?? msg?.create_time_ms ?? msg?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

export function deriveWeclawInboundMessageId(msg: any, botId: string, senderId: string, text: string) {
  const direct = [msg?.msg_id, msg?.message_id, msg?.client_msg_id, msg?.id]
    .find((value) => typeof value === "string" || typeof value === "number");
  if (direct !== undefined && String(direct).trim()) return String(direct);
  const stableSource = JSON.stringify({
    botId,
    senderId,
    text,
    messageType: msg?.message_type,
    messageState: msg?.message_state,
    // Keep protocol timestamps when present so identical text from separate
    // messages does not collapse into one task. If the protocol omits both
    // identity and time, identical content is conservatively treated as a replay.
    create_time: msg?.create_time,
    create_time_ms: msg?.create_time_ms,
    timestamp: msg?.timestamp,
    itemList: msg?.item_list
  });
  return `sha256:${createHash("sha256").update(stableSource).digest("hex")}`;
}

function isUserFinishedMessage(msg: any) {
  return msg?.message_type === 1 && msg?.message_state === 2;
}

export async function processWeclawInboundBatch(
  messages: unknown[],
  account: Pick<WeclawCredentialRecord, "botId" | "recipientId">,
  handler: WeclawInboundTextHandler
) {
  const persisted: WeclawInboundText[] = [];
  for (const candidate of messages) {
    const msg = candidate as any;
    if (!isUserFinishedMessage(msg)) continue;
    if (String(msg?.from_user_id || "") !== account.recipientId) continue;
    const text = textFromIlinkMessage(msg);
    if (!text.trim()) continue;
    const inbound: WeclawInboundText = {
      botId: account.botId,
      senderId: account.recipientId,
      messageId: deriveWeclawInboundMessageId(msg, account.botId, account.recipientId, text),
      text,
      receivedAt: receivedAtFromIlinkMessage(msg)
    };
    await handler(inbound);
    persisted.push(inbound);
  }
  return persisted;
}

async function monitorAccount(account: WeclawCredentialRecord, signal: AbortSignal) {
  let getUpdatesBuf = readSyncBuf(account.botId);
  appendLog("system", `notification bridge monitoring ${account.botId} without auto replies`);

  while (!signal.aborted) {
    try {
      const response = await ilinkPost<any>(
        account,
        "/ilink/bot/getupdates",
        {
          get_updates_buf: getUpdatesBuf,
          base_info: {
            channel_version: "1.0.0"
          }
        },
        40000
      );

      if (response?.errcode === sessionExpiredCode) {
        if (getUpdatesBuf) {
          appendLog("system", "notification bridge session expired, resetting sync cursor");
          getUpdatesBuf = "";
          writeSyncBuf(account.botId, getUpdatesBuf);
        } else {
          appendLog("system", "notification bridge session expired; please rebind WeChat");
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const retError = typeof response?.ret === "number" && response.ret !== 0;
      const errCodeError = typeof response?.errcode === "number" && response.errcode !== 0;
      if (retError || errCodeError) {
        appendLog("system", `notification bridge server error ret=${response?.ret} errcode=${response?.errcode}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      const messages = Array.isArray(response?.msgs) ? response.msgs : [];
      if (inboundTextHandler) {
        await processWeclawInboundBatch(messages, account, inboundTextHandler);
      }
      for (const msg of messages) {
        if (!isUserFinishedMessage(msg)) continue;
        if (String(msg?.from_user_id || "") !== account.recipientId) continue;
        if (msg.context_token && msg.from_user_id) {
          const refreshedAt = new Date().toISOString();
          const changed = writeWeclawContextToken(msg.from_user_id, msg.context_token);
          appendLog(
            "system",
            `recorded WeChat context for ${msg.from_user_id} (${changed ? "new token" : "same token"})`
          );
          void notifyWeclawContextTokenUpdated(msg.from_user_id, refreshedAt, changed);
        }
      }
      if (response?.get_updates_buf) {
        getUpdatesBuf = response.get_updates_buf;
        writeSyncBuf(account.botId, getUpdatesBuf);
      }
    } catch (error) {
      if (signal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      appendLog("system", `notification bridge poll failed: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  appendLog("system", `notification bridge stopped for ${account.botId}`);
}

function startNotificationBridge() {
  if (managedRunning()) return;
  const account = readWeclawCredentialRecords()[0];
  if (!account) return;

  const controller = new AbortController();
  state.bridgeAbort = controller;
  state.bridgeStartedAt = new Date().toISOString();
  state.monitorAccountId = account.botId;
  void monitorAccount(account, controller.signal).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("system", `notification bridge crashed: ${message}`);
  });
}

async function startQrLogin() {
  if (state.loginAbort && !state.loginAbort.signal.aborted) return;
  const controller = new AbortController();
  state.loginAbort = controller;

  void (async () => {
    try {
      appendLog("stdout", "Fetching QR code...");
      const qr = await fetchJson<{ qrcode: string; qrcode_img_content: string }>(qrCodeUrl, {
        timeoutMs: 15000,
        signal: controller.signal
      });
      appendLog("stdout", "Scan this QR code with WeChat:");
      appendLog("stdout", `QR URL: ${qr.qrcode_img_content}`);
      appendLog("stdout", "Waiting for scan...");

      while (!controller.signal.aborted) {
        const status = await fetchJson<{
          status: string;
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
          ilink_user_id?: string;
        }>(`${qrStatusUrl}${encodeURIComponent(qr.qrcode)}`, {
          timeoutMs: 45000,
          signal: controller.signal
        });

        if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id && status.ilink_user_id) {
          appendLog("stdout", "Login confirmed!");
          saveWeclawCredentials({
            bot_token: status.bot_token,
            ilink_bot_id: status.ilink_bot_id,
            ilink_user_id: status.ilink_user_id,
            baseurl: status.baseurl || ilinkBaseUrl
          });
          appendLog("stdout", `Login successful! Credentials saved to ${credentialsDir()}`);
          appendLog("stdout", `Bot ID: ${status.ilink_bot_id}`);
          state.loginAbort = undefined;
          startNotificationBridge();
          return;
        }

        if (status.status === "expired") {
          appendLog("system", "QR code expired; click rebind WeChat to generate a new one");
          state.loginAbort = undefined;
          return;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("system", `QR login failed: ${message}`);
      }
      state.loginAbort = undefined;
    }
  })();
}

async function isApiReachable(apiUrl: string, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(apiUrlToBase(apiUrl), {
      method: "GET",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function managedRunning() {
  return Boolean(
    (state.bridgeAbort && !state.bridgeAbort.signal.aborted) ||
      (state.loginAbort && !state.loginAbort.signal.aborted)
  );
}

export async function getWeclawStatus(apiUrl: string) {
  const exe = executablePath();
  const legacyExecutableAvailable = fs.existsSync(exe);
  const legacyApiReachable = await isApiReachable(apiUrl);
  const accounts = readWeclawAccounts();
  const activeAccount = accounts[0];
  const contextTokens = readWeclawContextTokens();
  const activeContextToken = activeAccount?.recipientId ? contextTokens.tokens[activeAccount.recipientId] : "";
  const activeTokenMetadata = activeAccount?.recipientId && activeContextToken
    ? tokenMetadataFor(contextTokens, activeAccount.recipientId, activeContextToken)
    : undefined;
  const tokenHealth = deriveWeclawTokenHealth({
    hasToken: Boolean(activeContextToken),
    capturedAt: activeTokenMetadata?.captured_at,
    observedAt: activeTokenMetadata?.observed_at,
    verifiedAt: activeTokenMetadata?.verified_at,
    failedAt: activeTokenMetadata?.failed_at,
    lastError: activeTokenMetadata?.last_error
  });
  const logTail = readLogTail(220);
  const runtimeHealth = analyzeWeclawRuntime(logTail);
  const bridgeReady = managedRunning();
  return {
    installed: true,
    runtimeMode: "node-ilink",
    runtimeName: bridgeRuntimeName,
    executablePath: legacyExecutableAvailable ? exe : "",
    legacyExecutablePath: exe,
    legacyExecutableAvailable,
    apiUrl: apiUrl || defaultWeclawApiUrl,
    apiBaseUrl: apiUrlToBase(apiUrl),
    apiReachable: bridgeReady || legacyApiReachable,
    running: bridgeReady || legacyApiReachable,
    managedRunning: managedRunning(),
    managedPid: undefined,
    hasCredentials: accounts.length > 0,
    credentialCount: accounts.length,
    credentialsPath: credentialsDir(),
    recipientId: activeAccount?.recipientId,
    botId: activeAccount?.botId,
    contextTokenPath: contextTokens.path,
    contextReady: tokenHealth.contextReady,
    contextUpdatedAt: tokenHealth.capturedAt || contextTokens.updatedAt,
    tokenHealth: tokenHealth.status,
    contextCapturedAt: tokenHealth.capturedAt,
    contextObservedAt: tokenHealth.observedAt,
    contextVerifiedAt: tokenHealth.verifiedAt,
    contextFailedAt: tokenHealth.failedAt,
    contextEstimatedExpiresAt: tokenHealth.estimatedExpiresAt,
    contextReminderAt: tokenHealth.reminderAt,
    contextLastError: tokenHealth.lastError,
    ...runtimeHealth,
    lastExit: state.lastExit,
    logTail
  };
}

export async function startWeclaw(apiUrl: string) {
  const status = await getWeclawStatus(apiUrl);
  if (status.managedRunning) {
    return {
      ...status,
      message: "微信通知桥接已由本项目启动。"
    };
  }

  fs.mkdirSync(logDir, { recursive: true });
  appendLog("system", `starting project notification bridge (${apiUrlToAddr(apiUrl)})`);
  await forceStopBundledWeclaw();

  if (readWeclawCredentialRecords().length > 0) {
    startNotificationBridge();
  } else {
    await startQrLogin();
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    ...(await getWeclawStatus(apiUrl)),
    message: "已启动微信通知桥接。首次运行请查看二维码并用手机微信扫码。"
  };
}

export async function ensureWeclawStarted(apiUrl: string) {
  try {
    const status = await startWeclaw(apiUrl);
    appendLog("system", `auto-start WeClaw: ${status.running ? "running" : "not running"}`);
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog("system", `auto-start WeClaw failed: ${message}`);
    return undefined;
  }
}

export async function stopWeclaw(apiUrl: string) {
  appendLog("system", "stopping managed notification bridge");
  state.bridgeAbort?.abort();
  state.loginAbort?.abort();
  state.bridgeAbort = undefined;
  state.loginAbort = undefined;
  await forceStopBundledWeclaw();
  state.lastExit = {
    code: 0,
    signal: null,
    at: new Date().toISOString()
  };
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    ...(await getWeclawStatus(apiUrl)),
    message: "已停止本项目的微信通知桥接。"
  };
}

export async function rebindWeclaw(apiUrl: string) {
  await stopWeclaw(apiUrl);

  if (await isApiReachable(apiUrl, 800)) {
    appendLog("system", "WeClaw API still reachable after managed stop; forcing bundled process stop before rebinding");
    await forceStopBundledWeclaw();
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  clearWeclawBindingFiles();
  const status = await startWeclaw(apiUrl);
  return {
    ...status,
    message: "已清除旧微信绑定并启动重新扫码。请用手机微信扫描新的二维码并确认登录。"
  };
}

export function getWeclawLogTail(lines = 160) {
  return {
    logTail: readLogTail(lines),
    logFile
  };
}

process.once("exit", () => {
  state.bridgeAbort?.abort();
  state.loginAbort?.abort();
});
