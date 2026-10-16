import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessedEmail } from "../types";
import { buildEmailNotificationModel, renderEmailNotification } from "./format";

function email(category: ProcessedEmail["category"]): ProcessedEmail {
  return {
    id: `email-${category}`,
    mailboxId: "mailbox-1",
    externalUid: "1",
    subject: "Please review",
    processedAt: "2026-08-16T00:00:00.000Z",
    category,
    summaryZh: "这封邮件需要查看。",
    reasonZh: "测试",
    actionItemsZh: ["打开邮件"],
    originalText: "Please review",
    readMarked: true
  };
}

test("important and secondary notifications have visibly distinct headers", () => {
  const important = renderEmailNotification(buildEmailNotificationModel(email("important")));
  const secondary = renderEmailNotification(buildEmailNotificationModel(email("secondary")));

  assert.match(important, /^【重要邮件｜请尽快查看】/);
  assert.match(secondary, /^【次重要邮件｜建议稍后阅读】/);
  assert.notEqual(important.split("\n")[0], secondary.split("\n")[0]);
});

test("notification messages retain the Chinese summary and numbered actions", () => {
  const message = renderEmailNotification(buildEmailNotificationModel(email("important")));
  assert.match(message, /完整分析\n这封邮件需要查看。/);
  assert.match(message, /建议动作\n1\. 打开邮件/);
});

test("notification model preserves structured Markdown line breaks", () => {
  const structured = email("important");
  structured.summaryZh = "**核心结论**：需要查看。\n\n- **截止时间**：9 月 3 日";
  const model = buildEmailNotificationModel(structured);

  assert.equal(model.summary, structured.summaryZh);
});

test("calendar notes render in their own section without summary truncation", () => {
  const structured = email("important");
  structured.summaryZh = "邮件摘要";
  structured.calendarAnalysis = {
    state: "ready",
    notes: "第一场与线性代数重叠15:00—16:00，共60分钟。\n第二场无重叠。"
  };
  const message = renderEmailNotification(buildEmailNotificationModel(structured));
  assert.match(message, /日程核对\n状态：已完成核对/);
  assert.match(message, /第一场与线性代数重叠15:00—16:00，共60分钟。/);
  assert.match(message, /第二场无重叠。/);
  assert.ok(message.indexOf("日程核对") > message.indexOf("完整分析"));
});
