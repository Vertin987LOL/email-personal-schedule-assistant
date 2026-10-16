import type { FetchMessageObject, ImapFlow } from "imapflow";
import { createImapClient } from "./imap";

export const MAX_MAIL_BATCH = 20;
export const MAX_RAW_MAIL_BYTES = 10 * 1024 * 1024;

export type MailboxConfig = {
  ownerId: string;
  mailboxId: string;
  folder: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export type MailKey = {
  ownerId: string;
  mailboxId: string;
  folder: string;
  uidValidity: string;
  uid: string;
};

export type Cursor = {
  ownerId: string;
  mailboxId: string;
  folder: string;
  uidValidity: string;
  lastUid: string;
};

export type RawMail = {
  key: MailKey;
  receivedAt: string;
  rawBytes?: Uint8Array;
  oversized: boolean;
  sizeBytes: number;
};

export type MailReaderErrorCode = "AUTH" | "PERMISSION" | "NETWORK" | "TIMEOUT" | "INVALID_INPUT" | "CONFIG" | "STORAGE";

export type MailReaderError = {
  code: MailReaderErrorCode;
  retryable: boolean;
  message: string;
};

export type MailReaderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MailReaderError };

export interface MailReader {
  probe(config: MailboxConfig): Promise<MailReaderResult<{ uidValidity: string; highestUid: string }>>;
  fetchAfter(
    config: MailboxConfig,
    cursor: Cursor,
    limit: number
  ): Promise<MailReaderResult<{ items: RawMail[]; nextCursor: Cursor }>>;
}

type ImapClientFactory = (config: MailboxConfig) => ImapFlow;

function errorFor(error: unknown, fallback = "IMAP 读取失败"): MailReaderError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("auth") || normalized.includes("login") || normalized.includes("credential")) {
    return { code: "AUTH", retryable: false, message: "邮箱认证失败" };
  }
  if (normalized.includes("permission") || normalized.includes("denied") || normalized.includes("not allowed")) {
    return { code: "PERMISSION", retryable: false, message: "邮箱没有读取权限" };
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return { code: "TIMEOUT", retryable: true, message: "邮箱读取超时" };
  }
  return { code: "NETWORK", retryable: true, message: fallback };
}

function ok<T>(value: T): MailReaderResult<T> {
  return { ok: true, value };
}

function fail<T>(error: MailReaderError): MailReaderResult<T> {
  return { ok: false, error };
}

function configError(message: string): MailReaderResult<never> {
  return fail({ code: "INVALID_INPUT", retryable: false, message });
}

function isValidLimit(limit: number) {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_MAIL_BATCH;
}

function parseUid(value: string) {
  if (!/^\d+$/.test(value)) return undefined;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : undefined;
}

function uidValidityOf(value: unknown) {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return String(value);
  return "";
}

function isoDate(value: Date | string | undefined) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function uniqueAscending(values: number[]) {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))].sort((left, right) => left - right);
}

async function withMailbox<T>(
  factory: ImapClientFactory,
  config: MailboxConfig,
  action: (client: ImapFlow) => Promise<T | MailReaderResult<T>>
): Promise<MailReaderResult<T>> {
  const client = factory(config);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const lock = await client.getMailboxLock(config.folder || "INBOX", {
      acquireTimeout: 15_000,
      readOnly: true,
      description: "mail-reader"
    });
    try {
      const value = await action(client);
      if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
        return value as MailReaderResult<T>;
      }
      return ok(value as T);
    } finally {
      lock.release();
    }
  } catch (error) {
    return fail(errorFor(error));
  } finally {
    if (connected) await client.logout().catch(() => undefined);
  }
}

function currentMailbox(client: ImapFlow) {
  return client.mailbox || undefined;
}

export class ImapMailReader implements MailReader {
  constructor(private readonly factory: ImapClientFactory = (config) => createImapClient(config)) {}

  async probe(config: MailboxConfig) {
    if (!config.ownerId || !config.mailboxId || !config.folder) return configError("收信器配置缺少归属或文件夹");

    return withMailbox(this.factory, config, async (client) => {
      const mailbox = currentMailbox(client);
      const uidValidity = uidValidityOf(mailbox?.uidValidity);
      if (!uidValidity) throw new Error("邮箱没有返回 UIDVALIDITY");
      const searched = await client.search({ all: true }, { uid: true });
      const uids = Array.isArray(searched) ? uniqueAscending(searched) : [];
      const predictedHighest = Math.max(0, Number(mailbox?.uidNext ?? 1) - 1);
      return {
        uidValidity,
        highestUid: String(Math.max(predictedHighest, uids.at(-1) ?? 0))
      };
    });
  }

  async fetchAfter(config: MailboxConfig, cursor: Cursor, limit: number) {
    if (!isValidLimit(limit)) return configError(`每批邮件数量必须是 1 到 ${MAX_MAIL_BATCH}`);
    if (
      cursor.ownerId !== config.ownerId ||
      cursor.mailboxId !== config.mailboxId ||
      cursor.folder !== config.folder
    ) {
      return configError("游标与当前邮箱不匹配");
    }
    const lastUid = parseUid(cursor.lastUid);
    if (lastUid === undefined) return configError("游标 UID 无效");

    return withMailbox(this.factory, config, async (client) => {
      const mailbox = currentMailbox(client);
      const uidValidity = uidValidityOf(mailbox?.uidValidity);
      if (!uidValidity) throw new Error("邮箱没有返回 UIDVALIDITY");
      if (uidValidity !== cursor.uidValidity) {
        return fail<{ items: RawMail[]; nextCursor: Cursor }>({
          code: "CONFIG",
          retryable: false,
          message: "邮箱 UIDVALIDITY 已变化，请重新建立基线"
        });
      }

      const searched = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      const uids = uniqueAscending(Array.isArray(searched) ? searched : []).filter((uid) => uid > lastUid).slice(0, limit);
      if (!uids.length) return ok({ items: [], nextCursor: cursor });

      const metadata = new Map<number, FetchMessageObject>();
      for await (const message of client.fetch(uids, { uid: true, size: true, internalDate: true }, { uid: true })) {
        metadata.set(message.uid, message);
      }

      const items: RawMail[] = [];
      for (const uid of uids) {
        const message = metadata.get(uid);
        // A partial FETCH must never move the cursor past an unarchived UID.
        // If the message was deleted concurrently, the next SEARCH omits it.
        if (!message) throw new Error(`邮件 UID ${uid} 的元信息读取失败`);
        const sizeBytes = Number(message.size ?? 0);
        const key = {
          ownerId: config.ownerId,
          mailboxId: config.mailboxId,
          folder: config.folder,
          uidValidity,
          uid: String(uid)
        };
        if (sizeBytes > MAX_RAW_MAIL_BYTES) {
          items.push({ key, receivedAt: isoDate(message.internalDate), oversized: true, sizeBytes });
          continue;
        }

        const full = await client.fetchOne(String(uid), {
          uid: true,
          source: { maxLength: MAX_RAW_MAIL_BYTES + 1 },
          size: true,
          internalDate: true
        }, { uid: true });
        if (full === false || !full.source) throw new Error(`邮件 UID ${uid} 的原文读取失败`);
        const rawBytes = new Uint8Array(full.source);
        if (sizeBytes > MAX_RAW_MAIL_BYTES || rawBytes.byteLength > MAX_RAW_MAIL_BYTES) {
          items.push({
            key,
            receivedAt: isoDate(full.internalDate ?? message.internalDate),
            oversized: true,
            sizeBytes: Math.max(sizeBytes, rawBytes.byteLength)
          });
          continue;
        }
        items.push({
          key,
          receivedAt: isoDate(full.internalDate ?? message.internalDate),
          rawBytes,
          oversized: false,
          sizeBytes: Math.max(sizeBytes, rawBytes.byteLength)
        });
      }

      return ok({
        items,
        nextCursor: {
          ...cursor,
          uidValidity,
          lastUid: String(uids.at(-1))
        }
      });
    });
  }
}

export function baselineCursor(config: MailboxConfig, probe: { uidValidity: string; highestUid: string }): Cursor {
  return {
    ownerId: config.ownerId,
    mailboxId: config.mailboxId,
    folder: config.folder,
    uidValidity: probe.uidValidity,
    lastUid: probe.highestUid
  };
}
