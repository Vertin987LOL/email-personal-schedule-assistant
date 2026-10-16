import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { CalendarService } from "../server/src/calendar/service";
import { CalendarAgentRuntime } from "../server/src/calendar/agent-runtime";
import { calendarExecutorFactory, type CalendarExecutorSettings } from "../server/src/calendar/agent-settings";
import { CalendarEmailBridge } from "../server/src/calendar/email-bridge";
import type { ProcessedEmail } from "../server/src/types";

// This probe uses the real executor with an in-memory fictional schedule. It cannot send messages.
const root = process.cwd();
const settings: CalendarExecutorSettings = {
  enabled: true,
  executable: path.join(process.env.LOCALAPPDATA ?? "", "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
  model: process.env.CALENDAR_SMOKE_MODEL ?? "gpt-5.6-luna", effort: "xhigh", builtinOpenai: true,
  authFile: path.join(process.env.USERPROFILE ?? "", ".codex", "auth.json")
};
const db = new DatabaseSync(":memory:");
const calendar = new CalendarService(db);
calendar.createEvent("fixture", { title: "虚构线性代数", kind: "course", status: "confirmed", sources: [{ kind: "course", ref: "fictional" }], time: {
  kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: "Asia/Shanghai"
} });
const app = express(); app.use(express.json());
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
let executorError: string | undefined;
let executorText: string | undefined;
let executorStatus: string | undefined;
let bridge: CalendarEmailBridge | undefined;
const factory = calendarExecutorFactory(settings, root, `http://127.0.0.1:${port}/api/calendar/agent-tools`);
const runtime = new CalendarAgentRuntime(calendar, async input => {
  const host = await factory(input);
  return { run: async params => {
    const result = await host.run(params);
    executorStatus = result.status;
    executorText = result.text.slice(0, 1800);
    // Protocol messages are retained only for this fictional-data probe; redact credential-shaped values.
    executorError = result.error?.replace(/(?:Bearer\s+|sk-|eyJ)[A-Za-z0-9._-]+/gi, "[redacted]").slice(0, 800);
    return result;
  }, cancel: () => host.cancel(), close: () => host.close() };
}, undefined, undefined, task => bridge?.settle(task));
app.post("/api/calendar/agent-tools", (req, res) => {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  res.json(runtime.invoke(token, String(req.body?.name ?? ""), req.body?.args));
});
const started = Date.now();
try {
  const task = runtime.tasks.create({ sourceKind: "manual", sourceKey: "real-model-fictional-smoke", text: [
    "这是虚构样本测试，禁止创建提案或修改日程。请至少连续调用两次工具：",
    "先调用calendar.list查询2026-10-20上海时间00:00到2026-10-21的00:00；",
    "再调用calendar.preview核对一场虚构讲座：2026-10-20 14:00—16:00，Asia/Shanghai，kind=activity，requireFree=false。",
    "根据回执报告与哪节课重叠、重叠范围和分钟数。只查询，不申请本人确认，不调用request_input。"
  ].join("\n") });
  await runtime.drain();
  const finished = runtime.tasks.get(task.id)!;
  const receipts = (finished.result as { receipts?: Array<{ name: string; result: { ok: boolean; data?: { overlaps?: Array<{ overlapMinutes: number }> } } }> } | undefined)?.receipts ?? [];
  const names = receipts.map(item => item.name);
  const overlaps = receipts.flatMap(item => item.name === "calendar.preview" ? item.result.data?.overlaps ?? [] : []);
  const conflictPassed = finished.state === "succeeded" && names.includes("calendar.list") && names.includes("calendar.preview") && overlaps.some(item => item.overlapMinutes === 60) && calendar.listProposals().length === 0;
  runtime.tasks.addInput(task.id, { inputKey: "fictional-follow-up", text: "继续只查询。再调用 calendar.find_slots，范围仍为2026-10-20，Asia/Shanghai，durationMinutes=120，dayStart=16:30，dayEnd=20:00。回答最早可用时间；不创建提案。" });
  await runtime.drain();
  const resumed = runtime.tasks.get(task.id)!;
  const followUpTools = ((resumed.result as { receipts?: Array<{ name: string; result: { ok: boolean } }> })?.receipts ?? []).filter(item => item.result.ok).map(item => item.name);
  const resumePassed = resumed.state === "succeeded" && resumed.threadId === finished.threadId && followUpTools.includes("calendar.find_slots");
  const mail: ProcessedEmail = { id: "fictional-mail", mailboxId: "fictional-box", externalUid: "1:1", subject: "虚构讲座邀请", fromAddress: "fictional@example.invalid",
    receivedAt: "2026-10-16T10:00:00+08:00", processedAt: new Date().toISOString(), originalText: "科研讲座于2026年10月20日14:00—16:00举行，时间为中国标准时间。活动编号：FICTIONAL-123。", summaryZh: "虚构摘要", category: "important", reasonZh: "样本", actionItemsZh: [], readMarked: false };
  let storedMail = mail;
  bridge = new CalendarEmailBridge(runtime, { readEmail: id => id === mail.id ? storedMail : undefined, updateCalendar: (id, analysis) => {
    if (id !== mail.id) return undefined; storedMail = { ...storedMail, calendarAnalysis: analysis }; return storedMail;
  } });
  const pendingMail = bridge.enqueue(mail);
  await runtime.drain();
  const emailTask = runtime.tasks.get(pendingMail.calendarAnalysis!.taskId!)!;
  bridge.settle(emailTask);
  const emailReport = bridge.analysis.get(mail.id);
  const emailPassed = storedMail.calendarAnalysis?.state === "ready" && emailReport?.activities.some(activity => activity.overlaps.some(overlap => overlap.overlapMinutes === 60)) === true;
  const passed = conflictPassed && resumePassed && emailPassed;
  const result = { at: new Date().toISOString(), model: settings.model, effort: settings.effort, realModel: true, fictionalData: true,
    passed, conflictPassed, resumePassed, emailPassed, followUpTools, emailTaskState: emailTask.state, emailAnalysisState: storedMail.calendarAnalysis?.state,
    taskState: finished.state, error: finished.error, executorError, executorStatus, executorText, tools: names, overlapMinutes: overlaps.map(item => item.overlapMinutes), elapsedMs: Date.now() - started,
    sentMessages: 0, enabledMailboxes: "not accessed", productionData: "not accessed" };
  const output = path.resolve(root, "../../personal-calendar-system/outputs", `model-smoke-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, report: output }));
  process.exitCode = passed ? 0 : 1;
} finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
