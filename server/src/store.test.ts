import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAiProtocol } from "./ai-protocol";
import type { AiSettings, ProcessedEmail } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-store-test-${process.pid}`);
process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-credential-encryption-key";
const {
  addProcessedEmail,
  claimNotificationDeliveries,
  consumeQqBindingChallenge,
  createQqEmailReadAction,
  findQqEmailReadAction,
  findQqNotificationReference,
  normalizeAiSettings,
  publicAiSettings,
  publicAiBillingSettings,
  publicQqBotSettings,
  pauseNotificationDelivery,
  queryNotificationDeliveries,
  recordQqNotificationReference,
  readMailboxes,
  readMailCursor,
  readFetchedMails,
  readPendingFetchedMails,
  readProcessingRuns,
  readQqBotBindings,
  readQqBotConfig,
  readQqState,
  resumePausedNotificationDeliveries,
  readSettings,
  readAiBillingAdminKey,
  readState,
  readStoredCredentialEnvelope,
  updateAiSettings,
  updateAiBillingSettings,
  updateProcessedEmailReadMark,
  updateQqBotSettings,
  updateQqState,
  enqueueNotificationDelivery,
  listNotificationDeliveries,
  markProcessedEmailsPanelRead,
  retryNotificationDeliveriesByChannel,
  retryNotificationDelivery,
  resumeNotificationDelivery,
  queryProcessedEmails,
  readQqAgentRuns,
  recordQqAgentEvent,
  startQqAgentRun,
  finishQqAgentRun,
  queryAiUsageDashboard,
  recordAiUsageEvent,
  saveAiCostSnapshot,
  saveMailCursor,
  commitFetched,
  commitProcessedEmailWithNotifications,
  fetchedMailExternalUid,
  getProcessedEmailById,
  updateState,
  undoProcessedEmailsPanelRead
} = await import("./store");

const primaryApiKey = "primary-placeholder-secret";
const multimodalApiKey = "multimodal-placeholder-secret";

const settings: AiSettings = {
  providerName: "Test provider",
  baseUrl: "https://api.example.test/v1",
  apiKey: primaryApiKey,
  model: "test-model",
  temperature: 0.1,
  multimodalEnabled: true,
  multimodalBaseUrl: "https://api.example.test/v1",
  multimodalModel: "test-vision-model",
  multimodalApiKey,
  multimodalMaxAttachmentMb: 8,
  multimodalMaxTotalMb: 18
};

function makeStoreEmail(input: {
  id: string;
  mailboxId: string;
  receivedAt?: string;
  processedAt?: string;
  category?: ProcessedEmail["category"];
}): ProcessedEmail {
  return {
    id: input.id,
    mailboxId: input.mailboxId,
    externalUid: input.id,
    subject: input.id,
    receivedAt: input.receivedAt,
    processedAt: input.processedAt ?? new Date().toISOString(),
    category: input.category ?? "important",
    summaryZh: input.id,
    reasonZh: "store ordering test",
    actionItemsZh: [],
    originalText: "unique body " + input.id,
    panelRead: false,
    readMarked: true
  };
}

test("public AI settings redact both API keys and expose only safe key metadata", () => {
  const publicSettings = publicAiSettings(settings);
  const serialized = JSON.stringify(publicSettings);

  assert.equal(publicSettings.apiKey, "");
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal(publicSettings.maskedApiKey === primaryApiKey, false);
  assert.equal(serialized.includes(primaryApiKey), false);

  assert.equal(publicSettings.multimodalApiKey, "");
  assert.equal(publicSettings.hasMultimodalApiKey, true);
  assert.equal(publicSettings.maskedMultimodalApiKey === multimodalApiKey, false);
  assert.equal(serialized.includes(multimodalApiKey), false);
  assert.match(publicSettings.maskedMultimodalApiKey, /^mul.+cret$/);
});

test("normalizes legacy settings with migration-safe protocol defaults", () => {
  const legacy = normalizeAiSettings({
    providerName: "Legacy GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "",
    model: "glm-5.2",
    temperature: 0.1,
    multimodalEnabled: true,
    multimodalBaseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    multimodalModel: "glm-5v-turbo",
    multimodalMaxAttachmentMb: 8,
    multimodalMaxTotalMb: 18
  });

  assert.equal(legacy.providerPreset, "custom");
  assert.equal(legacy.protocol, "auto");
  assert.equal(legacy.multimodalProtocol, "auto");
  assert.equal(legacy.multimodalApiKey, "");
  assert.equal(resolveAiProtocol(legacy, "text"), "anthropic");
  assert.equal(resolveAiProtocol(legacy, "multimodal"), "openai-chat");
});

test("normalizes unsupported stored protocols to auto", () => {
  const normalized = normalizeAiSettings({
    protocol: "not-a-protocol" as AiSettings["protocol"],
    multimodalProtocol: "not-a-protocol" as AiSettings["multimodalProtocol"]
  });

  assert.equal(normalized.protocol, "auto");
  assert.equal(normalized.multimodalProtocol, "auto");
});

test("retains both saved keys when an update submits blank key fields", () => {
  updateAiSettings({
    ...settings,
    apiKey: "stored-primary-value",
    multimodalApiKey: "stored-multimodal-value"
  });
  updateAiSettings({ apiKey: "", multimodalApiKey: "" });

  const saved = readState().settings.ai;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");

  assert.equal(digest(saved.apiKey), digest("stored-primary-value"));
  assert.equal(digest(saved.multimodalApiKey ?? ""), digest("stored-multimodal-value"));
});

test("records usage by business scope and preserves historical provider-model snapshots", () => {
  recordAiUsageEvent({
    scope: "email",
    purpose: "email_classification",
    provider: "Provider Alpha",
    protocol: "openai-responses",
    model: "model-alpha",
    inputTokens: 100,
    outputTokens: 25,
    cachedInputTokens: 40,
    cacheWriteTokens: 5,
    totalTokens: 125,
    usageReported: true,
    success: true,
    latencyMs: 900,
    occurredAt: "2040-01-02T10:15:00.000Z"
  });
  recordAiUsageEvent({
    scope: "agent",
    purpose: "agent_orchestration",
    provider: "Provider Beta",
    protocol: "anthropic",
    model: "model-beta",
    inputTokens: 50,
    outputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 60,
    usageReported: true,
    success: true,
    latencyMs: 1200,
    occurredAt: "2040-01-02T11:30:00.000Z"
  });
  recordAiUsageEvent({
    scope: "agent",
    purpose: "agent_response",
    provider: "Provider Beta",
    protocol: "anthropic",
    model: "model-beta",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    usageReported: false,
    success: false,
    latencyMs: 30000,
    error: "request timed out",
    occurredAt: "2040-01-02T11:31:00.000Z"
  });

  const dashboard = queryAiUsageDashboard({
    range: "today",
    startAt: "2040-01-02T00:00:00.000Z",
    endAt: "2040-01-03T00:00:00.000Z",
    timeZone: "UTC"
  });

  assert.equal(dashboard.totals.calls, 3);
  assert.equal(dashboard.totals.successfulCalls, 2);
  assert.equal(dashboard.totals.failedCalls, 1);
  assert.equal(dashboard.totals.inputTokens, 150);
  assert.equal(dashboard.totals.outputTokens, 35);
  assert.equal(dashboard.totals.cachedInputTokens, 40);
  assert.equal(dashboard.totals.totalTokens, 185);
  assert.equal(dashboard.totals.cacheHitRate, 40 / 150);
  assert.equal(dashboard.byScope.find((item) => item.scope === "email")?.calls, 1);
  assert.equal(dashboard.byScope.find((item) => item.scope === "agent")?.calls, 2);
  assert.deepEqual(dashboard.byModel.map((item) => item.model).sort(), ["model-alpha", "model-beta"]);
  assert.deepEqual(dashboard.timeline.map((item) => item.bucket), ["2040-01-02T10", "2040-01-02T11"]);
  assert.equal(dashboard.recent[0]?.success, false);
});

test("encrypts provider admin keys and retains the latest cost snapshot per range", () => {
  const saved = updateAiBillingSettings({ provider: "openai", adminKey: "sk-admin-test-secret" });
  assert.equal(saved.provider, "openai");
  assert.equal(saved.hasAdminKey, true);
  assert.equal(JSON.stringify(saved).includes("sk-admin-test-secret"), false);
  assert.equal(readAiBillingAdminKey("openai"), "sk-admin-test-secret");
  assert.equal(publicAiBillingSettings().maskedAdminKey, "已安全保存");

  saveAiCostSnapshot({
    provider: "openai",
    range: "today",
    startAt: "2040-01-02T00:00:00.000Z",
    endAt: "2040-01-03T00:00:00.000Z",
    amounts: [{ currency: "USD", amount: 1.2345 }],
    queriedAt: "2040-01-03T00:01:00.000Z"
  });
  const dashboard = queryAiUsageDashboard({
    range: "today",
    startAt: "2040-01-02T00:00:00.000Z",
    endAt: "2040-01-03T00:00:00.000Z",
    timeZone: "UTC"
  });
  assert.deepEqual(dashboard.billing.latestCost?.amounts, [{ currency: "USD", amount: 1.2345 }]);
});


test("QQ AppSecret is encrypted and never returned by public settings", () => {
  updateQqBotSettings({ appId: "1900000000", appSecret: "test-secret", enabled: false });
  const config = readQqBotConfig();
  const publicSettings = publicQqBotSettings(config);
  const envelope = readStoredCredentialEnvelope("qq-app-secret");

  assert.equal(publicSettings.hasAppSecret, true);
  assert.deepEqual(Object.keys(publicSettings).sort(), [
    "agent",
    "appId",
    "enabled",
    "hasAppSecret",
    "maskedAppSecret",
    "notifyCategories",
    "quoteImageMarksRead"
  ]);
  assert.equal(JSON.stringify(publicSettings).includes("test-secret"), false);
  assert.equal(JSON.stringify(publicSettings).includes(envelope), false);
  assert.equal("appSecret" in publicSettings, false);
  assert.equal("encryptedAppSecret" in publicSettings, false);
  assert.deepEqual(publicSettings.agent, {
    enabled: false,
    requireConfirmation: true,
    maxResults: 6,
    permissions: {
      readMail: true,
      sendMailImages: true,
      readAttachments: true,
      sendAttachments: true,
      manageReadState: true,
      manageNotifications: true,
      runProcessing: true,
      checkMailboxes: true,
      reclassifyMail: true
    }
  });
  assert.equal(config.encryptedAppSecret, envelope);
  assert.equal(envelope.includes("test-secret"), false);
});

test("blank QQ AppSecret updates retain the saved credential", () => {
  updateQqBotSettings({ appId: "1900000000", appSecret: "retained-test-secret", enabled: false });
  updateQqBotSettings({ appId: "1900000001", appSecret: "", enabled: true });

  const config = readQqBotConfig();
  const publicSettings = publicQqBotSettings(config);
  assert.equal(config.appId, "1900000001");
  assert.equal(publicSettings.enabled, true);
  assert.equal(publicSettings.hasAppSecret, true);
  assert.equal(JSON.stringify(publicSettings).includes("retained-test-secret"), false);
});

test("QQ Agent mail-image permission persists when disabled", () => {
  try {
    updateQqBotSettings({ agent: { permissions: { sendMailImages: false } } });
    assert.equal(readQqBotConfig().agent.permissions.sendMailImages, false);
    assert.equal(publicQqBotSettings(readQqBotConfig()).agent.permissions.sendMailImages, false);
  } finally {
    updateQqBotSettings({ agent: { permissions: { sendMailImages: true } } });
  }
});

test("QQ settings and AppSecret roll back together when settings persistence fails", () => {
  updateQqBotSettings({ appId: "1900000100", appSecret: "old-test-secret", enabled: false });
  const before = readQqBotConfig();
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.exec(`
    CREATE TRIGGER reject_qq_settings_update
    BEFORE INSERT ON settings
    WHEN NEW.key = 'notification.qq'
    BEGIN
      SELECT RAISE(ABORT, 'forced QQ settings write failure');
    END;
  `);

  try {
    assert.throws(() =>
      updateQqBotSettings({ appId: "1900000101", appSecret: "new-test-secret", enabled: true })
    );
  } finally {
    sqlite.exec("DROP TRIGGER reject_qq_settings_update");
    sqlite.close();
  }

  assert.deepEqual(readQqBotConfig(), before);
  assert.equal(readStoredCredentialEnvelope("qq-app-secret"), before.encryptedAppSecret);
});

test("QQ binding challenge is consumed atomically and only once", () => {
  const challenge = {
    id: `challenge-${process.pid}`,
    salt: "test-salt",
    codeHash: "a".repeat(64),
    createdAt: "2026-08-16T00:00:00.000Z",
    expiresAt: "2026-08-16T00:10:00.000Z"
  };
  updateQqState("binding-challenge", challenge);

  const input = {
    id: "primary",
    userOpenId: "test-user-openid",
    friendshipStatus: "friend" as const,
    proactiveStatus: "unknown" as const,
    lastEventAt: "2026-08-16T00:05:00.000Z"
  };
  const first = consumeQqBindingChallenge(
    "binding-challenge",
    challenge.id,
    input,
    "2026-08-16T00:05:00.000Z"
  );
  const second = consumeQqBindingChallenge(
    "binding-challenge",
    challenge.id,
    { ...input, userOpenId: "should-not-replace" },
    "2026-08-16T00:05:01.000Z"
  );

  assert.equal(first?.userOpenId, "test-user-openid");
  assert.equal(second, undefined);
  assert.equal(readQqBotBindings().find((binding) => binding.id === "primary")?.userOpenId, "test-user-openid");
  assert.equal(
    readQqState<{ consumedAt?: string }>("binding-challenge")?.consumedAt,
    "2026-08-16T00:05:00.000Z"
  );
});

test("expired QQ binding challenges cannot replace a recipient", () => {
  updateQqState("binding-challenge", {
    id: "expired-challenge",
    expiresAt: "2026-08-16T00:00:00.000Z"
  });
  const result = consumeQqBindingChallenge(
    "binding-challenge",
    "expired-challenge",
    { id: "primary", userOpenId: "expired-user", friendshipStatus: "friend", proactiveStatus: "unknown" },
    "2026-08-16T00:00:01.000Z"
  );
  assert.equal(result, undefined);
  assert.equal(readQqBotBindings().find((binding) => binding.id === "primary")?.userOpenId, "test-user-openid");
});
test("bulk panel read updates only the selected mailbox and category", () => {
  const suffix = String(process.pid);
  const targetMailbox = "bulk-target-" + suffix;
  const otherMailbox = "bulk-other-" + suffix;
  const makeEmail = (
    id: string,
    mailboxId: string,
    category: ProcessedEmail["category"]
  ): ProcessedEmail => ({
    id,
    mailboxId,
    externalUid: id,
    subject: id,
    processedAt: new Date().toISOString(),
    category,
    summaryZh: id,
    reasonZh: "bulk read test",
    actionItemsZh: [],
    originalText: "unique body " + id,
    panelRead: false,
    readMarked: true
  });

  addProcessedEmail(makeEmail("bulk-important-1-" + suffix, targetMailbox, "important"));
  addProcessedEmail(makeEmail("bulk-important-2-" + suffix, targetMailbox, "important"));
  addProcessedEmail(makeEmail("bulk-secondary-" + suffix, targetMailbox, "secondary"));
  addProcessedEmail(makeEmail("bulk-other-mailbox-" + suffix, otherMailbox, "important"));

  const alreadyRead = makeEmail("bulk-already-read-" + suffix, targetMailbox, "important");
  alreadyRead.panelRead = true;
  alreadyRead.panelReadAt = "2026-08-16T00:00:00.000Z";
  addProcessedEmail(alreadyRead);

  const result = markProcessedEmailsPanelRead({ category: "important", mailboxId: targetMailbox });
  assert.equal(result.updatedCount, 2);
  assert.equal(typeof result.operationId, "string");

  const targetImportant = queryProcessedEmails({
    category: "important",
    mailboxId: targetMailbox,
    limit: 20
  }).items;
  const changedIds = new Set([
    "bulk-important-1-" + suffix,
    "bulk-important-2-" + suffix
  ]);
  assert.equal(
    targetImportant
      .filter((email) => changedIds.has(email.id))
      .every((email) => email.panelRead && email.panelReadAt === result.updatedAt),
    true
  );
  assert.equal(targetImportant.find((email) => email.id === alreadyRead.id)?.panelReadAt, alreadyRead.panelReadAt);
  assert.equal(
    queryProcessedEmails({ category: "secondary", mailboxId: targetMailbox, limit: 20 }).items[0]?.panelRead,
    false
  );
  assert.equal(
    queryProcessedEmails({ category: "important", mailboxId: otherMailbox, limit: 20 }).items[0]?.panelRead,
    false
  );
  assert.equal(
    markProcessedEmailsPanelRead({ category: "important", mailboxId: targetMailbox }).updatedCount,
    0
  );

  const undoResult = undoProcessedEmailsPanelRead(result.operationId!);
  assert.equal(undoResult?.restoredCount, 2);
  const afterUndo = queryProcessedEmails({
    category: "important",
    mailboxId: targetMailbox,
    limit: 20
  }).items;
  assert.equal(afterUndo.filter((email) => changedIds.has(email.id)).every((email) => !email.panelRead), true);
  assert.equal(afterUndo.find((email) => email.id === alreadyRead.id)?.panelRead, true);
  assert.equal(undoProcessedEmailsPanelRead(result.operationId!), undefined);
});

test("processed email queries show newest received mail first across mailboxes", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const first = `received-first-${suffix}`;
  const second = `received-second-${suffix}`;
  const third = `received-third-${suffix}`;

  addProcessedEmail(makeStoreEmail({
    id: third,
    mailboxId: `mailbox-b-${suffix}`,
    receivedAt: "2026-08-31T10:00:00.000Z",
    processedAt: "2026-08-31T10:00:01.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: first,
    mailboxId: `mailbox-a-${suffix}`,
    receivedAt: "2026-08-31T08:00:00.000Z",
    processedAt: "2026-08-31T10:00:02.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: second,
    mailboxId: `mailbox-c-${suffix}`,
    receivedAt: "2026-08-31T09:00:00.000Z",
    processedAt: "2026-08-31T10:00:03.000Z"
  }));

  const result = queryProcessedEmails({
    category: "important",
    mailboxId: "all",
    q: suffix,
    limit: 20
  });

  assert.deepEqual(result.items.map((email) => email.id), [third, second, first]);
});

test("processed email queries filter by received time window", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const before = `range-before-${suffix}`;
  const insideOld = `range-inside-old-${suffix}`;
  const insideNew = `range-inside-new-${suffix}`;
  const after = `range-after-${suffix}`;

  addProcessedEmail(makeStoreEmail({
    id: before,
    mailboxId: `range-mailbox-${suffix}`,
    receivedAt: "2026-08-30T23:59:59.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: insideOld,
    mailboxId: `range-mailbox-${suffix}`,
    receivedAt: "2026-08-31T08:00:00.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: insideNew,
    mailboxId: `range-mailbox-${suffix}`,
    receivedAt: "2026-08-31T10:00:00.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: after,
    mailboxId: `range-mailbox-${suffix}`,
    receivedAt: "2026-09-01T00:00:00.000Z"
  }));

  const result = queryProcessedEmails({
    mailboxId: `range-mailbox-${suffix}`,
    since: "2026-08-31T00:00:00.000Z",
    until: "2026-09-01T00:00:00.000Z",
    limit: 20
  });

  assert.deepEqual(result.items.map((email) => email.id), [insideNew, insideOld]);
});

test("FTS email search indexes full body text and attachment filenames", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const bodyNeedle = `bodyneedle${suffix.replace(/\D/g, "")}`;
  const attachmentNeedle = `attachmentneedle${suffix.replace(/\D/g, "")}`;
  const target = makeStoreEmail({
    id: `fts-email-${suffix}`,
    mailboxId: `fts-mailbox-${suffix}`,
    receivedAt: "2026-08-31T12:00:00.000Z"
  });
  target.originalText = `The private body contains ${bodyNeedle} for full text lookup.`;
  target.attachments = [{
    id: "attachment-1",
    filename: `${attachmentNeedle}.pdf`,
    contentType: "application/pdf",
    size: 1024,
    related: false,
    supportedForVision: true
  }];
  addProcessedEmail(target);

  assert.equal(queryProcessedEmails({ q: bodyNeedle, limit: 10 }).items[0]?.id, target.id);
  assert.equal(queryProcessedEmails({ q: attachmentNeedle, limit: 10 }).items[0]?.id, target.id);
});

test("QQ Agent runs group tool events and redact stored mail body excerpts", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `run-user-${suffix}`;
  const run = startQqAgentRun({ userOpenId, message: `搜索学校邮件 ${suffix}` });
  recordQqAgentEvent({
    runId: run.id,
    userOpenId,
    kind: "tool",
    toolName: "mail.getDetail",
    status: "success",
    message: "工具执行成功",
    data: { emailId: `email-${suffix}`, bodyExcerpt: "private email body", query: "school" },
    step: 2,
    durationMs: 42
  });
  finishQqAgentRun(run.id, { status: "success", reply: "找到一封学校邮件" });

  const stored = readQqAgentRuns(20).find((item) => item.id === run.id);
  assert.equal(stored?.status, "success");
  assert.equal(stored?.toolCallCount, 1);
  assert.equal(stored?.stepCount, 2);
  assert.equal(stored?.events[0]?.durationMs, 42);
  assert.equal((stored?.events[0]?.data as { bodyExcerpt?: string }).bodyExcerpt, "[REDACTED]");
  assert.equal(JSON.stringify(stored).includes("private email body"), false);
});

test("email state updates preserve QQ button actions and message references", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const email: ProcessedEmail = {
    id: `qq-action-email-${suffix}`,
    mailboxId: `qq-action-mailbox-${suffix}`,
    externalUid: `qq-action-uid-${suffix}`,
    subject: "QQ action persistence",
    processedAt: new Date().toISOString(),
    category: "important",
    summaryZh: "verify upsert foreign-key behavior",
    reasonZh: "test",
    actionItemsZh: [],
    originalText: "test",
    panelRead: false,
    readMarked: false
  };
  assert.ok(addProcessedEmail(email));
  const userOpenId = `qq-action-user-${suffix}`;
  const action = createQqEmailReadAction({ emailId: email.id, userOpenId });
  recordQqNotificationReference({
    emailId: email.id,
    userOpenId,
    messageId: `qq-action-message-${suffix}`
  });

  updateProcessedEmailReadMark(email.mailboxId, email.externalUid, { marked: true });

  assert.equal(findQqEmailReadAction(action.token, userOpenId)?.emailId, email.id);
  assert.equal(findQqNotificationReference({
    userOpenId,
    messageId: `qq-action-message-${suffix}`
  })?.emailId, email.id);
});

test("delivery identity is unique per email and channel", () => {
  const emailId = `email-delivery-${process.pid}`;
  enqueueNotificationDelivery(emailId, "qq");
  enqueueNotificationDelivery(emailId, "qq");

  assert.equal(listNotificationDeliveries({ emailId }).length, 1);
});

test("notification delivery claims sort by email received time across mailboxes", () => {
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.prepare("DELETE FROM notification_deliveries").run();
  sqlite.close();

  const suffix = `${process.pid}-${Date.now()}`;
  const late = `notify-late-${suffix}`;
  const early = `notify-early-${suffix}`;
  const middle = `notify-middle-${suffix}`;

  addProcessedEmail(makeStoreEmail({
    id: late,
    mailboxId: `mailbox-late-${suffix}`,
    receivedAt: "2026-08-31T10:00:00.000Z",
    processedAt: "2026-08-31T10:00:01.000Z"
  }));
  enqueueNotificationDelivery(late, "qq");

  addProcessedEmail(makeStoreEmail({
    id: early,
    mailboxId: `mailbox-early-${suffix}`,
    receivedAt: "2026-08-31T08:00:00.000Z",
    processedAt: "2026-08-31T10:00:02.000Z"
  }));
  enqueueNotificationDelivery(early, "qq");

  addProcessedEmail(makeStoreEmail({
    id: middle,
    mailboxId: `mailbox-middle-${suffix}`,
    receivedAt: "2026-08-31T09:00:00.000Z",
    processedAt: "2026-08-31T10:00:03.000Z"
  }));
  enqueueNotificationDelivery(middle, "qq");

  const claimed = claimNotificationDeliveries(3, new Date(Date.now() + 60_000).toISOString());
  assert.deepEqual(claimed.map((delivery) => delivery.emailId), [early, middle, late]);
});

test("notification queue queries expose mail context and failed status group", () => {
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.prepare("DELETE FROM notification_deliveries").run();
  sqlite.close();

  const suffix = `${process.pid}-${Date.now()}`;
  const retryEmail = `queue-retry-${suffix}`;
  const pausedEmail = `queue-paused-${suffix}`;
  addProcessedEmail(makeStoreEmail({
    id: pausedEmail,
    mailboxId: `queue-mailbox-paused-${suffix}`,
    receivedAt: "2026-08-31T09:00:00.000Z"
  }));
  addProcessedEmail(makeStoreEmail({
    id: retryEmail,
    mailboxId: `queue-mailbox-retry-${suffix}`,
    receivedAt: "2026-08-31T08:00:00.000Z"
  }));
  const retry = enqueueNotificationDelivery(retryEmail, "qq");
  const paused = enqueueNotificationDelivery(pausedEmail, "qq");

  const database = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  database.prepare("UPDATE notification_deliveries SET status = 'retry', lastError = 'QQ media upload failed' WHERE id = ?").run(retry.id);
  database.prepare("UPDATE notification_deliveries SET status = 'paused', lastError = '消息发送失败, 无好友关系' WHERE id = ?").run(paused.id);
  database.close();

  const failed = queryNotificationDeliveries({ channel: "qq", status: "failed", limit: 20 });
  assert.deepEqual(failed.items.map((item) => item.emailId), [retryEmail, pausedEmail]);
  assert.equal(failed.items[0]?.email?.subject, retryEmail);
  assert.equal(failed.items[1]?.email?.mailboxName, "未知邮箱");
  assert.equal(failed.items[0]?.lastError, "QQ media upload failed");
});

test("notification queue actions retry, pause, resume, and bulk retry deliveries", () => {
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.prepare("DELETE FROM notification_deliveries").run();
  sqlite.close();

  const suffix = `${process.pid}-${Date.now()}`;
  const firstEmail = `queue-action-first-${suffix}`;
  const secondEmail = `queue-action-second-${suffix}`;
  addProcessedEmail(makeStoreEmail({ id: firstEmail, mailboxId: `queue-action-mailbox-${suffix}` }));
  addProcessedEmail(makeStoreEmail({ id: secondEmail, mailboxId: `queue-action-mailbox-${suffix}` }));
  const first = enqueueNotificationDelivery(firstEmail, "qq");
  const second = enqueueNotificationDelivery(secondEmail, "qq");

  assert.equal(pauseNotificationDelivery(first.id)?.status, "paused");
  assert.equal(resumeNotificationDelivery(first.id)?.status, "retry");
  assert.equal(retryNotificationDelivery(first.id)?.status, "retry");

  const database = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  database.prepare("UPDATE notification_deliveries SET status = 'paused', lastError = 'paused' WHERE id = ?").run(first.id);
  database.prepare("UPDATE notification_deliveries SET status = 'retry', lastError = 'retry' WHERE id = ?").run(second.id);
  database.close();

  assert.equal(retryNotificationDeliveriesByChannel("qq"), 2);
  const after = listNotificationDeliveries().filter((delivery) => [first.id, second.id].includes(delivery.id));
  assert.deepEqual(after.map((delivery) => delivery.status), ["retry", "retry"]);
  assert.deepEqual(after.map((delivery) => delivery.lastError), [undefined, undefined]);
});

test("resuming paused deliveries affects only the selected channel", () => {
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.prepare("DELETE FROM notification_deliveries").run();
  sqlite.close();
  const qq = enqueueNotificationDelivery("resume-email", "qq");
  const wechat = enqueueNotificationDelivery("resume-email", "wechat");
  const database = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  database.prepare("UPDATE notification_deliveries SET status = 'paused' WHERE id IN (?, ?)").run(qq.id, wechat.id);
  database.close();

  assert.equal(resumePausedNotificationDeliveries("qq"), 1);
  assert.equal(listNotificationDeliveries({ emailId: "resume-email" }).find((item) => item.channel === "qq")?.status, "retry");
  assert.equal(listNotificationDeliveries({ emailId: "resume-email" }).find((item) => item.channel === "wechat")?.status, "paused");
});

test("mail cursors persist with owner and mailbox scope", () => {
  const saved = saveMailCursor({
    ownerId: "owner-a",
    mailboxId: "mailbox-a",
    folder: "INBOX",
    uidValidity: "42",
    lastUid: "17"
  });
  const loaded = readMailCursor("owner-a", "mailbox-a", "INBOX");
  assert.equal(loaded?.uidValidity, "42");
  assert.equal(loaded?.lastUid, "17");
  assert.equal(readMailCursor("owner-b", "mailbox-a", "INBOX"), undefined);

  const updated = saveMailCursor({
    ownerId: "owner-a",
    mailboxId: "mailbox-a",
    folder: "INBOX",
    uidValidity: "42",
    lastUid: "18"
  });
  assert.equal(updated.lastUid, "18");
  assert.equal(readMailCursor("owner-a", "mailbox-a", "INBOX")?.lastUid, "18");

  updateState(() => {});
  assert.equal(readMailCursor("owner-a", "mailbox-a", "INBOX")?.lastUid, "18");
});

test("commitFetched atomically stores raw mail and cursor with owner isolation", () => {
  const batch = [{
    key: { ownerId: "owner-c", mailboxId: "mailbox-c", folder: "INBOX", uidValidity: "9", uid: "3" },
    receivedAt: "2026-10-16T00:00:00.000Z",
    rawBytes: new Uint8Array(Buffer.from("Subject: stored\r\n\r\nbody")),
    oversized: false,
    sizeBytes: 24
  }];
  const committed = commitFetched(batch, {
    ownerId: "owner-c",
    mailboxId: "mailbox-c",
    folder: "INBOX",
    uidValidity: "9",
    lastUid: "3"
  });
  assert.equal(committed.ok, true);
  assert.equal(readMailCursor("owner-c", "mailbox-c", "INBOX")?.lastUid, "3");
  assert.equal(readFetchedMails("owner-c", "mailbox-c", "INBOX").length, 1);
  assert.equal(readFetchedMails("owner-d", "mailbox-c", "INBOX").length, 0);

  const repeated = commitFetched(batch, {
    ownerId: "owner-c",
    mailboxId: "mailbox-c",
    folder: "INBOX",
    uidValidity: "9",
    lastUid: "3"
  });
  assert.equal(repeated.ok, true);
  assert.equal(readFetchedMails("owner-c", "mailbox-c", "INBOX").length, 1);
});

test("commitFetched rejects an incomplete batch without moving cursor or storing rows", () => {
  const result = commitFetched([
    {
      key: { ownerId: "owner-e", mailboxId: "mailbox-e", folder: "INBOX", uidValidity: "10", uid: "1" },
      receivedAt: "2026-10-16T00:00:00.000Z",
      rawBytes: new Uint8Array(Buffer.from("raw")),
      oversized: false,
      sizeBytes: 3
    },
    {
      key: { ownerId: "owner-e", mailboxId: "mailbox-e", folder: "INBOX", uidValidity: "10", uid: "2" },
      receivedAt: "2026-10-16T00:01:00.000Z",
      oversized: false,
      sizeBytes: 99
    }
  ], {
    ownerId: "owner-e",
    mailboxId: "mailbox-e",
    folder: "INBOX",
    uidValidity: "10",
    lastUid: "2"
  });

  assert.equal(result.ok, false);
  assert.equal(readMailCursor("owner-e", "mailbox-e", "INBOX"), undefined);
  assert.equal(readFetchedMails("owner-e", "mailbox-e", "INBOX").length, 0);
});

test("pending fetched mails exclude only the exact compound UID already processed", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `pending-owner-${suffix}`;
  const mailboxId = `pending-mailbox-${suffix}`;
  const key1 = { ownerId, mailboxId, folder: "INBOX", uidValidity: "31", uid: "1" };
  const key2 = { ...key1, uid: "2" };
  const raw = (key: typeof key1) => ({
    key,
    receivedAt: "2026-10-16T00:00:00.000Z",
    rawBytes: new Uint8Array(Buffer.from(`Subject: ${key.uid}\r\n\r\nbody`)),
    oversized: false,
    sizeBytes: 20
  });
  assert.equal(commitFetched([raw(key1), raw(key2)], { ...key2, lastUid: key2.uid }).ok, true);
  assert.deepEqual(
    readPendingFetchedMails(ownerId, mailboxId, "INBOX").map((mail) => mail.key.uid),
    ["1", "2"]
  );

  const processed = makeStoreEmail({ id: `pending-processed-${suffix}`, mailboxId });
  processed.externalUid = fetchedMailExternalUid(key1);
  assert.ok(addProcessedEmail(processed));
  assert.deepEqual(
    readPendingFetchedMails(ownerId, mailboxId, "INBOX").map((mail) => mail.key.uid),
    ["2"]
  );
});

test("processed email and notification enqueue roll back together", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const email = makeStoreEmail({ id: `atomic-email-${suffix}`, mailboxId: `atomic-mailbox-${suffix}` });
  email.externalUid = JSON.stringify(["local-owner", "INBOX", "41", "9"]);

  assert.throws(() => {
    commitProcessedEmailWithNotifications(email, () => {
      enqueueNotificationDelivery(email.id, "qq");
      throw new Error("synthetic enqueue failure");
    });
  }, /synthetic enqueue failure/);
  assert.equal(getProcessedEmailById(email.id), undefined);
  assert.equal(listNotificationDeliveries({ emailId: email.id }).length, 0);

  const inserted = commitProcessedEmailWithNotifications(email, () => {
    enqueueNotificationDelivery(email.id, "qq");
    return 1;
  });
  assert.equal(inserted?.externalUid, email.externalUid);
  assert.equal(listNotificationDeliveries({ emailId: email.id }).length, 1);
});

test("notification delivery claims are exclusive and stale sends recover", () => {
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.prepare("DELETE FROM notification_deliveries").run();
  sqlite.close();
  enqueueNotificationDelivery("claim-email-1", "wechat");
  enqueueNotificationDelivery("claim-email-2", "qq");
  const nowMs = Date.now() + 60_000;
  const now = new Date(nowMs).toISOString();

  const first = claimNotificationDeliveries(1, now);
  const second = claimNotificationDeliveries(10, now);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.status, "sending");
  assert.equal(second.length, 1);
  assert.notEqual(second[0]?.id, first[0]?.id);

  const database = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  database.prepare(
    "UPDATE notification_deliveries SET status = 'sending', updatedAt = ? WHERE id = ?"
  ).run(new Date(nowMs - 10 * 60_000).toISOString(), first[0]!.id);
  database.prepare(
    "UPDATE notification_deliveries SET status = 'sent', updatedAt = ? WHERE id = ?"
  ).run(now, second[0]!.id);
  database.close();

  const recoveryTime = new Date(nowMs + 6 * 60_000).toISOString();
  const recovered = claimNotificationDeliveries(10, recoveryTime);
  assert.deepEqual(recovered.map((item) => item.id), [first[0]!.id]);
  assert.equal(recovered[0]?.lastError, "recovered_stale_send");
  assert.equal(claimNotificationDeliveries(10, recoveryTime).length, 0);
});

test("lightweight state readers never parse stored email bodies", () => {
  const bodyMarker = "email-body-must-not-be-parsed-" + process.pid;
  const email: ProcessedEmail = {
    id: "memory-regression-" + process.pid,
    mailboxId: "memory-regression-mailbox",
    externalUid: "1",
    subject: "Memory regression",
    processedAt: new Date().toISOString(),
    category: "ignore",
    summaryZh: "memory regression",
    reasonZh: "lightweight reader verification",
    actionItemsZh: [],
    originalText: bodyMarker,
    readMarked: true
  };
  addProcessedEmail(email);

  const originalParse = JSON.parse;
  let parsedStoredEmail = false;
  JSON.parse = ((value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (String(value).includes(bodyMarker)) {
      parsedStoredEmail = true;
      throw new Error("lightweight reader parsed an email body");
    }
    return originalParse(value, reviver);
  }) as typeof JSON.parse;

  try {
    assert.doesNotThrow(() => readSettings());
    assert.doesNotThrow(() => readMailboxes());
    assert.doesNotThrow(() => readProcessingRuns(10));
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(parsedStoredEmail, false);
});


test("QQ notification references resolve sent images back to emails", () => {
  const id = "qq-reference-email-" + process.pid;
  addProcessedEmail({
    id,
    mailboxId: "qq-reference-mailbox",
    externalUid: id,
    subject: "Reference mapping",
    processedAt: new Date().toISOString(),
    category: "important",
    summaryZh: "reference mapping",
    reasonZh: "store test",
    actionItemsZh: [],
    originalText: "unique reference body " + id,
    panelRead: false,
    readMarked: true
  });

  const recorded = recordQqNotificationReference({
    emailId: id,
    userOpenId: "qq-reference-user",
    messageId: "qq-message-id",
    refIndex: "REFIDX_STORE_TEST"
  });
  assert.equal(recorded?.emailId, id);
  assert.equal(findQqNotificationReference({
    userOpenId: "qq-reference-user",
    refIndex: "REFIDX_STORE_TEST"
  })?.emailId, id);
  assert.equal(findQqNotificationReference({
    userOpenId: "qq-reference-user",
    messageId: "qq-message-id"
  })?.emailId, id);
  assert.equal(findQqNotificationReference({
    userOpenId: "another-user",
    refIndex: "REFIDX_STORE_TEST"
  }), undefined);
});
