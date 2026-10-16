export type MailCategory = "important" | "secondary" | "ignore";
export type MailProtocol = "imap" | "pop3";
export type AiProtocol = "auto" | "openai-chat" | "openai-responses" | "anthropic" | "gemini";
export type MultimodalProtocol = AiProtocol | "same";

export type EncryptedCredential = `v1:${string}:${string}:${string}`;

export type NotificationChannelSettings = {
  enabled: boolean;
  notifyCategories: Record<MailCategory, boolean>;
};

export type QqAgentPermission =
  | "readMail"
  | "sendMailImages"
  | "readAttachments"
  | "sendAttachments"
  | "manageReadState"
  | "manageNotifications"
  | "runProcessing"
  | "checkMailboxes"
  | "reclassifyMail";

export type QqAgentSettings = {
  enabled: boolean;
  requireConfirmation: boolean;
  maxResults: number;
  permissions: Record<QqAgentPermission, boolean>;
};

export type QqAgentEvent = {
  id: string;
  kind: string;
  toolName?: string;
  status: string;
  message?: string;
  data: unknown;
  step?: number;
  durationMs?: number;
  createdAt: string;
};

export type QqAgentRun = {
  id: string;
  status: "running" | "success" | "failed";
  maskedUser: string;
  message: string;
  reply?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stepCount: number;
  toolCallCount: number;
  events: QqAgentEvent[];
};

export type QqBotConfig = NotificationChannelSettings & {
  appId: string;
  encryptedAppSecret: string;
  quoteImageMarksRead: boolean;
  agent: QqAgentSettings;
};

export type QqBotSettingsInput = Partial<NotificationChannelSettings> & {
  appId?: string;
  appSecret?: string;
  quoteImageMarksRead?: boolean;
  agent?: Partial<Omit<QqAgentSettings, "permissions">> & {
    permissions?: Partial<Record<QqAgentPermission, boolean>>;
  };
};

export type PublicQqBotSettings = NotificationChannelSettings & {
  appId: string;
  hasAppSecret: boolean;
  maskedAppSecret: string;
  quoteImageMarksRead: boolean;
  agent: QqAgentSettings;
};

export type QqGatewayStatus = {
  state: "stopped" | "connecting" | "identifying" | "resuming" | "online" | "reconnecting" | "blocked";
  reconnectAttempt: number;
  connectedAt?: string;
  lastHeartbeatAckAt?: string;
  lastError?: { code: string; message: string };
};

export type QqBotPublicStatus = {
  enabled: boolean;
  configured: boolean;
  gateway: QqGatewayStatus;
  bound: boolean;
  maskedRecipient?: string;
  friendshipStatus?: "unknown" | "friend" | "removed";
  proactiveStatus?: "unknown" | "enabled" | "disabled";
  boundAt?: string;
  bindingChallenge?: { expiresAt: string };
  lastError?: string;
};

export type NotificationSettingsResponse = NotificationSettings & {
  wechat: NotificationSettings;
  qq: PublicQqBotSettings;
  qqStatus: QqBotPublicStatus;
};

export type QqBindingChallenge = {
  code: string;
  expiresAt: string;
};
export type NotificationDeliveryStatus = "pending" | "sending" | "sent" | "retry" | "paused";
export type NotificationChannel = "wechat" | "qq";

export type NotificationDelivery = {
  id: string;
  emailId: string;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  sentAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type QqGatewayState = {
  sessionId?: string;
  resumeUrl?: string;
  sequence?: number;
  connectedAt?: string;
  updatedAt: string;
};

export type QqBotBinding = {
  id: string;
  userOpenId: string;
  friendshipStatus: "unknown" | "friend" | "removed";
  proactiveStatus: "unknown" | "enabled" | "disabled";
  lastEventAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type AiSettings = {
  providerName: string;
  providerPreset?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  protocol?: AiProtocol;
  multimodalEnabled: boolean;
  multimodalBaseUrl: string;
  multimodalModel: string;
  multimodalProtocol?: MultimodalProtocol;
  multimodalApiKey?: string;
  multimodalMaxAttachmentMb: number;
  multimodalMaxTotalMb: number;
  hasApiKey?: boolean;
  maskedApiKey?: string;
  hasMultimodalApiKey?: boolean;
  maskedMultimodalApiKey?: string;
};

export type AiUsageScope = "email" | "agent" | "system";
export type AiUsagePurpose =
  | "email_classification"
  | "email_multimodal"
  | "agent_orchestration"
  | "agent_response"
  | "agent_attachment"
  | "system_test";
export type AiUsageRange = "today" | "7d" | "30d" | "all";
export type AiBillingProvider = "none" | "openai" | "anthropic";

export type AiUsageTotals = {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  usageReportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number;
};

export type AiUsageScopeBreakdown = AiUsageTotals & {
  scope: AiUsageScope;
};

export type AiUsageModelBreakdown = AiUsageTotals & {
  key: string;
  provider: string;
  protocol: AiProtocol;
  model: string;
};

export type AiUsageTimelinePoint = {
  bucket: string;
  calls: number;
  totalTokens: number;
};

export type AiUsageRecentItem = {
  id: string;
  scope: AiUsageScope;
  purpose: AiUsagePurpose;
  provider: string;
  protocol: AiProtocol;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  usageReported: boolean;
  success: boolean;
  latencyMs: number;
  requestId?: string;
  error?: string;
  occurredAt: string;
};

export type PublicAiBillingSettings = {
  provider: AiBillingProvider;
  hasAdminKey: boolean;
  maskedAdminKey: string;
};

export type AiCostAmount = {
  currency: string;
  amount: number;
};

export type AiCostSnapshot = {
  provider: Exclude<AiBillingProvider, "none">;
  range: AiUsageRange;
  startAt: string;
  endAt: string;
  amounts: AiCostAmount[];
  queriedAt: string;
};

export type AiUsageDashboard = {
  range: AiUsageRange;
  startAt?: string;
  endAt: string;
  generatedAt: string;
  totals: AiUsageTotals;
  byScope: AiUsageScopeBreakdown[];
  byModel: AiUsageModelBreakdown[];
  timeline: AiUsageTimelinePoint[];
  recent: AiUsageRecentItem[];
  billing: {
    settings: PublicAiBillingSettings;
    latestCost?: AiCostSnapshot;
  };
};

export type ClassificationResult = {
  category: MailCategory;
  summaryZh: string;
  reasonZh: string;
  actionItemsZh: string[];
};

export type SystemSettings = {
  autoProcessEnabled: boolean;
  autoLoadRemoteImages: boolean;
  pollIntervalMinutes: number;
  processLimitPerMailbox: number;
};

export type NotificationSettings = {
  enabled: boolean;
  clawbotApiUrl: string;
  clawbotRecipientId: string;
  importantOnly: boolean;
  notifyCategories: Record<MailCategory, boolean>;
};

export type EmailNotificationStatusSummary = {
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  sentAt?: string;
  lastError?: string;
};

export type AuthSettings = {
  passwordUpdatedAt: string;
  sessionDays: number;
};

export type Mailbox = {
  id: string;
  name: string;
  email: string;
  protocol: MailProtocol;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folder: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  hasPassword?: boolean;
};

export type EmailListItem = {
  id: string;
  mailboxId: string;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  receivedAt?: string;
  processedAt: string;
  category: MailCategory;
  summaryZh: string;
  reasonZh: string;
  actionItemsZh: string[];
  panelRead: boolean;
  panelReadAt?: string;
  readMarked: boolean;
  readMarkNote?: string;
  notifiedAt?: string;
  notificationError?: string;
  qqNotification?: EmailNotificationStatusSummary;
};

export type NotificationDeliveryItem = EmailNotificationStatusSummary & {
  id: string;
  emailId: string;
  createdAt: string;
  updatedAt: string;
  email?: {
    id: string;
    mailboxId: string;
    mailboxName: string;
    subject: string;
    fromName?: string;
    fromAddress?: string;
    receivedAt?: string;
    processedAt: string;
    category: MailCategory;
    summaryZh: string;
    panelRead: boolean;
    readMarked: boolean;
  };
};

export type NotificationDeliveryPage = {
  items: NotificationDeliveryItem[];
  total: number;
  offset: number;
  limit: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type EmailListPage = {
  items: EmailListItem[];
  total: number;
  offset: number;
  limit: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type ProcessedEmail = EmailListItem & {
  calendarAnalysis?: { state: "pending" | "ready" | "failed" | "skipped"; taskId?: string; deadlineAt?: string; notes?: string; checkedAt?: string };
  messageId?: string;
  toText?: string;
  assetToken?: string;
  originalText: string;
  originalHtml?: string;
  rawSource?: string;
  attachments?: EmailAttachment[];
  multimodalAnalysis?: MultimodalAnalysis;
};

export type EmailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  disposition?: string;
  related: boolean;
  supportedForVision: boolean;
};

export type MultimodalAnalysis = {
  model: string;
  summaryZh: string;
  reasonZh: string;
  categoryHint?: MailCategory;
  importantSignalsZh: string[];
  analyzedAt: string;
  attachmentCount: number;
  analyzedAttachmentNames: string[];
  skippedAttachmentNames: string[];
};

export type ProcessingRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed";
  mailboxId?: string;
  totalMailboxCount?: number;
  currentMailboxIndex?: number;
  currentMailboxName?: string;
  currentSubject?: string;
  currentStage?: string;
  totalTaskCount?: number;
  handledTaskCount?: number;
  totalUnreadCount?: number;
  handledUnreadCount?: number;
  currentMailboxUnreadCount?: number;
  currentMailboxHandledCount?: number;
  currentEmailStep?: string;
  currentEmailStepIndex?: number;
  currentEmailStepTotal?: number;
  processedCount: number;
  importantCount: number;
  secondaryCount: number;
  ignoreCount: number;
  errors: string[];
};

export type Dashboard = {
  settings: {
    ai: AiSettings;
    system: SystemSettings;
    notification: NotificationSettings;
    auth: AuthSettings;
  };
  mailboxes: Mailbox[];
  counts: Record<MailCategory, number>;
  unreadCounts: Record<MailCategory, number>;
  total: number;
  allTotal: number;
  recentEmails: EmailListItem[];
  runs: ProcessingRun[];
  processorRunning: boolean;
  currentRun?: ProcessingRun | null;
};

export type WeclawStatus = {
  installed: boolean;
  runtimeMode?: "node-ilink";
  runtimeName?: string;
  executablePath: string;
  legacyExecutablePath?: string;
  legacyExecutableAvailable?: boolean;
  apiUrl: string;
  apiBaseUrl: string;
  apiReachable: boolean;
  running: boolean;
  managedRunning: boolean;
  managedPid?: number;
  hasCredentials: boolean;
  credentialCount: number;
  credentialsPath: string;
  recipientId?: string;
  botId?: string;
  contextTokenPath?: string;
  contextReady?: boolean;
  contextUpdatedAt?: string;
  tokenHealth?: "missing" | "unverified" | "healthy" | "refresh-soon" | "expired" | "invalid";
  contextCapturedAt?: string;
  contextObservedAt?: string;
  contextVerifiedAt?: string;
  contextFailedAt?: string;
  contextEstimatedExpiresAt?: string;
  contextReminderAt?: string;
  contextLastError?: string;
  sessionExpired?: boolean;
  sessionExpiredAt?: string;
  missingContext?: boolean;
  missingContextAt?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
  };
  logTail: string;
  message?: string;
};
