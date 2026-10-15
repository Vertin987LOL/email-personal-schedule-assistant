import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MODEL_BODY_CHARS, MimeMailParser, type NormalizedMail } from "./mail-parser";
import type { RawMail } from "./mail-reader";

const parser = new MimeMailParser();

function raw(source: string, overrides: Partial<RawMail> = {}): RawMail {
  const rawBytes = new Uint8Array(Buffer.from(source, "utf8"));
  return {
    key: {
      ownerId: "owner-a",
      mailboxId: "mailbox-a",
      folder: "INBOX",
      uidValidity: "7",
      uid: "12"
    },
    receivedAt: "2026-10-16T00:00:00.000Z",
    rawBytes,
    oversized: false,
    sizeBytes: rawBytes.byteLength,
    ...overrides
  };
}

async function parse(source: string, overrides: Partial<RawMail> = {}): Promise<NormalizedMail> {
  const result = await parser.parse(raw(source, overrides));
  if (result.ok) return result.value;
  throw new Error(result.error.message);
}

test("parser keeps plain text, headers, and message id", async () => {
  const mail = await parse([
    "From: 老师 <teacher@example.test>",
    "Subject: 作业提醒",
    "Message-ID: <assignment-12@example.test>",
    "Date: Fri, 16 Oct 2026 08:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "请在周五18:00前提交。"
  ].join("\r\n"));

  assert.match(mail.from, /老师/);
  assert.match(mail.from, /teacher@example\.test/);
  assert.equal(mail.subject, "作业提醒");
  assert.equal(mail.bodyText, "请在周五18:00前提交。");
  assert.equal(mail.bodyTruncated, false);
  assert.equal(mail.sourceMessageId, "<assignment-12@example.test>");
  assert.equal(mail.oversized, false);
});

test("parser turns HTML-only mail into text without loading remote resources", async () => {
  const mail = await parse([
    "From: Office <office@example.test>",
    "Subject: HTML notice",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><h1>通知</h1><p>请查看&nbsp;课程页面。</p><img src=\"https://remote.example.test/pixel\"></body></html>"
  ].join("\r\n"));

  assert.match(mail.bodyText, /通知/);
  assert.match(mail.bodyText, /课程页面/);
  assert.doesNotMatch(mail.bodyText, /remote\.example\.test/);
});

test("parser preserves empty body and lists attachment names only", async () => {
  const boundary = "mail-parser-boundary";
  const mail = await parse([
    "From: Office <office@example.test>",
    "Subject: Files",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "",
    `--${boundary}`,
    'Content-Type: application/pdf; name="通知.pdf"',
    'Content-Disposition: attachment; filename="通知.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("fake pdf").toString("base64"),
    `--${boundary}--`,
    ""
  ].join("\r\n"));

  assert.equal(mail.bodyText, "");
  assert.deepEqual(mail.attachmentNames, ["通知.pdf"]);
});

test("parser limits model input and marks truncation", async () => {
  const body = "甲".repeat(MAX_MODEL_BODY_CHARS + 12);
  const mail = await parse([
    "Subject: Long",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n"));

  assert.equal(mail.bodyText.length, MAX_MODEL_BODY_CHARS);
  assert.equal(mail.bodyTruncated, true);
});

test("parser returns a metadata placeholder for oversized mail", async () => {
  const mail = await parse("", {
    rawBytes: undefined,
    oversized: true,
    sizeBytes: 10 * 1024 * 1024 + 1
  });

  assert.equal(mail.oversized, true);
  assert.equal(mail.bodyText, "");
  assert.match(mail.subject, /超大邮件/);
  assert.equal(mail.sizeBytes, 10 * 1024 * 1024 + 1);
});
