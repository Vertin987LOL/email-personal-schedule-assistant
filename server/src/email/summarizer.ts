import { classifyEmail } from "../ai";
import type { AiSettings, ClassificationResult, IncomingEmail } from "../types";
import type { NormalizedMail } from "./mail-parser";

export type Summary = {
  key: NormalizedMail["key"];
  version: string;
  explanationZh: string;
  status: "ready" | "fallback";
  caveats: string[];
};

export type SummarizerError = {
  code: "INVALID_INPUT" | "MODEL_OUTPUT";
  retryable: boolean;
  message: string;
};

export type SummarizerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SummarizerError };

export type ClassificationCall = (
  email: IncomingEmail,
  settings: AiSettings,
  options: { timeoutMs?: number; usageScope?: "email" | "system"; usagePurpose?: "email_classification" | "system_test" }
) => Promise<ClassificationResult>;

function fallbackError(error: unknown): SummarizerError {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return {
    code: "MODEL_OUTPUT",
    retryable: !message.includes("api key") && !message.includes("未配置"),
    message: "模型摘要失败"
  };
}

function toIncomingEmail(mail: NormalizedMail): IncomingEmail {
  return {
    mailboxId: mail.key.mailboxId,
    externalUid: mail.key.uid,
    subject: mail.subject,
    fromAddress: mail.from || undefined,
    receivedAt: mail.receivedAt,
    originalText: mail.bodyText,
    attachments: mail.attachmentNames.map((filename, index) => ({
      id: `attachment-${index + 1}`,
      filename,
      contentType: "application/octet-stream",
      size: 0,
      related: false,
      supportedForVision: false
    }))
  };
}

export interface Summarizer {
  summarize(mail: NormalizedMail, settings: AiSettings): Promise<SummarizerResult<Summary>>;
}

export class AiSummarizer implements Summarizer {
  constructor(private readonly classify: ClassificationCall = classifyEmail) {}

  async summarize(mail: NormalizedMail, settings: AiSettings): Promise<SummarizerResult<Summary>> {
    if (mail.oversized) {
      return {
        ok: true,
        value: {
          key: mail.key,
          version: "v1",
          explanationZh: "邮件原文超过系统读取上限，未能取得正文摘要，请查看原邮件。",
          status: "fallback",
          caveats: ["原文超过10 MiB，未提交给模型"]
        }
      };
    }

    try {
      const classification = await this.classify(toIncomingEmail(mail), settings, {
        usageScope: "email",
        usagePurpose: "email_classification"
      });
      const explanationZh = classification.summaryZh.trim();
      if (!explanationZh) {
        return { ok: false, error: { code: "MODEL_OUTPUT", retryable: true, message: "模型未返回摘要" } };
      }
      const caveats = [
        ...(mail.bodyTruncated ? ["正文已截断，完整内容请查看原邮件"] : []),
        ...(mail.attachmentNames.length ? ["附件仅列出名称，未分析附件内容"] : [])
      ];
      return {
        ok: true,
        value: {
          key: mail.key,
          version: "v1",
          explanationZh,
          status: "ready",
          caveats
        }
      };
    } catch (error) {
      return { ok: false, error: fallbackError(error) };
    }
  }
}

function fallbackSummary(mail: NormalizedMail, reason: string): Summary {
  return {
    key: mail.key,
    version: "v1",
    explanationZh: `未能取得模型摘要，请查看原邮件。主题：${mail.subject || "无主题"}；发件人：${mail.from || "未知"}。`,
    status: "fallback",
    caveats: [
      "模型请求失败，未对正文作完整判断",
      reason,
      ...(mail.bodyTruncated ? ["正文已截断"] : []),
      ...(mail.attachmentNames.length ? ["附件未解析"] : [])
    ]
  };
}

export class RetryingSummarizer implements Summarizer {
  constructor(private readonly inner: Summarizer, private readonly maxAttempts = 3) {}

  async summarize(mail: NormalizedMail, settings: AiSettings): Promise<SummarizerResult<Summary>> {
    let lastError: SummarizerError = {
      code: "MODEL_OUTPUT",
      retryable: true,
      message: "模型摘要失败"
    };
    const attempts = Math.max(1, Math.floor(this.maxAttempts));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.inner.summarize(mail, settings);
      if (result.ok) return result;
      lastError = result.error;
      if (!lastError.retryable) break;
    }
    return { ok: true, value: fallbackSummary(mail, lastError.message) };
  }
}
