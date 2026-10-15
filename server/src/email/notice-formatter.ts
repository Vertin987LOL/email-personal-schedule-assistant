import { createHash } from "node:crypto";
import type { NormalizedMail } from "./mail-parser";
import type { Summary } from "./summarizer";

export const MAX_NOTICE_PARTS = 3;
export const MAX_NOTICE_PART_CHARS = 1_200;

export type Notice = {
  id: string;
  key: NormalizedMail["key"];
  summaryVersion: string;
  channel: "clawbot";
  recipientRef: string;
  part: number;
  text: string;
  state: "pending";
  attempts: 0;
};

export type NoticeFormatterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: "INVALID_INPUT"; retryable: false; message: string } };

function clip(text: string, maxLength: number) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 18).trimEnd()}…（完整内容见本地页面）`;
}

function stableNoticeId(
  mail: NormalizedMail,
  summary: Summary,
  recipientRef: string,
  part: number
) {
  return createHash("sha256")
    .update([
      mail.key.ownerId,
      mail.key.mailboxId,
      mail.key.folder,
      mail.key.uidValidity,
      mail.key.uid,
      summary.version,
      "clawbot",
      recipientRef,
      String(part)
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

function invalid(message: string): NoticeFormatterResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", retryable: false, message } };
}

export function formatMailNotices(
  mail: NormalizedMail,
  summary: Summary,
  recipientRef: string
): NoticeFormatterResult<Notice[]> {
  if (!recipientRef.trim()) return invalid("通知接收人未配置");
  if (summary.key.ownerId !== mail.key.ownerId || summary.key.mailboxId !== mail.key.mailboxId || summary.key.uid !== mail.key.uid) {
    return invalid("摘要与邮件键不匹配");
  }

  const metadata = [
    `主题：${clip(mail.subject || "无主题", 300)}`,
    `发件人：${clip(mail.from || "未知发件人", 300)}`,
    `收件时间：${clip(mail.receivedAt, 120)}`
  ].join("\n");
  const explanation = summary.status === "fallback" && !summary.explanationZh.includes("未能分析")
    ? `未能分析，请查原邮件。${summary.explanationZh}`
    : summary.explanationZh || "未能分析，请查原邮件。";
  const caveats = [
    ...summary.caveats,
    ...(mail.bodyTruncated ? ["正文未完整解析"] : []),
    ...(mail.attachmentNames.length ? [`附件：${mail.attachmentNames.join("、")}（未解析）`] : []),
    `来源：${mail.key.mailboxId} / UID ${mail.key.uid}`
  ];
  const paragraphs = [metadata, clip(explanation, MAX_NOTICE_PART_CHARS), clip(caveats.join("\n"), MAX_NOTICE_PART_CHARS)]
    .filter(Boolean)
    .slice(0, MAX_NOTICE_PARTS);

  return {
    ok: true,
    value: paragraphs.map((text, index) => ({
      id: stableNoticeId(mail, summary, recipientRef, index + 1),
      key: mail.key,
      summaryVersion: summary.version,
      channel: "clawbot",
      recipientRef,
      part: index + 1,
      text,
      state: "pending",
      attempts: 0
    }))
  };
}
