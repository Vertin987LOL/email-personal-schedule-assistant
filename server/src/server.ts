import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import router from "./routes";
import { startProcessingWorker } from "./email/processor";
import { startImapIdleWatchers } from "./email/imap-idle";
import {
  scheduleNotificationDispatch,
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
  setWeclawContextReadyHandler,
  startWeclawTokenReminderWorker
} from "./weclaw/manager";
import { apiRateLimit, corsOrigin, csrfProtection, securityHeaders } from "./security";
import {
  hasInterruptedRecoveryRetry,
  markInterruptedRuns
} from "./store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT ?? 8787);

const app = express();

setWeclawContextReadyHandler(() => schedulePendingEmailNotificationRetry(500));

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(cors({ origin: corsOrigin, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "10mb", strict: true }));
app.use("/api", apiRateLimit, csrfProtection);
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
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Received " + signal + "; stopping notification workers.");
  stopNotificationDispatcher();
  stopQqMarkdownAssetCleanupWorker();
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
