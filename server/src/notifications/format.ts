import type {
  EmailCalendarAnalysisStatus,
  MailCategory,
  Mailbox,
  ProcessedEmail,
  ProcessedEmailCalendarAnalysis
} from "../types";

export type EmailCalendarNotificationModel = {
  status: EmailCalendarAnalysisStatus;
  statusLabel: string;
  taskId?: string;
  deadlineAt?: string;
  checkedAt?: string;
  notes: string[];
};

export type EmailNotificationModel = {
  emailId: string;
  category: MailCategory;
  categoryLabel: string;
  urgencyLabel: string;
  subject: string;
  sender: string;
  mailbox: string;
  recipient?: string;
  receivedAt: string;
  summary: string;
  actions: string[];
  calendarAnalysis?: EmailCalendarNotificationModel;
};

function compact(value: string | undefined, maxLength: number, fallback: string) {
  const text = (value ?? "").replace(/\s+/g, " ").trim() || fallback;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}...`;
}

function compactMarkdown(value: string | undefined, maxLength: number, fallback: string) {
  const text = (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || fallback;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatDateTime(value?: string) {
  if (!value) return "未知时间";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function categoryMeta(category: MailCategory) {
  if (category === "important") return { categoryLabel: "重要邮件", urgencyLabel: "请尽快查看" };
  if (category === "secondary") return { categoryLabel: "次重要邮件", urgencyLabel: "建议稍后阅读" };
  return { categoryLabel: "不用管邮件", urgencyLabel: "仅作记录" };
}

function calendarStatusLabel(status: EmailCalendarAnalysisStatus) {
  if (status === "ready") return "已完成核对";
  if (status === "pending") return "等待核对";
  if (status === "failed") return "核对失败";
  return "未执行核对";
}

function calendarNotification(email: ProcessedEmail): EmailCalendarNotificationModel {
  const source: ProcessedEmailCalendarAnalysis = email.calendarAnalysis ?? { state: "skipped" };
  const rawNotes = Array.isArray(source.notes) ? source.notes : source.notes ? [source.notes] : [];
  const notes = rawNotes
    .flatMap((note) => String(note).replace(/\r\n?/g, "\n").split("\n"))
    .map((note) => note.trim())
    .filter(Boolean);
  return {
    status: source.state,
    statusLabel: calendarStatusLabel(source.state),
    ...(source.taskId ? { taskId: source.taskId } : {}),
    ...(source.deadlineAt ? { deadlineAt: source.deadlineAt } : {}),
    ...(source.checkedAt ? { checkedAt: source.checkedAt } : {}),
    notes
  };
}

export function buildEmailNotificationModel(email: ProcessedEmail, mailbox?: Mailbox): EmailNotificationModel {
  const meta = categoryMeta(email.category);
  const sender = email.fromName && email.fromAddress
    ? `${email.fromName} <${email.fromAddress}>`
    : email.fromName || email.fromAddress;
  return {
    emailId: email.id,
    category: email.category,
    ...meta,
    subject: compact(email.subject, 100, "无主题"),
    sender: compact(sender, 100, "未知发件人"),
    mailbox: compact(mailbox?.name, 60, "未知邮箱"),
    ...(email.toText ? { recipient: compact(email.toText, 100, "") } : {}),
    receivedAt: formatDateTime(email.receivedAt || email.processedAt),
    summary: compactMarkdown(email.summaryZh, 1200, "暂无邮件分析。"),
    actions: email.actionItemsZh?.length
      ? email.actionItemsZh.slice(0, 5).map((item) => compactMarkdown(item, 260, ""))
      : ["暂无明确动作，请打开邮件详情确认。"],
    calendarAnalysis: calendarNotification(email)
  };
}

export function renderEmailNotification(model: EmailNotificationModel) {
  const metadata = [
    `发件人：${model.sender}`,
    `邮箱：${model.mailbox}`,
    model.recipient ? `收件人：${model.recipient}` : "",
    `时间：${model.receivedAt}`
  ].filter(Boolean);
  return [
    `【${model.categoryLabel}｜${model.urgencyLabel}】`,
    "",
    `主题：${model.subject}`,
    ...metadata,
    "",
    "完整分析",
    model.summary,
    "",
    "日程核对",
    `状态：${model.calendarAnalysis?.statusLabel ?? "未执行核对"}`,
    ...(model.calendarAnalysis?.notes ?? []).map((item) => `- ${item}`),
    "",
    "建议动作",
    ...model.actions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "可在自动邮件系统面板查看邮件原文和完整判断。"
  ].join("\n");
}

export const renderWechatEmailNotification = renderEmailNotification;
