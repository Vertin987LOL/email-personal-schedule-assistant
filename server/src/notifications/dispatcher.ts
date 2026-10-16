import {
  claimNotificationDeliveries,
  enqueueNotificationDelivery,
  getProcessedEmailById,
  listNotificationDeliveries,
  readMailboxes,
  readQqBotConfig,
  readSettings,
  updateNotificationDelivery
} from "../store";
import type {
  Mailbox,
  NotificationChannel,
  NotificationDelivery,
  NotificationSettings,
  ProcessedEmail,
  QqBotConfig
} from "../types";
import { getQqManager } from "../qq/manager";
import { QqApiError } from "../qq/types";
import { sendClawbotEmailCard } from "./clawbot";
import { renderEmailNotificationCard } from "./card";
import {
  buildEmailNotificationModel,
  type EmailNotificationModel
} from "./format";

const DEFAULT_BATCH_LIMIT = 20;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 30 * 60 * 1000;

type ChannelSettings = {
  wechat: NotificationSettings;
  qq: QqBotConfig;
};

type DeliveryPatch = Partial<
  Pick<NotificationDelivery, "status" | "attemptCount" | "nextAttemptAt" | "sentAt" | "lastError">
>;

export type NotificationDispatcherDependencies = {
  readChannelSettings?: () => ChannelSettings;
  readEmail?: (id: string) => ProcessedEmail | undefined;
  readMailbox?: (id: string) => Mailbox | undefined;
  enqueueDelivery?: (
    emailId: string,
    channel: NotificationChannel,
    options?: { bypassCategoryFilter?: boolean }
  ) => NotificationDelivery;
  claimDeliveries?: (limit: number, now?: string) => NotificationDelivery[];
  updateDelivery?: (id: string, patch: DeliveryPatch) => NotificationDelivery | undefined;
  sendWechat?: (model: EmailNotificationModel, settings: NotificationSettings) => Promise<unknown>;
  sendQq?: (model: EmailNotificationModel, settings: QqBotConfig) => Promise<unknown>;
  now?: () => number;
  random?: () => number;
};

export type DeliveryBatchResult = {
  attempted: number;
  sent: number;
  retried: number;
  paused: number;
  skipped: boolean;
};

export type CalendarNotificationPreparation = (
  email: ProcessedEmail
) => Promise<{ ready: boolean; email: ProcessedEmail }> | { ready: boolean; email: ProcessedEmail };

let calendarNotificationPreparation: CalendarNotificationPreparation | undefined;

export function setCalendarNotificationPreparation(handler?: CalendarNotificationPreparation) {
  calendarNotificationPreparation = handler;
}

function safeError(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 240) || "notification_failed";
}

function shouldPause(error: unknown) {
  if (error instanceof QqApiError) {
    return ["authentication", "permission", "relationship", "invalid_request"].includes(error.kind);
  }
  const message = safeError(error).toLowerCase();
  return [
    "not bound",
    "missing context_token",
    "ret=-2",
    "ret=-14",
    "session expired",
    "会话失效",
    "会话过期",
    "recipient",
    "未绑定",
    "接收人"
  ].some((marker) => message.includes(marker));
}

function calendarReady(email: ProcessedEmail) {
  const status = email.calendarAnalysis?.state;
  // Emails processed before the calendar bridge was installed, and explicitly
  // skipped checks, retain the old notification behaviour.
  return !status || status === "ready" || status === "skipped";
}

function defaultDependencies() {
  return {
    readChannelSettings: (): ChannelSettings => ({
      wechat: readSettings().notification,
      qq: readQqBotConfig()
    }),
    readEmail: getProcessedEmailById,
    readMailbox: (id: string) => readMailboxes().find((mailbox) => mailbox.id === id),
    enqueueDelivery: enqueueNotificationDelivery,
    claimDeliveries: claimNotificationDeliveries,
    updateDelivery: updateNotificationDelivery,
    sendWechat: (model: EmailNotificationModel, settings: NotificationSettings) =>
      sendClawbotEmailCard(settings, model),
    sendQq: async (model: EmailNotificationModel) => {
      const image = await renderEmailNotificationCard(model);
      return getQqManager().sendImageNotification(image, model.emailId);
    }
  };
}

export class NotificationDispatcher {
  private readonly dependencies: Required<NotificationDispatcherDependencies>;
  private running = false;

  constructor(dependencies: NotificationDispatcherDependencies = {}) {
    const defaults = defaultDependencies();
    this.dependencies = {
      readChannelSettings: dependencies.readChannelSettings ?? defaults.readChannelSettings,
      readEmail: dependencies.readEmail ?? defaults.readEmail,
      readMailbox: dependencies.readMailbox ?? defaults.readMailbox,
      enqueueDelivery: dependencies.enqueueDelivery ?? defaults.enqueueDelivery,
      claimDeliveries: dependencies.claimDeliveries ?? defaults.claimDeliveries,
      updateDelivery: dependencies.updateDelivery ?? defaults.updateDelivery,
      sendWechat: dependencies.sendWechat ?? defaults.sendWechat,
      sendQq: dependencies.sendQq ?? defaults.sendQq,
      now: dependencies.now ?? Date.now,
      random: dependencies.random ?? Math.random
    };
  }

  enqueueEmailNotifications(email: ProcessedEmail, options: { bypassCategoryFilter?: boolean } = {}) {
    const settings = this.dependencies.readChannelSettings();
    const created: NotificationDelivery[] = [];
    for (const channel of ["wechat", "qq"] as const) {
      const channelSettings = settings[channel];
      if (!channelSettings.enabled) continue;
      if (!options.bypassCategoryFilter && !channelSettings.notifyCategories[email.category]) continue;
      created.push(this.dependencies.enqueueDelivery(email.id, channel, options));
    }
    return created;
  }

  /**
   * Gate delivery on the durable calendar-intake state. A pending or failed
   * check is replayed shortly without consuming a send attempt.
   */
  async prepareEmail(delivery: NotificationDelivery, email: ProcessedEmail) {
    try {
      let prepared = email;
      if (calendarNotificationPreparation) {
        const result = await calendarNotificationPreparation(email);
        prepared = result.email;
        if (!result.ready) {
          this.retryWithoutAttempt(delivery, "calendar_analysis_pending");
          return { ready: false, email: prepared };
        }
      } else if (!calendarReady(prepared)) {
        const status = prepared.calendarAnalysis?.state ?? "pending";
        this.retryWithoutAttempt(delivery, `calendar_analysis_${status}`);
        return { ready: false, email: prepared };
      }
      return { ready: true, email: prepared };
    } catch (error) {
      void error;
      this.retryWithoutAttempt(delivery, "calendar_analysis_failed");
      return { ready: false, email };
    }
  }

  async retryNotificationDeliveries(limit = DEFAULT_BATCH_LIMIT): Promise<DeliveryBatchResult> {
    if (this.running) return { attempted: 0, sent: 0, retried: 0, paused: 0, skipped: true };
    this.running = true;
    const result: DeliveryBatchResult = { attempted: 0, sent: 0, retried: 0, paused: 0, skipped: false };
    try {
      const now = new Date(this.dependencies.now()).toISOString();
      const claimed = this.dependencies.claimDeliveries(limit, now);
      result.attempted = claimed.length;
      await Promise.all(claimed.map((delivery) => this.deliver(delivery, result)));
      return result;
    } finally {
      this.running = false;
    }
  }

  private async deliver(delivery: NotificationDelivery, result: DeliveryBatchResult) {
    let email: ProcessedEmail | undefined;
    try {
      email = this.dependencies.readEmail(delivery.emailId);
    } catch (error) {
      void error;
      this.retryWithoutAttempt(delivery, "calendar_analysis_failed");
      result.retried += 1;
      return;
    }
    if (!email) {
      this.pause(delivery, "email_missing");
      result.paused += 1;
      return;
    }
    const prepared = await this.prepareEmail(delivery, email);
    if (!prepared.ready) {
      result.retried += 1;
      return;
    }
    email = prepared.email;
    const settings = this.dependencies.readChannelSettings()[delivery.channel];
    if (!settings.enabled || (!delivery.bypassCategoryFilter && !settings.notifyCategories[email.category])) {
      this.pause(delivery, "channel_or_category_disabled");
      result.paused += 1;
      return;
    }

    try {
      const model = buildEmailNotificationModel(email, this.dependencies.readMailbox(email.mailboxId));
      if (delivery.channel === "wechat") {
        await this.dependencies.sendWechat(model, settings as NotificationSettings);
      } else {
        await this.dependencies.sendQq(model, settings as QqBotConfig);
      }
      this.dependencies.updateDelivery(delivery.id, {
        status: "sent",
        attemptCount: delivery.attemptCount + 1,
        nextAttemptAt: undefined,
        sentAt: new Date(this.dependencies.now()).toISOString(),
        lastError: undefined
      });
      result.sent += 1;
    } catch (error) {
      if (shouldPause(error)) {
        this.pause(delivery, safeError(error));
        result.paused += 1;
        return;
      }
      const attemptCount = delivery.attemptCount + 1;
      const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attemptCount - 1, 20));
      const jitter = 0.75 + Math.min(1, Math.max(0, this.dependencies.random())) * 0.5;
      const delay = Math.min(MAX_RETRY_MS, Math.round(base * jitter));
      this.dependencies.updateDelivery(delivery.id, {
        status: "retry",
        attemptCount,
        nextAttemptAt: new Date(this.dependencies.now() + delay).toISOString(),
        sentAt: undefined,
        lastError: safeError(error)
      });
      result.retried += 1;
    }
  }

  private pause(delivery: NotificationDelivery, lastError: string) {
    this.dependencies.updateDelivery(delivery.id, {
      status: "paused",
      attemptCount: delivery.attemptCount + 1,
      nextAttemptAt: undefined,
      sentAt: undefined,
      lastError
    });
  }

  private retryWithoutAttempt(delivery: NotificationDelivery, lastError: string) {
    this.dependencies.updateDelivery(delivery.id, {
      status: "retry",
      attemptCount: delivery.attemptCount,
      nextAttemptAt: new Date(this.dependencies.now() + BASE_RETRY_MS).toISOString(),
      sentAt: undefined,
      lastError: safeError(lastError)
    });
  }
}

let dispatcher: NotificationDispatcher | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function getNotificationDispatcher() {
  dispatcher ??= new NotificationDispatcher();
  return dispatcher;
}

export function enqueueEmailNotifications(email: ProcessedEmail, options: { bypassCategoryFilter?: boolean } = {}) {
  return getNotificationDispatcher().enqueueEmailNotifications(email, options);
}

export function scheduleNotificationDispatch(delayMs = 0) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryNotificationDeliveries();
  }, Math.max(0, delayMs));
  retryTimer.unref?.();
}

export async function retryNotificationDeliveries(limit = DEFAULT_BATCH_LIMIT) {
  const result = await getNotificationDispatcher().retryNotificationDeliveries(limit);
  if (!result.skipped) {
    if (result.attempted === limit) {
      scheduleNotificationDispatch(1_000);
    } else {
      const nextAttempt = listNotificationDeliveries({ status: "retry" })
        .map((delivery) => Date.parse(delivery.nextAttemptAt ?? ""))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      if (nextAttempt !== undefined) scheduleNotificationDispatch(Math.max(100, nextAttempt - Date.now()));
    }
  }
  return result;
}

export function stopNotificationDispatcher() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}
