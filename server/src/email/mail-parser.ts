import { simpleParser } from "mailparser";
import type { RawMail } from "./mail-reader";

export const MAX_MODEL_BODY_CHARS = 20_000;

export type NormalizedMail = {
  key: RawMail["key"];
  from: string;
  subject: string;
  receivedAt: string;
  bodyText: string;
  bodyTruncated: boolean;
  attachmentNames: string[];
  sourceMessageId?: string;
  oversized: boolean;
  sizeBytes: number;
};

export type MailParserError = {
  code: "INVALID_INPUT";
  retryable: false;
  message: string;
};

export type MailParserResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MailParserError };

export interface MailParser {
  parse(mail: RawMail): Promise<MailParserResult<NormalizedMail>>;
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[normalized] ?? match;
  });
}

function htmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\s*(script|style|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(div|li|p|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r\n?/g, "\n")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function limitBody(value: string) {
  return value.length > MAX_MODEL_BODY_CHARS
    ? { bodyText: value.slice(0, MAX_MODEL_BODY_CHARS), bodyTruncated: true }
    : { bodyText: value, bodyTruncated: false };
}

function hasPlainTextPart(source: string) {
  return /^\s*content-type:\s*text\/plain(?:[;\s]|$)/im.test(source);
}

function fail(message: string): MailParserResult<never> {
  return { ok: false, error: { code: "INVALID_INPUT", retryable: false, message } };
}

export class MimeMailParser implements MailParser {
  async parse(mail: RawMail): Promise<MailParserResult<NormalizedMail>> {
    if (mail.oversized) {
      return {
        ok: true,
        value: {
          key: mail.key,
          from: "",
          subject: "(超大邮件，须查看原邮件)",
          receivedAt: mail.receivedAt,
          bodyText: "",
          bodyTruncated: false,
          attachmentNames: [],
          oversized: true,
          sizeBytes: mail.sizeBytes
        }
      };
    }

    if (!mail.rawBytes) return fail("邮件没有可解析的原文");

    try {
      const rawSource = Buffer.from(mail.rawBytes);
      const parsed = await simpleParser(rawSource);
      const sourceHtml = typeof parsed.html === "string" ? parsed.html : "";
      const body = hasPlainTextPart(rawSource.toString("utf8"))
        ? parsed.text?.trim() || htmlToText(sourceHtml)
        : htmlToText(sourceHtml) || parsed.text?.trim() || "";
      const limited = limitBody(body);
      return {
        ok: true,
        value: {
          key: mail.key,
          from: parsed.from?.text?.trim() || "",
          subject: parsed.subject?.trim() || "(无主题)",
          receivedAt: parsed.date?.toISOString() || mail.receivedAt,
          ...limited,
          attachmentNames: parsed.attachments.map(
            (attachment) => attachment.filename || attachment.cid || attachment.contentId || attachment.contentType || "unnamed"
          ),
          sourceMessageId: parsed.messageId,
          oversized: false,
          sizeBytes: mail.sizeBytes
        }
      };
    } catch {
      return fail("邮件正文解析失败");
    }
  }
}
