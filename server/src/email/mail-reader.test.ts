import assert from "node:assert/strict";
import test from "node:test";
import type { ImapFlow } from "imapflow";
import {
  baselineCursor,
  ImapMailReader,
  type MailboxConfig
} from "./mail-reader";

type FakeMessage = {
  uid: number;
  source: Buffer;
  internalDate: Date;
  seen: boolean;
};

class FakeImapClient {
  omitFetchedMetadata = false;
  mailbox = {
    uidValidity: 10n,
    uidNext: 2,
    exists: 1
  };
  readonly messages: FakeMessage[] = [
    {
      uid: 1,
      source: Buffer.from("Subject: old\r\n\r\nold"),
      internalDate: new Date("2026-10-16T00:00:00.000Z"),
      seen: false
    }
  ];

  async connect() {}

  async getMailboxLock() {
    return { release() {} };
  }

  async logout() {}

  async search(query: { all?: boolean; uid?: string }) {
    if (query.all) return this.messages.map((message) => message.uid);
    const start = Number(query.uid?.split(":")[0] ?? 0);
    return this.messages.filter((message) => message.uid >= start).map((message) => message.uid);
  }

  async *fetch(uids: number[], query: { source?: unknown }) {
    for (const uid of uids) {
      const message = this.messages.find((item) => item.uid === uid);
      if (!message || (this.omitFetchedMetadata && uid === 2)) continue;
      yield {
        uid,
        size: message.source.byteLength,
        internalDate: message.internalDate,
        ...(query.source ? { source: message.source } : {})
      };
    }
  }

  async fetchOne(uidText: string, query: { source?: { maxLength?: number } }) {
    const message = this.messages.find((item) => item.uid === Number(uidText));
    if (!message) return false;
    const maxLength = query.source?.maxLength;
    return {
      uid: message.uid,
      size: message.source.byteLength,
      internalDate: message.internalDate,
      source: maxLength ? message.source.subarray(0, maxLength) : message.source
    };
  }
}

const config: MailboxConfig = {
  ownerId: "local-owner",
  mailboxId: "mailbox-1",
  folder: "INBOX",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "user@example.test",
  password: "test-only"
};

test("incremental reader includes newly read mail and does not duplicate a cursor range", async () => {
  const fake = new FakeImapClient();
  const reader = new ImapMailReader(() => fake as unknown as ImapFlow);
  const probed = await reader.probe(config);
  assert.equal(probed.ok, true);
  if (!probed.ok) return;

  const cursor = baselineCursor(config, probed.value);
  fake.messages.push(
    {
      uid: 2,
      source: Buffer.from("Subject: read\r\n\r\nread"),
      internalDate: new Date("2026-10-16T00:01:00.000Z"),
      seen: true
    },
    {
      uid: 3,
      source: Buffer.from("Subject: new\r\n\r\nnew"),
      internalDate: new Date("2026-10-16T00:02:00.000Z"),
      seen: false
    },
    {
      uid: 4,
      source: Buffer.from("Subject: newest\r\n\r\nnewest"),
      internalDate: new Date("2026-10-16T00:03:00.000Z"),
      seen: false
    }
  );
  fake.mailbox.uidNext = 5;
  fake.mailbox.exists = 4;

  const fetched = await reader.fetchAfter(config, cursor, 20);
  assert.equal(fetched.ok, true);
  if (!fetched.ok) return;
  assert.deepEqual(fetched.value.items.map((item) => item.key.uid), ["2", "3", "4"]);
  assert.equal(fetched.value.nextCursor.lastUid, "4");
  assert.equal(fake.messages.find((message) => message.uid === 2)?.seen, true);

  const repeated = await reader.fetchAfter(config, fetched.value.nextCursor, 20);
  assert.deepEqual(repeated, { ok: true, value: { items: [], nextCursor: fetched.value.nextCursor } });
});

test("UIDVALIDITY change pauses incremental reading instead of moving the cursor", async () => {
  const fake = new FakeImapClient();
  const reader = new ImapMailReader(() => fake as unknown as ImapFlow);
  const cursor = {
    ownerId: config.ownerId,
    mailboxId: config.mailboxId,
    folder: config.folder,
    uidValidity: "9",
    lastUid: "1"
  };
  fake.mailbox.uidValidity = 10n;

  const result = await reader.fetchAfter(config, cursor, 20);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "CONFIG");
  assert.equal(result.error.retryable, false);
});

test("partial metadata fetch fails instead of advancing the cursor", async () => {
  const fake = new FakeImapClient();
  fake.messages.push({
    uid: 2,
    source: Buffer.from("Subject: missing metadata\r\n\r\nbody"),
    internalDate: new Date("2026-10-16T00:01:00.000Z"),
    seen: false
  });
  fake.mailbox.uidNext = 3;
  fake.mailbox.exists = 2;
  fake.omitFetchedMetadata = true;
  const reader = new ImapMailReader(() => fake as unknown as ImapFlow);

  const result = await reader.fetchAfter(config, {
    ownerId: config.ownerId,
    mailboxId: config.mailboxId,
    folder: config.folder,
    uidValidity: "10",
    lastUid: "1"
  }, 20);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "NETWORK");
  assert.equal(result.error.retryable, true);
});

test("incremental reader rejects a batch larger than the contract limit", async () => {
  const reader = new ImapMailReader(() => new FakeImapClient() as unknown as ImapFlow);
  const result = await reader.fetchAfter(config, {
    ownerId: config.ownerId,
    mailboxId: config.mailboxId,
    folder: config.folder,
    uidValidity: "10",
    lastUid: "1"
  }, 21);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_INPUT");
});
