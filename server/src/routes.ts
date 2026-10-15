import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { classifyEmail } from "./ai";
import { queryProviderCosts } from "./ai-costs";
import { resolveAiEndpoint, resolveAiProtocol } from "./ai-protocol";
import { clearAuthCookie, isAuthenticated, requireAuth, setAuthCookie } from "./auth";
import { handleAppEvents } from "./events";
import { fetchRemoteEmailImage, findInlineEmailImage } from "./email/assets";
import { fetchUnreadImap } from "./email/imap";
import { fetchUnreadPop3 } from "./email/pop3";
import { isProcessorRunning, processMailboxes } from "./email/processor";
import { checkLoginAllowed, registerLoginFailure, registerLoginSuccess } from "./security";
import {
  firstAiUsageOccurredAt,
  getDashboardData,
  getEmailNotificationSummary,
  getProcessedEmailById,
  isAdminPasswordChanged,
  markProcessedEmailsPanelRead,
  pauseNotificationDelivery,
  publicAiBillingSettings,
  publicAiSettings,
  publicAuthSettings,
  publicMailbox,
  publicQqBotSettings,
  queryAiUsageDashboard,
  queryNotificationDeliveries,
  queryProcessedEmails,
  readAiBillingAdminKey,
  readMailboxes,
  readProcessingRuns,
  readQqAgentRuns,
  readQqBotConfig,
  readSettings,
  removeMailbox,
  retryNotificationDeliveriesByChannel,
  retryNotificationDelivery,
  resumePausedNotificationDeliveries,
  resumeNotificationDelivery,
  saveAiCostSnapshot,
  undoProcessedEmailsPanelRead,
  updateAiBillingSettings,
  updateAuthPassword,
  updateAiSettings,
  updateNotificationSettings,
  updateQqBotSettings,
  updateProcessedEmailPanelRead,
  updateSystemSettings,
  upsertMailbox,
  verifyAdminPassword
} from "./store";
import { sendClawbotTestNotification } from "./notifications/clawbot";
import { scheduleNotificationDispatch } from "./notifications/dispatcher";
import { schedulePendingEmailNotificationRetry } from "./notifications/pending";
import {
  createQqRebindChallenge,
  getQqManagerStatus,
  restartQqManager,
  sendQqTestNotification,
  startQqManager,
  stopQqManager
} from "./qq/manager";
import { resolveQqMarkdownAsset } from "./qq/markdown-assets";
import type { QqBotPublicStatus } from "./qq/types";
import {
  defaultWeclawApiUrl,
  getWeclawLogTail,
  getWeclawStatus,
  rebindWeclaw,
  startWeclaw,
  stopWeclaw
} from "./weclaw/manager";
import type {
  AiSettings,
  AiUsageRange,
  ClassificationResult,
  MailCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSettings,
  ProcessedEmail,
  PublicQqBotSettings
} from "./types";

const router = express.Router();
const EMAIL_ASSET_TOKEN_TTL_SECONDS = 6 * 60 * 60;

function requireChangedAdminPassword(_req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isAdminPasswordChanged()) {
    res.status(428).json({ error: "请先修改默认管理员密码，再保存邮箱、模型或通知凭证。" });
    return;
  }
  next();
}

const mailboxSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "请输入邮箱名称"),
  email: z.string().email("请输入正确邮箱地址"),
  protocol: z.enum(["imap", "pop3"]),
  host: z.string().min(1, "请输入服务器地址"),
  port: z.coerce.number().int().positive(),
  secure: z.coerce.boolean(),
  username: z.string().min(1, "请输入用户名"),
  password: z.string().optional().default(""),
  folder: z.string().optional().default("INBOX"),
  enabled: z.coerce.boolean()
});

export const aiSchema = z.object({
  providerName: z.string().min(1),
  providerPreset: z.string().optional().default("custom"),
  baseUrl: z.string().url(),
  apiKey: z.string().optional().default(""),
  model: z.string().min(1),
  temperature: z.coerce.number().min(0).max(2),
  protocol: z.enum(["auto", "openai-chat", "openai-responses", "anthropic", "gemini"]).optional().default("auto"),
  multimodalEnabled: z.coerce.boolean().optional().default(true),
  multimodalBaseUrl: z.string().url().optional().default("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
  multimodalModel: z.string().optional().default("glm-5v-turbo"),
  multimodalProtocol: z
    .enum(["auto", "same", "openai-chat", "openai-responses", "anthropic", "gemini"])
    .optional()
    .default("auto"),
  multimodalApiKey: z.string().optional().default(""),
  multimodalMaxAttachmentMb: z.coerce.number().min(1).max(32).optional().default(8),
  multimodalMaxTotalMb: z.coerce.number().min(1).max(64).optional().default(18)
});

const aiUsageRangeSchema = z.enum(["today", "7d", "30d", "all"]);
const aiBillingSchema = z.object({
  provider: z.enum(["none", "openai", "anthropic"]),
  adminKey: z.string().optional().default("")
});
const aiCostSyncSchema = z.object({
  range: aiUsageRangeSchema,
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional()
});

function fallbackUsageStart(range: AiUsageRange, endAt: Date) {
  if (range === "all") return undefined;
  const start = new Date(endAt);
  if (range === "today") start.setUTCHours(0, 0, 0, 0);
  if (range === "7d") start.setUTCDate(start.getUTCDate() - 7);
  if (range === "30d") start.setUTCDate(start.getUTCDate() - 30);
  return start.toISOString();
}

function resolveUsageWindow(input: { range: AiUsageRange; startAt?: string; endAt?: string }) {
  const endAt = input.endAt ? new Date(input.endAt) : new Date();
  const startAt = input.startAt ?? fallbackUsageStart(input.range, endAt);
  if (!Number.isFinite(endAt.getTime()) || (startAt && !Number.isFinite(Date.parse(startAt)))) {
    throw new Error("模型用量时间范围无效。");
  }
  if (startAt && Date.parse(startAt) >= endAt.getTime()) {
    throw new Error("模型用量开始时间必须早于结束时间。");
  }
  return { startAt, endAt: endAt.toISOString() };
}

export function withSavedAiTestKeys(submitted: AiSettings, saved: AiSettings): AiSettings {
  return {
    ...submitted,
    apiKey: submitted.apiKey.trim() ? submitted.apiKey : saved.apiKey,
    multimodalApiKey: submitted.multimodalApiKey?.trim()
      ? submitted.multimodalApiKey
      : saved.multimodalApiKey
  };
}

function redactDiagnosticSecrets(value: string, apiKeys: Array<string | undefined>) {
  const secrets = [...new Set(apiKeys.map((apiKey) => apiKey?.trim()).filter((apiKey): apiKey is string => Boolean(apiKey)))];
  return secrets.reduce((safeValue, secret) => {
    const representations = [...new Set([secret, encodeURIComponent(secret)])];
    return representations.reduce((redactedValue, representation) => {
      const escapedRepresentation = representation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return redactedValue.replace(new RegExp(escapedRepresentation, "gi"), "[REDACTED]");
    }, safeValue);
  }, value);
}

function sanitizeDiagnosticEndpoint(endpoint: string, apiKeys: Array<string | undefined>) {
  const parsed = new URL(endpoint);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return redactDiagnosticSecrets(parsed.origin, apiKeys);
}

export function buildAiTestDiagnostics(settings: AiSettings, result: ClassificationResult) {
  return {
    provider: settings.providerName,
    protocol: resolveAiProtocol(settings, "text"),
    endpoint: sanitizeDiagnosticEndpoint(resolveAiEndpoint(settings, "text"), [settings.apiKey, settings.multimodalApiKey]),
    model: settings.model,
    category: result.category
  };
}

const systemSchema = z.object({
  autoProcessEnabled: z.coerce.boolean(),
  autoLoadRemoteImages: z.coerce.boolean().optional().default(false),
  pollIntervalMinutes: z.coerce.number().int().min(1).max(1440),
  processLimitPerMailbox: z.coerce.number().int().min(1).max(500)
});

const notificationSchema = z.object({
  enabled: z.coerce.boolean(),
  clawbotRecipientId: z.string().optional().default(""),
  clawbotApiUrl: z.string().optional().default(defaultWeclawApiUrl),
  importantOnly: z.coerce.boolean().optional().default(true),
  notifyCategories: z
    .object({
      important: z.coerce.boolean().default(true),
      secondary: z.coerce.boolean().default(true),
      ignore: z.coerce.boolean().default(false)
    })
    .default({
      important: true,
      secondary: true,
      ignore: false
    })
});

export const qqNotificationSchema = z.object({
  appId: z.string().trim().regex(/^(?:|[0-9]{5,20})$/, "QQ AppID 格式不正确"),
  appSecret: z.string().optional().default(""),
  enabled: z.coerce.boolean(),
  quoteImageMarksRead: z.coerce.boolean().optional().default(true),
  notifyCategories: z.object({
    important: z.coerce.boolean().default(true),
    secondary: z.coerce.boolean().default(true),
    ignore: z.coerce.boolean().default(false)
  }),
  agent: z
    .object({
      enabled: z.coerce.boolean().optional().default(false),
      requireConfirmation: z.coerce.boolean().optional().default(true),
      maxResults: z.coerce.number().int().min(3).max(10).optional().default(6),
      permissions: z
        .object({
          readMail: z.coerce.boolean().default(true),
          sendMailImages: z.coerce.boolean().default(true),
          readAttachments: z.coerce.boolean().default(true),
          sendAttachments: z.coerce.boolean().default(true),
          manageReadState: z.coerce.boolean().default(true),
          manageNotifications: z.coerce.boolean().default(true),
          runProcessing: z.coerce.boolean().default(true),
          checkMailboxes: z.coerce.boolean().default(true),
          reclassifyMail: z.coerce.boolean().default(true)
        })
        .partial()
        .optional()
        .default({})
    })
    .partial()
    .optional()
});

const notificationChannelsSchema = z.object({
  wechat: notificationSchema.optional(),
  qq: qqNotificationSchema.optional()
});

export function buildNotificationSettingsResponse(
  wechat: NotificationSettings,
  qq: PublicQqBotSettings,
  qqStatus: QqBotPublicStatus
) {
  return {
    ...wechat,
    wechat,
    qq,
    qqStatus
  };
}

function currentNotificationSettingsResponse() {
  return buildNotificationSettingsResponse(
    readSettings().notification,
    publicQqBotSettings(readQqBotConfig()),
    getQqManagerStatus()
  );
}
const panelReadSchema = z.object({
  panelRead: z.coerce.boolean()
});

const bulkPanelReadSchema = z.object({
  category: z.enum(["important", "secondary", "ignore"]),
  mailboxId: z.string().trim().min(1).default("all")
});

const bulkPanelReadUndoSchema = z.object({
  operationId: z.string().uuid()
});

const notificationChannels = new Set<NotificationChannel>(["wechat", "qq"]);
const notificationStatuses = new Set<NotificationDeliveryStatus | "failed">([
  "pending",
  "sending",
  "sent",
  "retry",
  "paused",
  "failed"
]);

const loginSchema = z.object({
  password: z.string().min(1, "请输入登录密码")
});

const authPasswordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(8, "新密码至少 8 位")
});

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<unknown> | unknown
) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function emailListItem(email: ProcessedEmail) {
  return {
    id: email.id,
    mailboxId: email.mailboxId,
    subject: email.subject,
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    receivedAt: email.receivedAt,
    processedAt: email.processedAt,
    category: email.category,
    summaryZh: email.summaryZh,
    reasonZh: email.reasonZh,
    actionItemsZh: email.actionItemsZh,
    panelRead: email.panelRead ?? email.category === "ignore",
    panelReadAt: email.panelReadAt,
    readMarked: email.readMarked,
    readMarkNote: email.readMarkNote,
    qqNotification: getEmailNotificationSummary(email.id, "qq")
  };
}

function emailDetailItem(email: ProcessedEmail) {
  return {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore",
    qqNotification: getEmailNotificationSummary(email.id, "qq"),
    assetToken: createEmailAssetToken(email.id)
  };
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function emailAssetSigningKey() {
  const auth = readSettings().auth;
  return `${auth.passwordHash}.${auth.passwordSalt}.${auth.passwordIterations}`;
}

function signEmailAssetPayload(payload: string) {
  return createHmac("sha256", emailAssetSigningKey()).update(payload).digest("base64url");
}

function createEmailAssetToken(emailId: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      emailId,
      exp: now + EMAIL_ASSET_TOKEN_TTL_SECONDS
    })
  );
  return `${payload}.${signEmailAssetPayload(payload)}`;
}

function verifyEmailAssetToken(emailId: string, token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = signEmailAssetPayload(payload);
  const expected = Buffer.from(expectedSignature, "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as { emailId?: string; exp?: number };
    return parsed.emailId === emailId && Boolean(parsed.exp && parsed.exp >= Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}

function authorizeEmailAsset(req: express.Request, res: express.Response, emailId: string) {
  const token = String(req.query.token || "");
  if (!emailId || !verifyEmailAssetToken(emailId, token)) {
    res.status(401).json({ error: "图片访问令牌无效或已过期。" });
    return null;
  }

  const email = getProcessedEmailById(emailId);
  if (!email) {
    res.status(404).json({ error: "邮件不存在。" });
    return null;
  }
  return email;
}

function buildDashboard(mailboxId?: string) {
  const dashboard = getDashboardData(mailboxId);
  const { state } = dashboard;

  return {
    settings: {
      ai: publicAiSettings(state.settings.ai),
      system: state.settings.system,
      notification: state.settings.notification,
      auth: publicAuthSettings(state.settings.auth)
    },
    mailboxes: state.mailboxes.map(publicMailbox),
    counts: dashboard.counts,
    unreadCounts: dashboard.unreadCounts,
    total: dashboard.total,
    allTotal: dashboard.allTotal,
    recentEmails: dashboard.recentEmails.map(emailListItem),
    runs: state.runs.slice(0, 10),
    processorRunning: isProcessorRunning(),
    currentRun: dashboard.currentRun
  };
}

router.get(
  "/health",
  asyncRoute((_req, res) => {
    res.json({ ok: true, processorRunning: isProcessorRunning() });
  })
);

router.get(
  "/qq-assets/:token.png",
  asyncRoute((req, res) => {
    const asset = resolveQqMarkdownAsset(
      String(req.params.token || ""),
      String(req.query.expires || ""),
      String(req.query.signature || "")
    );
    if (!asset) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("X-Robots-Tag", "noindex, noimageindex, noarchive");
    res.setHeader(
      "Cache-Control",
      `public, max-age=${Math.max(0, asset.expires - Math.floor(Date.now() / 1000))}, immutable, no-transform`
    );
    res.sendFile(asset.file);
  })
);

router.get(
  "/auth/session",
  asyncRoute((req, res) => {
    res.json({
      authenticated: isAuthenticated(req),
      auth: publicAuthSettings(readSettings().auth)
    });
  })
);

router.post(
  "/auth/login",
  asyncRoute((req, res) => {
    if (!checkLoginAllowed(req, res)) return;

    const parsed = loginSchema.parse(req.body);
    if (!verifyAdminPassword(parsed.password)) {
      registerLoginFailure(req);
      res.status(401).json({ error: "登录密码不正确。" });
      return;
    }

    registerLoginSuccess(req);
    setAuthCookie(req, res);
    res.json({
      authenticated: true,
      auth: publicAuthSettings(readSettings().auth)
    });
  })
);

router.post(
  "/auth/logout",
  asyncRoute((req, res) => {
    clearAuthCookie(req, res);
    res.json({ authenticated: false });
  })
);

router.get(
  "/email-assets/image",
  asyncRoute(async (req, res) => {
    const emailId = String(req.query.emailId || "");
    if (!authorizeEmailAsset(req, res, emailId)) return;

    const url = String(req.query.url || "");
    if (!url) {
      res.status(400).json({ error: "缺少图片地址。" });
      return;
    }

    sendImageAsset(res, await fetchRemoteEmailImage(url));
  })
);

router.get(
  "/emails/:id/inline-image",
  asyncRoute(async (req, res) => {
    const email = authorizeEmailAsset(req, res, String(req.params.id));
    if (!email) return;

    const cid = String(req.query.cid || "");
    if (!cid) {
      res.status(400).json({ error: "缺少内嵌图片 ID。" });
      return;
    }

    const asset = await findInlineEmailImage(email, cid);
    if (!asset) {
      res.status(404).json({ error: "内嵌图片不存在。" });
      return;
    }

    sendImageAsset(res, asset);
  })
);

router.use(requireAuth);

router.get("/events", handleAppEvents);

router.get(
  "/dashboard",
  asyncRoute((req, res) => {
    res.json(buildDashboard(String(req.query.mailboxId ?? "all")));
  })
);

router.get(
  "/ai-usage",
  asyncRoute((req, res) => {
    const range = aiUsageRangeSchema.parse(req.query.range ?? "today");
    const window = resolveUsageWindow({
      range,
      startAt: typeof req.query.startAt === "string" ? req.query.startAt : undefined,
      endAt: typeof req.query.endAt === "string" ? req.query.endAt : undefined
    });
    res.json(queryAiUsageDashboard({
      range,
      ...window,
      timeZone: typeof req.query.timeZone === "string" ? req.query.timeZone : undefined,
      recentLimit: 40
    }));
  })
);

router.get(
  "/ai-usage/billing",
  asyncRoute((_req, res) => {
    res.json(publicAiBillingSettings());
  })
);

router.put(
  "/ai-usage/billing",
  asyncRoute((req, res) => {
    res.json(updateAiBillingSettings(aiBillingSchema.parse(req.body)));
  })
);

router.post(
  "/ai-usage/costs/sync",
  asyncRoute(async (req, res) => {
    const parsed = aiCostSyncSchema.parse(req.body);
    const billing = publicAiBillingSettings();
    if (billing.provider === "none") {
      res.status(400).json({ error: "请先选择 OpenAI 或 Anthropic 账单来源。" });
      return;
    }
    const adminKey = readAiBillingAdminKey(billing.provider);
    if (!adminKey) {
      res.status(400).json({ error: "请先保存账单管理员密钥。" });
      return;
    }
    const window = resolveUsageWindow(parsed);
    const startAt = window.startAt ?? firstAiUsageOccurredAt() ?? new Date(Date.parse(window.endAt) - 86400000).toISOString();
    const amounts = await queryProviderCosts({
      provider: billing.provider,
      adminKey,
      startAt,
      endAt: window.endAt
    });
    res.json(saveAiCostSnapshot({
      provider: billing.provider,
      range: parsed.range,
      startAt,
      endAt: window.endAt,
      amounts,
      queriedAt: new Date().toISOString()
    }));
  })
);

router.get(
  "/settings/ai",
  asyncRoute((_req, res) => {
    res.json(publicAiSettings(readSettings().ai));
  })
);

router.put(
  "/settings/ai",
  requireChangedAdminPassword,
  asyncRoute((req, res) => {
    const parsed = aiSchema.parse(req.body);
    res.json(publicAiSettings(updateAiSettings(parsed)));
  })
);

router.post(
  "/settings/ai/test",
  requireChangedAdminPassword,
  asyncRoute(async (req, res) => {
    const parsed = aiSchema.parse(req.body);
    const saved = readSettings().ai;
    const settings = withSavedAiTestKeys(parsed, saved);

    if (!settings.apiKey.trim()) {
      res.status(400).json({ error: "请输入 API Key 后再测试。" });
      return;
    }

    const result = await classifyEmail(
      {
        mailboxId: "test",
        externalUid: "test",
        subject: "测试邮件：明天下午三点确认合同",
        fromName: "系统测试",
        fromAddress: "test@example.com",
        toText: "me@example.com",
        receivedAt: new Date().toISOString(),
        originalText:
          "这是一封用于测试 AI API 连通性的邮件。请判断它是否重要，并用中文返回简短概况。"
      },
      settings,
      { timeoutMs: 20000, usageScope: "system", usagePurpose: "system_test" }
    );

    const diagnostics = buildAiTestDiagnostics(settings, result);
    res.json({
      ok: true,
      message: `AI API 测试成功，模型返回分类：${result.category}`,
      ...diagnostics,
      result
    });
  })
);

router.get(
  "/settings/system",
  asyncRoute((_req, res) => {
    res.json(readSettings().system);
  })
);

router.put(
  "/settings/system",
  asyncRoute((req, res) => {
    const parsed = systemSchema.parse(req.body);
    res.json(updateSystemSettings(parsed));
  })
);

router.get(
  "/settings/auth",
  asyncRoute((_req, res) => {
    res.json(publicAuthSettings(readSettings().auth));
  })
);

router.put(
  "/settings/auth/password",
  asyncRoute((req, res) => {
    const parsed = authPasswordSchema.parse(req.body);
    res.json(publicAuthSettings(updateAuthPassword(parsed.currentPassword, parsed.newPassword)));
  })
);

router.get(
  "/settings/notification",
  asyncRoute((_req, res) => {
    res.json(currentNotificationSettingsResponse());
  })
);

router.put(
  "/settings/notification",
  requireChangedAdminPassword,
  asyncRoute(async (req, res) => {
    const isChannelPayload = Boolean(
      req.body &&
      typeof req.body === "object" &&
      ("wechat" in req.body || "qq" in req.body)
    );
    if (!isChannelPayload) {
      const parsed = notificationSchema.parse(req.body);
      updateNotificationSettings(parsed);
      res.json(currentNotificationSettingsResponse());
      return;
    }

    const parsed = notificationChannelsSchema.parse(req.body);
    if (parsed.wechat) updateNotificationSettings(parsed.wechat);
    if (parsed.qq) {
      updateQqBotSettings(parsed.qq);
      resumePausedNotificationDeliveries("qq");
      await restartQqManager().catch(() => undefined);
      scheduleNotificationDispatch(0);
    }
    res.json(currentNotificationSettingsResponse());
  })
);

router.post(
  "/settings/notification/test",
  asyncRoute(async (req, res) => {
    const parsed = notificationSchema.parse(req.body);
    await sendClawbotTestNotification(parsed);
    schedulePendingEmailNotificationRetry(500);
    res.json({
      ok: true,
      message: "微信 ClawBot 测试通知已发送。"
    });
  })
);

router.get(
  "/qq/status",
  asyncRoute((_req, res) => {
    res.json({
      settings: publicQqBotSettings(readQqBotConfig()),
      status: getQqManagerStatus()
    });
  })
);

router.get(
  "/qq/agent/runs",
  asyncRoute((req, res) => {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit ?? 12) || 12)));
    res.json({ items: readQqAgentRuns(limit) });
  })
);

router.post(
  "/qq/start",
  asyncRoute(async (_req, res) => {
    await startQqManager();
    res.status(202).json(getQqManagerStatus());
  })
);

router.post(
  "/qq/stop",
  asyncRoute(async (_req, res) => {
    await stopQqManager();
    res.json(getQqManagerStatus());
  })
);

router.post(
  ["/qq/bind", "/qq/rebind"],
  asyncRoute(async (_req, res) => {
    const binding = await createQqRebindChallenge();
    res.status(202).json({ binding, status: getQqManagerStatus() });
  })
);

router.post(
  "/qq/test",
  asyncRoute(async (_req, res) => {
    await sendQqTestNotification();
    res.json({ ok: true, message: "QQ 测试通知已发送。", status: getQqManagerStatus() });
  })
);
function notificationApiUrl() {
  return defaultWeclawApiUrl;
}

router.get(
  "/weclaw/status",
  asyncRoute(async (_req, res) => {
    res.json(await getWeclawStatus(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/start",
  asyncRoute(async (_req, res) => {
    res.status(202).json(await startWeclaw(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/stop",
  asyncRoute(async (_req, res) => {
    res.json(await stopWeclaw(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/rebind",
  asyncRoute(async (_req, res) => {
    res.status(202).json(await rebindWeclaw(notificationApiUrl()));
  })
);

router.get(
  "/weclaw/logs",
  asyncRoute((req, res) => {
    res.json(getWeclawLogTail(Number(req.query.lines ?? 160)));
  })
);

router.get(
  "/mailboxes",
  asyncRoute((_req, res) => {
    res.json(readMailboxes().map(publicMailbox));
  })
);

router.post(
  "/mailboxes",
  requireChangedAdminPassword,
  asyncRoute((req, res) => {
    const parsed = mailboxSchema.parse(req.body);
    res.status(201).json(upsertMailbox(parsed).map(publicMailbox));
  })
);

router.put(
  "/mailboxes/:id",
  requireChangedAdminPassword,
  asyncRoute((req, res) => {
    const parsed = mailboxSchema.parse({ ...req.body, id: req.params.id });
    res.json(upsertMailbox(parsed).map(publicMailbox));
  })
);

router.delete(
  "/mailboxes/:id",
  asyncRoute((req, res) => {
    res.json({
      ok: true,
      state: {
        mailboxes: removeMailbox(String(req.params.id)).mailboxes.map(publicMailbox)
      }
    });
  })
);

router.post(
  "/mailboxes/:id/test",
  asyncRoute(async (req, res) => {
    const mailbox = readMailboxes().find((item) => item.id === req.params.id);
    if (!mailbox) {
      res.status(404).json({ error: "邮箱不存在" });
      return;
    }

    const result = mailbox.protocol === "imap"
      ? await fetchUnreadImap(mailbox, 1)
      : await fetchUnreadPop3(mailbox, 1);

    res.json({
      ok: true,
      message: result.length
        ? `连接成功，并找到 ${result.length} 封待处理邮件。`
        : "连接成功，当前没有新的待处理邮件。"
    });
  })
);

router.get(
  "/emails",
  asyncRoute((req, res) => {
    const category = String(req.query.category ?? "");
    const mailboxId = String(req.query.mailboxId ?? "all");
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0) || 0));
    const limit = Math.min(100, Math.max(20, Math.floor(Number(req.query.limit ?? 40) || 40)));
    const allowedCategories = new Set(["important", "secondary", "ignore"]);

    const result = queryProcessedEmails({
      category: allowedCategories.has(category) ? category : undefined,
      mailboxId,
      q,
      offset,
      limit
    });
    const items = result.items.map(emailListItem);
    res.json({
      items,
      total: result.total,
      offset,
      limit,
      hasMoreBefore: result.hasMoreBefore,
      hasMoreAfter: result.hasMoreAfter
    });
  })
);

router.get(
  "/notifications",
  asyncRoute((req, res) => {
    const channel = String(req.query.channel ?? "qq");
    const status = String(req.query.status ?? "failed");
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0) || 0));
    const limit = Math.min(100, Math.max(10, Math.floor(Number(req.query.limit ?? 40) || 40)));
    const result = queryNotificationDeliveries({
      channel: notificationChannels.has(channel as NotificationChannel) ? (channel as NotificationChannel) : "qq",
      status: notificationStatuses.has(status as NotificationDeliveryStatus | "failed")
        ? (status as NotificationDeliveryStatus | "failed")
        : "failed",
      offset,
      limit
    });
    res.json({
      items: result.items,
      total: result.total,
      offset,
      limit,
      hasMoreBefore: result.hasMoreBefore,
      hasMoreAfter: result.hasMoreAfter
    });
  })
);

router.post(
  "/notifications/qq/retry-all",
  asyncRoute((_req, res) => {
    const updatedCount = retryNotificationDeliveriesByChannel("qq");
    if (updatedCount > 0) scheduleNotificationDispatch(0);
    res.json({ updatedCount });
  })
);

router.post(
  "/notifications/:id/retry",
  asyncRoute((req, res) => {
    const delivery = retryNotificationDelivery(String(req.params.id));
    if (!delivery) {
      res.status(404).json({ error: "通知记录不存在" });
      return;
    }
    scheduleNotificationDispatch(0);
    res.json(delivery);
  })
);

router.post(
  "/notifications/:id/pause",
  asyncRoute((req, res) => {
    const delivery = pauseNotificationDelivery(String(req.params.id));
    if (!delivery) {
      res.status(404).json({ error: "通知记录不存在" });
      return;
    }
    res.json(delivery);
  })
);

router.post(
  "/notifications/:id/resume",
  asyncRoute((req, res) => {
    const delivery = resumeNotificationDelivery(String(req.params.id));
    if (!delivery) {
      res.status(404).json({ error: "通知记录不存在" });
      return;
    }
    scheduleNotificationDispatch(0);
    res.json(delivery);
  })
);

function sendImageAsset(res: express.Response, asset: { content: Buffer; contentType: string }) {
  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Content-Length", asset.content.length);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(asset.content);
}

router.get(
  "/email-assets/image",
  asyncRoute(async (req, res) => {
    const url = String(req.query.url || "");
    if (!url) {
      res.status(400).json({ error: "缺少图片地址" });
      return;
    }

    sendImageAsset(res, await fetchRemoteEmailImage(url));
  })
);

router.get(
  "/emails/:id/inline-image",
  asyncRoute(async (req, res) => {
    const email = getProcessedEmailById(String(req.params.id));
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }

    const cid = String(req.query.cid || "");
    if (!cid) {
      res.status(400).json({ error: "缺少内嵌图片 ID" });
      return;
    }

    const asset = await findInlineEmailImage(email, cid);
    if (!asset) {
      res.status(404).json({ error: "内嵌图片不存在" });
      return;
    }

    sendImageAsset(res, asset);
  })
);

router.get(
  "/emails/:id",
  asyncRoute((req, res) => {
    const email = getProcessedEmailById(String(req.params.id));
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }
    res.json(emailDetailItem(email));
  })
);

router.patch(
  "/emails/read-state",
  asyncRoute((req, res) => {
    const parsed = bulkPanelReadSchema.parse(req.body);
    res.json(
      markProcessedEmailsPanelRead({
        category: parsed.category,
        mailboxId: parsed.mailboxId
      })
    );
  })
);
router.patch(
  "/emails/read-state/undo",
  asyncRoute((req, res) => {
    const parsed = bulkPanelReadUndoSchema.parse(req.body);
    const result = undoProcessedEmailsPanelRead(parsed.operationId);
    if (!result) {
      res.status(410).json({ error: "撤回时限已结束，请刷新邮件状态" });
      return;
    }
    res.json(result);
  })
);
router.patch(
  "/emails/:id/read-state",
  asyncRoute((req, res) => {
    const parsed = panelReadSchema.parse(req.body);
    const email = updateProcessedEmailPanelRead(String(req.params.id), parsed.panelRead);
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }
    res.json(emailDetailItem(email));
  })
);

router.get(
  "/runs",
  asyncRoute((_req, res) => {
    res.json(readProcessingRuns());
  })
);

router.post(
  "/process/run",
  asyncRoute(async (req, res) => {
    const run = await processMailboxes({ mailboxId: req.body?.mailboxId });
    res.status(202).json(run);
  })
);

router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "参数错误", details: error.flatten() });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
    ? Number((error as { statusCode: number }).statusCode)
    : 500;
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ error: message });
});

export default router;
