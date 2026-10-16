import { randomUUID } from "node:crypto";
import { classifyEmail } from "../ai";
import {
  analyzeEmailAttachments,
  hasMultimodalWork,
  stripAttachmentContent,
  withMultimodalContext
} from "../multimodal";
import {
  addProcessedEmail,
  addRun,
  commitFetched,
  commitProcessedEmailWithNotifications,
  fetchedMailExternalUid,
  findProcessedEmailDuplicate,
  getProcessedEmail,
  readMailCursor,
  readPendingFetchedMails,
  recordProcessingEvent,
  readMailboxes,
  readSettings,
  saveMailCursor,
  updateMailboxSync,
  updateProcessedEmailReadMark,
  updateRun
} from "../store";
import { enqueueEmailNotifications, scheduleNotificationDispatch } from "../notifications/dispatcher";
import type { Mailbox, ProcessedEmail, ProcessingRun } from "../types";
import { countUnreadImap, type FetchedEmail } from "./imap";
import { MimeMailParser, type MailParser } from "./mail-parser";
import {
  ImapMailReader,
  baselineCursor as makeBaselineCursor,
  type Cursor,
  type MailReader,
  type MailboxConfig,
  type RawMail
} from "./mail-reader";
import { AiSummarizer, RetryingSummarizer, type Summarizer } from "./summarizer";
import { countUnreadPop3, fetchUnreadPop3 } from "./pop3";

const LOCAL_OWNER_ID = "local-owner";
const incrementalImapReader = new ImapMailReader();
const incrementalMailParser = new MimeMailParser();
const incrementalSummarizer = new RetryingSummarizer(new AiSummarizer());

export type ProcessorDependencies = {
  imapReader?: MailReader;
  imapParser?: MailParser;
  imapSummarizer?: Summarizer;
  countUnreadImap?: typeof countUnreadImap;
};

let running = false;
const queuedMailboxIds = new Set<string>();
let queueDrainTimer: ReturnType<typeof setTimeout> | undefined;
let queueDraining = false;

function incrementRun(run: ProcessingRun, category: "important" | "secondary" | "ignore") {
  run.processedCount += 1;
  if (category === "important") run.importantCount += 1;
  if (category === "secondary") run.secondaryCount += 1;
  if (category === "ignore") run.ignoreCount += 1;
}

function persistRun(run: ProcessingRun, patch: Partial<ProcessingRun> = {}) {
  Object.assign(run, patch);
  updateRun(run);
  if (patch.currentStage || patch.currentEmailStep || patch.status) {
    recordProcessingEvent({
      runId: run.id,
      mailboxId: run.mailboxId,
      subject: run.currentSubject,
      stage: run.currentEmailStep || run.currentStage || "progress",
      status: run.status,
      message: run.currentStage
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function imapConfigFor(mailbox: Mailbox): MailboxConfig {
  return {
    ownerId: LOCAL_OWNER_ID,
    mailboxId: mailbox.id,
    folder: mailbox.folder || "INBOX",
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    username: mailbox.username,
    password: mailbox.password
  };
}

async function fetchIncrementalImap(
  mailbox: Mailbox,
  limit: number,
  reader: MailReader = incrementalImapReader
): Promise<void> {
  const config = imapConfigFor(mailbox);
  let cursor: Cursor | undefined = readMailCursor(config.ownerId, config.mailboxId, config.folder);
  if (!cursor) {
    const probed = await reader.probe(config);
    if (!probed.ok) throw new Error(probed.error.message);
    cursor = makeBaselineCursor(config, probed.value);
    saveMailCursor(cursor);
    return;
  }

  const fetched = await reader.fetchAfter(config, cursor, Math.min(limit, 20));
  if (!fetched.ok) throw new Error(fetched.error.message);
  const committed = commitFetched(fetched.value.items, fetched.value.nextCursor);
  if (!committed.ok) throw new Error(committed.error.message);
}

async function fetchForMailbox(mailbox: Mailbox, limit: number) {
  return fetchUnreadPop3(mailbox, limit);
}

async function countForMailbox(mailbox: Mailbox, limit: number, imapCounter = countUnreadImap) {
  if (mailbox.protocol === "imap") {
    return imapCounter(mailbox, limit);
  }
  return countUnreadPop3(mailbox, limit);
}

export async function processMailboxes(options: {
  mailboxId?: string;
  manual?: boolean;
  recoverInterrupted?: boolean;
  suppressNotificationDispatch?: boolean;
  dependencies?: ProcessorDependencies;
} = {}) {
  if (running) {
    throw new Error("已有处理任务正在运行");
  }

  running = true;
  const state = { settings: readSettings(), mailboxes: readMailboxes() };
  const dependencies = options.dependencies ?? {};
  const imapReader = dependencies.imapReader ?? incrementalImapReader;
  const imapParser = dependencies.imapParser ?? incrementalMailParser;
  const imapSummarizer = dependencies.imapSummarizer ?? incrementalSummarizer;
  const run: ProcessingRun = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    status: "running",
    mailboxId: options.mailboxId,
    totalMailboxCount: 0,
    currentMailboxIndex: 0,
    currentStage: "准备读取邮箱",
    totalTaskCount: 0,
    handledTaskCount: 0,
    totalUnreadCount: 0,
    handledUnreadCount: 0,
    currentMailboxUnreadCount: 0,
    currentMailboxHandledCount: 0,
    currentEmailStep: "",
    currentEmailStepIndex: 0,
    currentEmailStepTotal: 0,
    processedCount: 0,
    importantCount: 0,
    secondaryCount: 0,
    ignoreCount: 0,
    errors: []
  };
  addRun(run);
  let enqueuedNotificationCount = 0;

  try {
    const mailboxes = state.mailboxes.filter((mailbox) => {
      if (!mailbox.enabled) return false;
      if (options.mailboxId) return mailbox.id === options.mailboxId;
      return true;
    });
    run.totalMailboxCount = mailboxes.length;
    persistRun(run);

    const unreadCountByMailbox = new Map<string, number>();
    persistRun(run, { currentStage: "正在统计本轮未读邮件" });
    const processIncrementalImapItem = async (mailbox: Mailbox, raw: RawMail) => {
      const parsed = await imapParser.parse(raw);
      if (!parsed.ok) {
        run.errors.push(`${mailbox.name}: ${parsed.error.message}`);
        persistRun(run, { currentStage: parsed.error.message });
        return;
      }

      const normalized = parsed.value;
      const summarized = await imapSummarizer.summarize(normalized, state.settings.ai);
      if (!summarized.ok) {
        run.errors.push(`${mailbox.name}: ${summarized.error.message}`);
        persistRun(run, { currentStage: summarized.error.message });
        return;
      }

      const summary = summarized.value;
      const category = summary.category ?? "secondary";
      const processedEmail: ProcessedEmail = {
        id: randomUUID(),
        mailboxId: mailbox.id,
        externalUid: fetchedMailExternalUid(raw.key),
        messageId: normalized.sourceMessageId,
        subject: normalized.subject,
        fromAddress: normalized.from || undefined,
        receivedAt: normalized.receivedAt,
        processedAt: new Date().toISOString(),
        category,
        summaryZh: summary.explanationZh,
        reasonZh: summary.reasonZh ?? (summary.status === "fallback" ? "模型摘要未成功，已保留原邮件。" : ""),
        actionItemsZh: summary.actionItemsZh ?? [],
        originalText: normalized.bodyText,
        rawSource: raw.rawBytes ? Buffer.from(raw.rawBytes).toString("utf8") : undefined,
        attachments: normalized.attachmentNames.map((filename, attachmentIndex) => ({
          id: `attachment-${attachmentIndex + 1}`,
          filename,
          contentType: "application/octet-stream",
          size: 0,
          related: false,
          supportedForVision: false
        })),
        panelRead: category === "ignore",
        panelReadAt: category === "ignore" ? new Date().toISOString() : undefined,
        readMarked: false
      };

      let createdNotifications = 0;
      const inserted = commitProcessedEmailWithNotifications(processedEmail, () => {
        const notices = enqueueEmailNotifications(processedEmail, { bypassCategoryFilter: true });
        createdNotifications = notices.length;
        return createdNotifications;
      });
      if (!inserted) return;

      enqueuedNotificationCount += createdNotifications;
      incrementRun(run, category);
      persistRun(run, {
        currentStage: summary.status === "fallback" ? "fallback summary stored" : "email summary stored",
        currentEmailStep: "complete",
        currentEmailStepIndex: 4,
        currentEmailStepTotal: 4
      });
    };

    for (const [index, mailbox] of mailboxes.entries()) {
      try {
        persistRun(run, {
          currentMailboxIndex: index + 1,
          currentMailboxName: mailbox.name,
          currentStage: "正在统计本轮未读邮件"
        });
        const count = await withTimeout(
          countForMailbox(mailbox, state.settings.system.processLimitPerMailbox, dependencies.countUnreadImap),
          45000,
          `${mailbox.name}: 统计未读邮件超时`
        );
        unreadCountByMailbox.set(mailbox.id, count);
        run.totalUnreadCount = (run.totalUnreadCount ?? 0) + count;
        run.totalTaskCount = (run.totalTaskCount ?? 0) + count;
        persistRun(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unreadCountByMailbox.set(mailbox.id, 0);
        run.errors.push(`${mailbox.name}: 统计未读邮件失败，仍会尝试读取。${message}`);
        persistRun(run);
      }
    }

    const processFetchedItem = async (mailbox: Mailbox, item: FetchedEmail, recovered = false) => {
      const currentStepTotal = hasMultimodalWork(item.email, state.settings.ai) ? 5 : 4;
      persistRun(run, {
        currentMailboxName: mailbox.name,
        currentSubject: item.email.subject,
        currentStage: "正在检查处理记录",
        currentEmailStep: "检查处理记录",
        currentEmailStepIndex: 1,
        currentEmailStepTotal: currentStepTotal
      });

      const existing = getProcessedEmail(item.email.mailboxId, item.email.externalUid);
      if (existing) {
        try {
          persistRun(run, {
            currentStage: "邮件已在数据库中，正在补标已读",
            currentEmailStep: "补标已读",
            currentEmailStepIndex: currentStepTotal,
            currentEmailStepTotal: currentStepTotal
          });
          const readMark = await withTimeout(item.markRead(), 30000, "标记已读超时");
          updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, readMark);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, {
            marked: false,
            note: message
          });
          run.errors.push(`${mailbox.name}: 已入库邮件补标已读失败。${message}`);
          persistRun(run);
        }
        return;
      }

      const duplicate = findProcessedEmailDuplicate(item.email);
      if (duplicate) {
        try {
          persistRun(run, {
            currentStage: "邮件已按 Message-ID/内容指纹处理过，正在补标已读",
            currentEmailStep: "重复邮件补标",
            currentEmailStepIndex: currentStepTotal,
            currentEmailStepTotal: currentStepTotal
          });
          const readMark = await withTimeout(item.markRead(), 30000, "标记已读超时");
          updateProcessedEmailReadMark(duplicate.mailboxId, duplicate.externalUid, {
            marked: duplicate.readMarked || readMark.marked,
            note: duplicate.readMarkNote || `重复邮件 ${item.email.externalUid} 已补标已读`
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          run.errors.push(`${mailbox.name}: 重复邮件补标已读失败。${message}`);
          persistRun(run);
        }
        return;
      }

      let emailForClassification = item.email;
      let classification;
      try {
        if (currentStepTotal === 5) {
          persistRun(run, {
            currentStage: "正在识别内嵌图片/PDF",
            currentEmailStep: "多模态识别",
            currentEmailStepIndex: 2,
            currentEmailStepTotal: currentStepTotal
          });
          const multimodalAnalysis = await analyzeEmailAttachments(item.email, state.settings.ai, { timeoutMs: 90000 });
          emailForClassification = withMultimodalContext(item.email, multimodalAnalysis);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: 多模态识别失败，邮件保持未读，稍后可重新处理。${message}`);
        persistRun(run, {
          currentStage: "多模态识别失败，邮件保持未读",
          currentEmailStep: "等待重试",
          currentEmailStepIndex: 2,
          currentEmailStepTotal: currentStepTotal
        });
        return;
      }

      try {
        persistRun(run, {
          currentStage: recovered ? "正在恢复并请求 AI 分类" : "正在请求 AI 分类",
          currentEmailStep: "AI 分类",
          currentEmailStepIndex: currentStepTotal === 5 ? 3 : 2,
          currentEmailStepTotal: currentStepTotal
        });
        classification = await classifyEmail(emailForClassification, state.settings.ai, { timeoutMs: 45000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: AI 分类失败，邮件保持未读，稍后可重新处理。${message}`);
        persistRun(run, {
          currentStage: "AI 分类失败，邮件保持未读",
          currentEmailStep: "等待重试",
          currentEmailStepIndex: currentStepTotal === 5 ? 3 : 2,
          currentEmailStepTotal: currentStepTotal
        });
        return;
      }

      const processedEmail = {
        id: randomUUID(),
        ...stripAttachmentContent({
          ...item.email,
          multimodalAnalysis: emailForClassification.multimodalAnalysis
        }),
        processedAt: new Date().toISOString(),
        category: classification.category,
        summaryZh: recovered ? `[中断恢复] ${classification.summaryZh}` : classification.summaryZh,
        reasonZh: recovered
          ? `这封邮件来自旧处理任务中断后的恢复扫描。${classification.reasonZh}`
          : classification.reasonZh,
        actionItemsZh: classification.actionItemsZh,
        panelRead: classification.category === "ignore",
        panelReadAt: classification.category === "ignore" ? new Date().toISOString() : undefined,
        readMarked: false,
        readMarkNote: "已写入数据库，正在标记已读。"
      };
      const insertedEmail = addProcessedEmail(processedEmail);
      if (!insertedEmail) {
        try {
          await withTimeout(item.markRead(), 30000, "标记已读超时");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          run.errors.push(`${mailbox.name}: 重复入库邮件补标已读失败。${message}`);
        }
        persistRun(run, {
          currentStage: "邮件已由另一轮任务入库，正在跳过重复通知",
          currentEmailStep: "跳过重复",
          currentEmailStepIndex: currentStepTotal,
          currentEmailStepTotal: currentStepTotal
        });
        return;
      }

      incrementRun(run, classification.category);
      persistRun(run, {
        currentStage: "已写入数据库，正在标记已读",
        currentEmailStep: "写入数据库",
        currentEmailStepIndex: currentStepTotal === 5 ? 4 : 3,
        currentEmailStepTotal: currentStepTotal
      });

      enqueuedNotificationCount += enqueueEmailNotifications(insertedEmail).length;

      try {
        persistRun(run, {
          currentStage: "已写入数据库，正在标记已读",
          currentEmailStep: "标记已读",
          currentEmailStepIndex: currentStepTotal,
          currentEmailStepTotal: currentStepTotal
        });
        const readMark = await withTimeout(item.markRead(), 30000, "标记已读超时");
        updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, readMark);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, {
          marked: false,
          note: message
        });
        run.errors.push(`${mailbox.name}: 邮件已入库，但标记已读失败。${message}`);
      }
      persistRun(run, {
        currentStage: `已处理 ${run.processedCount} 封`,
        currentEmailStep: "完成",
        currentEmailStepIndex: currentStepTotal,
        currentEmailStepTotal: currentStepTotal
      });
    };

    for (const [index, mailbox] of mailboxes.entries()) {
      try {
        persistRun(run, {
          currentMailboxIndex: index + 1,
          currentMailboxName: mailbox.name,
          currentSubject: undefined,
          currentStage: "正在读取未读邮件",
          currentMailboxUnreadCount: unreadCountByMailbox.get(mailbox.id) ?? 0,
          currentMailboxHandledCount: 0,
          currentEmailStep: "",
          currentEmailStepIndex: 0,
          currentEmailStepTotal: 0
        });

        if (mailbox.protocol === "imap") {
          const config = imapConfigFor(mailbox);
          const attemptedPendingKeys = new Set<string>();
          const processPending = async (pending: RawMail[]) => {
            const freshPending = pending.filter(
              (item) => !attemptedPendingKeys.has(fetchedMailExternalUid(item.key))
            );
            const expectedUnreadCount = unreadCountByMailbox.get(mailbox.id) ?? 0;
            if (freshPending.length > expectedUnreadCount) {
              const additional = freshPending.length - expectedUnreadCount;
              run.totalUnreadCount = (run.totalUnreadCount ?? 0) + additional;
              run.currentMailboxUnreadCount = (run.currentMailboxUnreadCount ?? 0) + additional;
              run.totalTaskCount = (run.totalTaskCount ?? 0) + additional;
              persistRun(run);
            }

            for (const item of freshPending) {
              const pendingKey = fetchedMailExternalUid(item.key);
              attemptedPendingKeys.add(pendingKey);
              run.currentSubject = `UID ${item.key.uid}`;
              persistRun(run, {
                currentStage: "正在解析和摘要 IMAP 邮件",
                currentEmailStep: "解析邮件"
              });
              await processIncrementalImapItem(mailbox, item);
              run.handledTaskCount = (run.handledTaskCount ?? 0) + 1;
              run.handledUnreadCount = (run.handledUnreadCount ?? 0) + 1;
              run.currentMailboxHandledCount = (run.currentMailboxHandledCount ?? 0) + 1;
              persistRun(run);
            }
          };

          const pendingBeforeFetch = readPendingFetchedMails(
            config.ownerId,
            config.mailboxId,
            config.folder,
            state.settings.system.processLimitPerMailbox
          );
          await processPending(pendingBeforeFetch);

          let remoteError = "";
          try {
            await withTimeout(
              fetchIncrementalImap(mailbox, state.settings.system.processLimitPerMailbox, imapReader),
              120000,
              `${mailbox.name}: IMAP 增量读取超时`
            );
          } catch (error) {
            if (!pendingBeforeFetch.length) throw error;
            remoteError = error instanceof Error ? error.message : String(error);
            run.errors.push(`${mailbox.name}: ${remoteError}`);
            persistRun(run, { currentStage: `本地 pending 已处理，IMAP 暂时不可用：${remoteError}` });
          }

          const pendingAfterFetch = readPendingFetchedMails(
            config.ownerId,
            config.mailboxId,
            config.folder,
            state.settings.system.processLimitPerMailbox
          );
          await processPending(pendingAfterFetch);

          updateMailboxSync(mailbox.id, {
            lastSyncAt: new Date().toISOString(),
            lastError: remoteError
          });
          continue;
        }

        const fetched = await withTimeout(
          fetchForMailbox(mailbox, state.settings.system.processLimitPerMailbox),
          120000,
          `${mailbox.name}: 读取邮箱超时`
        );
        const expectedUnreadCount = unreadCountByMailbox.get(mailbox.id) ?? 0;
        if (fetched.length > expectedUnreadCount) {
          const additionalUnread = fetched.length - expectedUnreadCount;
          run.totalUnreadCount = (run.totalUnreadCount ?? 0) + additionalUnread;
          run.currentMailboxUnreadCount = (run.currentMailboxUnreadCount ?? 0) + additionalUnread;
          run.totalTaskCount = (run.totalTaskCount ?? 0) + additionalUnread;
          persistRun(run);
        }

        for (const item of fetched) {
          await processFetchedItem(mailbox, item);
          run.handledTaskCount = (run.handledTaskCount ?? 0) + 1;
          run.handledUnreadCount = (run.handledUnreadCount ?? 0) + 1;
          run.currentMailboxHandledCount = (run.currentMailboxHandledCount ?? 0) + 1;
          persistRun(run);
        }

        updateMailboxSync(mailbox.id, {
          lastSyncAt: new Date().toISOString(),
          lastError: ""
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: ${message}`);
        updateMailboxSync(mailbox.id, { lastError: message });
        persistRun(run, { currentStage: message });
      }
    }

    run.status = run.errors.length ? "failed" : "success";
    run.finishedAt = new Date().toISOString();
    run.currentStage = run.status === "success" ? "处理完成" : "处理完成，有错误";
    run.currentSubject = undefined;
    persistRun(run);
    if (enqueuedNotificationCount > 0 && !options.suppressNotificationDispatch) {
      scheduleNotificationDispatch(0);
    }
    return run;
  } finally {
    running = false;
    updateRun(run);
  }
}

export function isProcessorRunning() {
  return running;
}

function scheduleQueueDrain(delayMs = 1000) {
  if (queueDrainTimer) return;
  queueDrainTimer = setTimeout(() => {
    queueDrainTimer = undefined;
    void drainProcessingQueue();
  }, delayMs);
}

async function drainProcessingQueue() {
  if (queueDraining) return;
  if (running) {
    scheduleQueueDrain(10000);
    return;
  }

  const mailboxId = queuedMailboxIds.values().next().value as string | undefined;
  if (!mailboxId) return;

  queuedMailboxIds.delete(mailboxId);
  queueDraining = true;
  try {
    await processMailboxes({ mailboxId, suppressNotificationDispatch: true });
  } catch {
    queuedMailboxIds.add(mailboxId);
    scheduleQueueDrain(10000);
  } finally {
    queueDraining = false;
  }

  if (queuedMailboxIds.size) {
    scheduleQueueDrain(1000);
  } else {
    scheduleNotificationDispatch(0);
  }
}

export function requestMailboxProcessing(mailboxId: string, delayMs = 5000) {
  if (!mailboxId) return;
  queuedMailboxIds.add(mailboxId);
  scheduleQueueDrain(delayMs);
}

export function startProcessingWorker(options: { recoverInterruptedOnFirstRun?: boolean } = {}) {
  let lastAttemptAt = 0;
  let shouldRecoverInterrupted = Boolean(options.recoverInterruptedOnFirstRun);

  const tick = async () => {
    const current = { settings: readSettings(), mailboxes: readMailboxes() };
    if (!current.settings.system.autoProcessEnabled || running) return;
    if (!current.mailboxes.some((mailbox) => mailbox.enabled)) return;

    const intervalMs = Math.max(current.settings.system.pollIntervalMinutes, 1) * 60 * 1000;
    if (Date.now() - lastAttemptAt < intervalMs) return;
    lastAttemptAt = Date.now();

    try {
      await processMailboxes({ recoverInterrupted: shouldRecoverInterrupted });
      shouldRecoverInterrupted = false;
    } catch {
      // The run itself records detailed errors. The worker stays alive.
    }
  };

  const timer = setInterval(tick, 60 * 1000);
  void tick();
  return timer;
}
