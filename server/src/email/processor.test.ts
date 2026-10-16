import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Mailbox, ProcessedEmail } from "../types";
import { MimeMailParser, type NormalizedMail } from "./mail-parser";
import type { Cursor, MailboxConfig, MailReader, MailReaderResult, RawMail } from "./mail-reader";
import type { Summary, Summarizer } from "./summarizer";

function rawMail(mailboxId: string, uid: string, subject: string): RawMail {
  const rawBytes = new Uint8Array(Buffer.from(
    [
      "From: teacher@example.test",
      `Subject: ${subject}`,
      "Date: Fri, 16 Oct 2026 08:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `UID ${uid} body`
    ].join("\r\n")
  ));
  return {
    key: {
      ownerId: "local-owner",
      mailboxId,
      folder: "INBOX",
      uidValidity: "77",
      uid
    },
    receivedAt: "2026-10-16T08:00:00.000Z",
    rawBytes,
    oversized: false,
    sizeBytes: rawBytes.byteLength
  };
}

class FixtureReader implements MailReader {
  fetchCursors: string[] = [];

  constructor(private readonly mailboxId: string) {}

  async probe(_config: MailboxConfig): Promise<MailReaderResult<{ uidValidity: string; highestUid: string }>> {
    return { ok: true, value: { uidValidity: "77", highestUid: "5" } };
  }

  async fetchAfter(
    _config: MailboxConfig,
    cursor: Cursor,
    _limit: number
  ): Promise<MailReaderResult<{ items: RawMail[]; nextCursor: Cursor }>> {
    this.fetchCursors.push(cursor.lastUid);
    if (cursor.lastUid === "5") {
      const items = [rawMail(this.mailboxId, "6", "ready"), rawMail(this.mailboxId, "7", "fallback")];
      return { ok: true, value: { items, nextCursor: { ...cursor, lastUid: "7" } } };
    }
    return { ok: true, value: { items: [], nextCursor: cursor } };
  }
}

test("IMAP processor baselines history, persists new read mail, and keeps classification metadata", async () => {
  process.env.DATA_DIR = path.join(tmpdir(), `processor-fixture-${process.pid}-${Date.now()}`);
  process.env.QQ_CREDENTIAL_ENCRYPTION_KEY = "processor-fixture-key";

  const store = await import("../store");
  const { processMailboxes } = await import("./processor");
  const mailbox = store.upsertMailbox({
    name: "fixture mailbox",
    email: "fixture@example.test",
    protocol: "imap",
    host: "imap.example.test",
    port: 993,
    secure: true,
    username: "fixture@example.test",
    password: "fixture-password",
    folder: "INBOX",
    enabled: true
  }).find((item: Mailbox) => item.email === "fixture@example.test")!;
  assert.ok(mailbox);

  const reader = new FixtureReader(mailbox.id);
  const parser = new MimeMailParser();
  const summarizer: Summarizer = {
    async summarize(mail: NormalizedMail): Promise<{ ok: true; value: Summary }> {
      if (mail.subject === "fallback") {
        return {
          ok: true,
          value: {
            key: mail.key,
            version: "v1",
            explanationZh: "未能获得模型摘要，请查看原邮件。",
            status: "fallback",
            caveats: ["模型摘要失败"]
          }
        };
      }
      return {
        ok: true,
        value: {
          key: mail.key,
          version: "v1",
          explanationZh: "老师要求提交作业。",
          status: "ready",
          caveats: [],
          category: "important",
          reasonZh: "有明确行动要求。",
          actionItemsZh: ["提交作业"]
        }
      };
    }
  };
  const dependencies = {
    imapReader: reader,
    imapParser: parser,
    imapSummarizer: summarizer,
    countUnreadImap: async () => 0
  };

  const first = await processMailboxes({ mailboxId: mailbox.id, dependencies });
  assert.equal(first.status, "success");
  assert.equal(store.readMailCursor("local-owner", mailbox.id, "INBOX")?.lastUid, "5");
  assert.equal(store.readState().emails.length, 0);

  const second = await processMailboxes({ mailboxId: mailbox.id, dependencies });
  assert.equal(second.status, "success");
  assert.deepEqual(reader.fetchCursors, ["5"]);
  const emails = store.readState().emails.filter((email: ProcessedEmail) => email.mailboxId === mailbox.id);
  assert.equal(emails.length, 2);
  assert.equal(emails.find((email) => email.subject === "ready")?.category, "important");
  assert.deepEqual(emails.find((email) => email.subject === "ready")?.actionItemsZh, ["提交作业"]);
  assert.equal(emails.find((email) => email.subject === "fallback")?.category, "secondary");
  assert.equal(
    emails.find((email) => email.subject === "ready")?.externalUid,
    JSON.stringify(["local-owner", "INBOX", "77", "6"])
  );

  const third = await processMailboxes({ mailboxId: mailbox.id, dependencies });
  assert.equal(third.status, "success");
  assert.deepEqual(reader.fetchCursors, ["5", "7"]);
  assert.equal(store.readState().emails.filter((email: ProcessedEmail) => email.mailboxId === mailbox.id).length, 2);
});
