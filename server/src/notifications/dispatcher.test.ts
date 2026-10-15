import assert from "node:assert/strict";
import test from "node:test";
import type {
  Mailbox,
  NotificationChannel,
  NotificationDelivery,
  NotificationSettings,
  ProcessedEmail,
  QqBotConfig
} from "../types";
import { QqApiError } from "../qq/types";
import { NotificationDispatcher } from "./dispatcher";

const mailbox: Mailbox = {
  id: "mailbox-1",
  name: "Primary",
  email: "user@example.com",
  protocol: "imap",
  host: "imap.example.com",
  port: 993,
  secure: true,
  username: "user@example.com",
  password: "secret",
  folder: "INBOX",
  enabled: true,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z"
};

const email: ProcessedEmail = {
  id: "email-1",
  mailboxId: mailbox.id,
  externalUid: "uid-1",
  subject: "Action required",
  fromName: "Example",
  fromAddress: "sender@example.com",
  receivedAt: "2026-08-16T00:00:00.000Z",
  processedAt: "2026-08-16T00:00:01.000Z",
  category: "important",
  summaryZh: "需要查看的重要邮件。",
  reasonZh: "需要用户处理。",
  actionItemsZh: ["打开邮件并处理"],
  originalText: "Please review this message.",
  readMarked: true
};

const wechatSettings: NotificationSettings = {
  enabled: true,
  clawbotApiUrl: "http://127.0.0.1:18011/api/send",
  clawbotRecipientId: "recipient",
  importantOnly: false,
  notifyCategories: { important: true, secondary: true, ignore: false }
};

const qqAgentSettings: QqBotConfig["agent"] = {
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
};

const qqSettings: QqBotConfig = {
  enabled: true,
  appId: "1900000000",
  encryptedAppSecret: "v1:fake",
  quoteImageMarksRead: true,
  notifyCategories: { important: true, secondary: true, ignore: false },
  agent: qqAgentSettings
};

function createHarness(options: {
  wechat?: NotificationSettings;
  qq?: QqBotConfig;
  qqFailure?: Error;
  wechatFailure?: Error;
} = {}) {
  const deliveries: NotificationDelivery[] = [];
  const sent: NotificationChannel[] = [];
  let sequence = 0;
  const now = () => 1_786_838_400_000;
  const dispatcher = new NotificationDispatcher({
    readChannelSettings: () => ({
      wechat: options.wechat ?? wechatSettings,
      qq: options.qq ?? qqSettings
    }),
    readEmail: (id) => (id === email.id ? email : undefined),
    readMailbox: (id) => (id === mailbox.id ? mailbox : undefined),
    enqueueDelivery: (emailId, channel) => {
      const existing = deliveries.find((item) => item.emailId === emailId && item.channel === channel);
      if (existing) return existing;
      const created: NotificationDelivery = {
        id: `delivery-${++sequence}`,
        emailId,
        channel,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(now()).toISOString(),
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString()
      };
      deliveries.push(created);
      return created;
    },
    claimDeliveries: (limit) => {
      const claimed = deliveries
        .filter((item) => ["pending", "retry"].includes(item.status))
        .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now())
        .slice(0, limit);
      for (const item of claimed) {
        item.status = "sending";
        item.updatedAt = new Date(now()).toISOString();
      }
      return claimed.map((item) => ({ ...item }));
    },
    updateDelivery: (id, patch) => {
      const current = deliveries.find((item) => item.id === id);
      if (!current) return undefined;
      Object.assign(current, patch, { updatedAt: new Date(now()).toISOString() });
      return { ...current };
    },
    sendWechat: async () => {
      if (options.wechatFailure) throw options.wechatFailure;
      sent.push("wechat");
    },
    sendQq: async () => {
      if (options.qqFailure) throw options.qqFailure;
      sent.push("qq");
    },
    now,
    random: () => 0.5
  });
  return { dispatcher, deliveries, sent };
}

test("eligible channels enqueue once per email and channel", () => {
  const target = createHarness();
  target.dispatcher.enqueueEmailNotifications(email);
  target.dispatcher.enqueueEmailNotifications(email);

  assert.deepEqual(target.deliveries.map((item) => item.channel).sort(), ["qq", "wechat"]);
  assert.equal(target.deliveries.length, 2);
});

test("category settings independently control channel eligibility", () => {
  const target = createHarness({
    qq: { ...qqSettings, notifyCategories: { important: false, secondary: true, ignore: false } }
  });
  target.dispatcher.enqueueEmailNotifications(email);
  assert.deepEqual(target.deliveries.map((item) => item.channel), ["wechat"]);
});

test("one channel can succeed while the other schedules an isolated retry", async () => {
  const target = createHarness({
    qqFailure: new QqApiError({ kind: "transient", status: 503, code: "upstream_unavailable" })
  });
  target.dispatcher.enqueueEmailNotifications(email);
  const result = await target.dispatcher.retryNotificationDeliveries();

  assert.deepEqual(result, { attempted: 2, sent: 1, retried: 1, paused: 0, skipped: false });
  assert.equal(target.deliveries.find((item) => item.channel === "wechat")?.status, "sent");
  const qq = target.deliveries.find((item) => item.channel === "qq");
  assert.equal(qq?.status, "retry");
  assert.equal(qq?.attemptCount, 1);
  assert.equal(Date.parse(qq?.nextAttemptAt ?? ""), 1_786_838_405_000);
});

test("permission and relationship failures pause only the affected channel", async () => {
  const target = createHarness({
    qqFailure: new QqApiError({ kind: "relationship", status: 403, code: "not_friend" })
  });
  target.dispatcher.enqueueEmailNotifications(email);
  const result = await target.dispatcher.retryNotificationDeliveries();

  assert.equal(result.paused, 1);
  assert.equal(target.deliveries.find((item) => item.channel === "qq")?.status, "paused");
  assert.equal(target.deliveries.find((item) => item.channel === "wechat")?.status, "sent");
});

test("WeChat session expiry pauses the delivery instead of retrying forever", async () => {
  const target = createHarness({
    wechatFailure: new Error("send message failed: ret=-14 errmsg=session expired")
  });
  target.dispatcher.enqueueEmailNotifications(email);
  const result = await target.dispatcher.retryNotificationDeliveries();

  assert.equal(result.paused, 1);
  assert.equal(result.retried, 0);
  assert.equal(target.deliveries.find((item) => item.channel === "wechat")?.status, "paused");
});

test("a missing email pauses an orphaned delivery instead of retrying forever", async () => {
  const target = createHarness();
  target.dispatcher.enqueueEmailNotifications({ ...email, id: "missing-email" });
  const result = await target.dispatcher.retryNotificationDeliveries();

  assert.equal(result.paused, 2);
  assert.equal(target.deliveries.every((item) => item.status === "paused"), true);
});
