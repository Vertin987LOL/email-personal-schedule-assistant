import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import router from "./routes";
import { createCalendarRouter } from "./calendar/routes";
import { CalendarService } from "./calendar/service";
import { CalendarAgentRuntime } from "./calendar/agent-runtime";
import { createCalendarAgentRouter } from "./calendar/agent-routes";
import { resolveCalendarWechatCommand } from "./calendar/agent-wechat";
import { readCalendarExecutorSettings, calendarExecutorFactory } from "./calendar/agent-settings";
import { CalendarEmailBridge } from "./calendar/email-bridge";
import { CalendarDeliveryService } from "./calendar/delivery";
import { parseWechatTaskSourceRef, wechatTaskKey } from "./calendar/agent-tasks";
import { requireAuth } from "./auth";
import { sendClawbotText } from "./notifications/clawbot";
import { createCalendarWeclawInboundHandler } from "./weclaw/weclaw-inbound";
import { setCalendarEmailIntakeHandler, startProcessingWorker } from "./email/processor";
import { startImapIdleWatchers } from "./email/imap-idle";
import {
  scheduleNotificationDispatch,
  setCalendarNotificationPreparation,
  stopNotificationDispatcher
} from "./notifications/dispatcher";
import { schedulePendingEmailNotificationRetry } from "./notifications/pending";
import { startQqManager, stopQqManager } from "./qq/manager";
import {
  startQqMarkdownAssetCleanupWorker,
  stopQqMarkdownAssetCleanupWorker
} from "./qq/markdown-assets";
import {
  defaultWeclawApiUrl,
  ensureWeclawStarted,
  readWeclawAccounts,
  resolveWeclawRecipientId,
  isWeclawRecipientReady,
  sendWeclawDirectText,
  setWeclawInboundTextHandler,
  setWeclawContextReadyHandler,
  startWeclawTokenReminderWorker
} from "./weclaw/manager";
import { apiRateLimit, corsOrigin, csrfProtection, securityHeaders } from "./security";
import {
  hasInterruptedRecoveryRetry,
  getAppDatabase,
  getProcessedEmailById,
  updateProcessedEmailCalendar,
  readSettings,
  markInterruptedRuns,
  resumePausedNotificationDeliveries
} from "./store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT ?? 8787);

const app = express();
const calendar = new CalendarService(getAppDatabase());
// Missing or invalid local settings preserve manual calendar use and queued commands.
let executorSettings: ReturnType<typeof readCalendarExecutorSettings>;
try { executorSettings = readCalendarExecutorSettings(rootDir); } catch { console.warn("Calendar executor settings were rejected."); }
let calendarEmail: CalendarEmailBridge;
let calendarDelivery: CalendarDeliveryService;
const calendarAgent = new CalendarAgentRuntime(calendar, executorSettings?.enabled
  ? calendarExecutorFactory(executorSettings, rootDir, `http://127.0.0.1:${port}/api/calendar/agent-tools`) : undefined,
  undefined, undefined, task => {
    calendarEmail.settle(task);
    const latest = calendarAgent.tasks.get(task.id)!;
    if (latest.state !== "queued") calendarDelivery.enqueueTask(latest, calendarAgent.proposals(task.id));
  });
calendarEmail = new CalendarEmailBridge(calendarAgent, { readEmail: getProcessedEmailById, updateCalendar: updateProcessedEmailCalendar });
calendarDelivery = new CalendarDeliveryService(calendar, {
  taskRecipient: task => {
    const source = parseWechatTaskSourceRef(task.sourceRef ?? "");
    return source && readWeclawAccounts().some(account => account.botId === source.botId && account.recipientId === source.senderId) ? source.senderId : undefined;
  },
  isReady: recipient => {
    const settings = readSettings().notification;
    return settings.enabled && isWeclawRecipientReady(recipient ?? resolveWeclawRecipientId(settings.clawbotRecipientId));
  },
  send: (recipient, text) => recipient ? sendWeclawDirectText(recipient, text) : sendClawbotText(readSettings().notification, text)
});
setCalendarEmailIntakeHandler(email => calendarEmail.enqueue(email));
setCalendarNotificationPreparation(email => calendarEmail.prepare(email));
setWeclawInboundTextHandler(async message => {
  const account = readWeclawAccounts().find(item => item.botId === message.botId && item.recipientId === message.senderId);
  if (!account) return;
  await createCalendarWeclawInboundHandler(calendarAgent.tasks, {
    botId: account.botId, recipientId: account.recipientId,
    onCommand: input => resolveCalendarWechatCommand(calendarAgent, input),
    onQueued: () => calendarAgent.schedule()
  })(message);
  const saved = calendarAgent.tasks.getBySourceKey(wechatTaskKey(message.botId, message.senderId, message.messageId));
  if (saved?.state === "failed") calendarDelivery.enqueueTask(saved);
});

setWeclawContextReadyHandler(() => {
  resumePausedNotificationDeliveries("wechat");
  schedulePendingEmailNotificationRetry(500);
});

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(cors({ origin: corsOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "10mb", strict: true }));
app.use("/api", apiRateLimit, csrfProtection);
app.get("/api/calendar/deliveries", requireAuth, (_req, res) => res.json({ deliveries: calendarDelivery.list() }));
app.use("/api/calendar", createCalendarAgentRouter(calendarAgent));
app.use("/api/calendar", createCalendarRouter(calendar));
app.use("/api", router);
app.use(
  express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-store");
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  })
);
app.get(/.*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(distDir, "index.html"));
});

const httpServer = app.listen(port, "127.0.0.1", () => {
  calendarAgent.recover();
  for (const task of calendarAgent.tasks.list(100)) {
    if (!["queued", "running"].includes(task.state)) calendarDelivery.enqueueTask(task, calendarAgent.proposals(task.id));
  }
  calendarAgent.schedule();
  const retryInterruptedRecovery = hasInterruptedRecoveryRetry();
  const interruptedCount = markInterruptedRuns();
  startProcessingWorker({ recoverInterruptedOnFirstRun: interruptedCount > 0 || retryInterruptedRecovery });
  startImapIdleWatchers();
  startWeclawTokenReminderWorker();
  startQqMarkdownAssetCleanupWorker();
  void startQqManager().catch(() => {
    console.warn("QQ notification Gateway failed to start; mail processing remains available.");
  });
  scheduleNotificationDispatch(3000);
  void ensureWeclawStarted(defaultWeclawApiUrl).finally(() => schedulePendingEmailNotificationRetry(3000));
  console.log(`自动邮件系统已启动: http://127.0.0.1:${port}`);
});
const calendarDeliveryTimer = setInterval(() => { void calendarDelivery.tick().catch(() => { console.warn("Calendar delivery worker paused after a storage failure."); }); }, 15_000);
calendarDeliveryTimer.unref();
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Received " + signal + "; stopping notification workers.");
  stopNotificationDispatcher();
  clearInterval(calendarDeliveryTimer);
  stopQqMarkdownAssetCleanupWorker();
  await calendarAgent.close().catch(() => undefined);
  await stopQqManager().catch(() => undefined);

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  httpServer.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
