import assert from "node:assert/strict";
import test from "node:test";
import { formatMailNotices, MAX_NOTICE_PART_CHARS } from "./notice-formatter";
import type { NormalizedMail } from "./mail-parser";
import type { Summary } from "./summarizer";

const mail: NormalizedMail = {
  key: { ownerId: "owner-a", mailboxId: "mailbox-a", folder: "INBOX", uidValidity: "7", uid: "12" },
  from: "老师 <teacher@example.test>",
  subject: "提交提醒",
  receivedAt: "2026-10-16T00:00:00.000Z",
  bodyText: "请在周五18:00前提交。",
  bodyTruncated: true,
  attachmentNames: ["要求.pdf"],
  oversized: false,
  sizeBytes: 100
};

const summary: Summary = {
  key: mail.key,
  version: "v1",
  explanationZh: "老师要求周五18:00前提交作业。",
  status: "ready",
  caveats: []
};

test("formatter produces stable bounded notice parts with source details", () => {
  const first = formatMailNotices(mail, summary, "recipient-a");
  const second = formatMailNotices(mail, summary, "recipient-a");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.deepEqual(first.value, second.value);
  assert.equal(first.value.length, 3);
  assert.match(first.value[0].text, /主题：提交提醒/);
  assert.match(first.value[0].text, /发件人：/);
  assert.match(first.value[0].text, /收件时间：/);
  assert.match(first.value[1].text, /周五18:00/);
  assert.match(first.value[2].text, /要求\.pdf（未解析）/);
  assert.match(first.value[2].text, /正文未完整解析/);
  for (const part of first.value) assert.ok(part.text.length <= MAX_NOTICE_PART_CHARS);
});

test("formatter marks fallback summaries for manual review", () => {
  const result = formatMailNotices(mail, {
    ...summary,
    status: "fallback",
    explanationZh: "主题和发件人已保留。"
  }, "recipient-a");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value[1].text, /未能分析，请查原邮件/);
});

test("formatter rejects an empty recipient or mismatched summary key", () => {
  assert.equal(formatMailNotices(mail, summary, "").ok, false);
  assert.equal(formatMailNotices(mail, { ...summary, key: { ...summary.key, uid: "13" } }, "recipient-a").ok, false);
});

test("formatter clips a long summary and keeps the local page hint", () => {
  const result = formatMailNotices(mail, { ...summary, explanationZh: "长内容。".repeat(1000) }, "recipient-a");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.value[1].text.length <= MAX_NOTICE_PART_CHARS);
  assert.match(result.value[1].text, /完整内容见本地页面/);
});
