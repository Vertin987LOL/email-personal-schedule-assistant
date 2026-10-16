import type { DatabaseSync } from "node:sqlite";
import type {
  CalendarEvent,
  CalendarEventStatus,
  ChangeProposal,
  EventCandidate
} from "./types";

type SqlRow = Record<string, unknown>;

export type StoredOperation = {
  ownerId: string;
  operationKey: string;
  operationType: string;
  payloadHash: string;
  resultJson: string;
  resultId?: string;
};

export class CalendarRepository {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        timeKind TEXT NOT NULL,
        startsAt TEXT,
        endsAt TEXT,
        at TEXT,
        onDate TEXT,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, id)
      );
      CREATE INDEX IF NOT EXISTS calendar_events_owner_time
        ON calendar_events (ownerId, startsAt, onDate, at);

      CREATE TABLE IF NOT EXISTS calendar_operations (
        ownerId TEXT NOT NULL,
        operationKey TEXT NOT NULL,
        operationType TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        resultJson TEXT NOT NULL,
        resultId TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, operationKey)
      );

      CREATE TABLE IF NOT EXISTS calendar_candidates (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        state TEXT NOT NULL,
        linkedEventId TEXT,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, id)
      );

      CREATE TABLE IF NOT EXISTS calendar_proposals (
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        operationKey TEXT NOT NULL,
        action TEXT NOT NULL,
        targetId TEXT,
        expectedVersion INTEGER,
        candidateId TEXT,
        patchJson TEXT,
        eventJson TEXT,
        evidence TEXT NOT NULL,
        state TEXT NOT NULL,
        resultEventId TEXT,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (ownerId, id),
        UNIQUE (ownerId, operationKey)
      );
      CREATE INDEX IF NOT EXISTS calendar_proposals_owner_state
        ON calendar_proposals (ownerId, state, createdAt);
    `);
  }

  withTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Keep the original failure; rollback is best effort after SQLite errors.
      }
      throw error;
    }
  }

  getEvent(ownerId: string, id: string): CalendarEvent | undefined {
    const row = this.db.prepare(
      "SELECT data FROM calendar_events WHERE ownerId = ? AND id = ?"
    ).get(ownerId, id) as SqlRow | undefined;
    return row ? JSON.parse(String(row.data)) as CalendarEvent : undefined;
  }

  listEvents(ownerId: string): CalendarEvent[] {
    const rows = this.db.prepare(
      "SELECT data FROM calendar_events WHERE ownerId = ? ORDER BY COALESCE(startsAt, onDate, at), id"
    ).all(ownerId) as SqlRow[];
    return rows.map((row) => JSON.parse(String(row.data)) as CalendarEvent);
  }

  insertEvent(event: CalendarEvent, now: string) {
    const time = event.time;
    this.db.prepare(`
      INSERT INTO calendar_events
        (ownerId, id, version, status, timeKind, startsAt, endsAt, at, onDate, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.ownerId,
      event.id,
      event.version,
      event.status,
      time.kind,
      time.kind === "interval" ? time.startsAt : null,
      time.kind === "interval" ? time.endsAt : null,
      time.kind === "point" ? time.at : null,
      time.kind === "date" ? time.onDate : null,
      JSON.stringify(event),
      now,
      now
    );
  }

  updateEvent(event: CalendarEvent, now: string) {
    const time = event.time;
    this.db.prepare(`
      UPDATE calendar_events
      SET version = ?, status = ?, timeKind = ?, startsAt = ?, endsAt = ?, at = ?, onDate = ?, data = ?, updatedAt = ?
      WHERE ownerId = ? AND id = ?
    `).run(
      event.version,
      event.status,
      time.kind,
      time.kind === "interval" ? time.startsAt : null,
      time.kind === "interval" ? time.endsAt : null,
      time.kind === "point" ? time.at : null,
      time.kind === "date" ? time.onDate : null,
      JSON.stringify(event),
      now,
      event.ownerId,
      event.id
    );
  }

  getOperation(ownerId: string, operationKey: string): StoredOperation | undefined {
    const row = this.db.prepare(`
      SELECT ownerId, operationKey, operationType, payloadHash, resultJson, resultId
      FROM calendar_operations WHERE ownerId = ? AND operationKey = ?
    `).get(ownerId, operationKey) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      ownerId: String(row.ownerId),
      operationKey: String(row.operationKey),
      operationType: String(row.operationType),
      payloadHash: String(row.payloadHash),
      resultJson: String(row.resultJson),
      resultId: row.resultId == null ? undefined : String(row.resultId)
    };
  }

  putOperation(operation: StoredOperation, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_operations
        (ownerId, operationKey, operationType, payloadHash, resultJson, resultId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.ownerId,
      operation.operationKey,
      operation.operationType,
      operation.payloadHash,
      operation.resultJson,
      operation.resultId ?? null,
      now
    );
  }

  getCandidate(ownerId: string, id: string): EventCandidate | undefined {
    const row = this.db.prepare(
      "SELECT data FROM calendar_candidates WHERE ownerId = ? AND id = ?"
    ).get(ownerId, id) as SqlRow | undefined;
    return row ? JSON.parse(String(row.data)) as EventCandidate : undefined;
  }

  listCandidates(ownerId: string, state?: EventCandidate["state"]): EventCandidate[] {
    const rows = state
      ? this.db.prepare(
        "SELECT data FROM calendar_candidates WHERE ownerId = ? AND state = ? ORDER BY updatedAt DESC, id"
      ).all(ownerId, state) as SqlRow[]
      : this.db.prepare(
        "SELECT data FROM calendar_candidates WHERE ownerId = ? ORDER BY updatedAt DESC, id"
      ).all(ownerId) as SqlRow[];
    return rows.map((row) => JSON.parse(String(row.data)) as EventCandidate);
  }

  saveCandidate(candidate: EventCandidate, now: string) {
    this.db.prepare(`
      INSERT INTO calendar_candidates (ownerId, id, state, linkedEventId, data, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, id) DO UPDATE SET
        state = excluded.state,
        linkedEventId = excluded.linkedEventId,
        data = excluded.data,
        updatedAt = excluded.updatedAt
    `).run(
      candidate.ownerId,
      candidate.id,
      candidate.state,
      candidate.linkedEventId ?? null,
      JSON.stringify(candidate),
      now
    );
  }

  getProposal(ownerId: string, id: string): ChangeProposal | undefined {
    const row = this.db.prepare(
      "SELECT data FROM calendar_proposals WHERE ownerId = ? AND id = ?"
    ).get(ownerId, id) as SqlRow | undefined;
    return row ? JSON.parse(String(row.data)) as ChangeProposal : undefined;
  }

  getProposalByOperation(ownerId: string, operationKey: string): ChangeProposal | undefined {
    const row = this.db.prepare(
      "SELECT data FROM calendar_proposals WHERE ownerId = ? AND operationKey = ?"
    ).get(ownerId, operationKey) as SqlRow | undefined;
    return row ? JSON.parse(String(row.data)) as ChangeProposal : undefined;
  }

  listProposals(ownerId: string, state?: ChangeProposal["state"]): ChangeProposal[] {
    const rows = state
      ? this.db.prepare(
        "SELECT data FROM calendar_proposals WHERE ownerId = ? AND state = ? ORDER BY createdAt DESC, id"
      ).all(ownerId, state) as SqlRow[]
      : this.db.prepare(
        "SELECT data FROM calendar_proposals WHERE ownerId = ? ORDER BY createdAt DESC, id"
      ).all(ownerId) as SqlRow[];
    return rows.map((row) => JSON.parse(String(row.data)) as ChangeProposal);
  }

  saveProposal(proposal: ChangeProposal, now: string) {
    const patchJson = proposal.patch == null ? null : JSON.stringify(proposal.patch);
    const eventJson = proposal.event == null ? null : JSON.stringify(proposal.event);
    this.db.prepare(`
      INSERT INTO calendar_proposals
        (ownerId, id, operationKey, action, targetId, expectedVersion, candidateId, patchJson, eventJson,
         evidence, state, resultEventId, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ownerId, id) DO UPDATE SET
        state = excluded.state,
        resultEventId = excluded.resultEventId,
        data = excluded.data,
        updatedAt = excluded.updatedAt
    `).run(
      proposal.ownerId,
      proposal.id,
      proposal.operationKey,
      proposal.action,
      proposal.targetId ?? null,
      proposal.expectedVersion ?? null,
      proposal.candidateId ?? null,
      patchJson,
      eventJson,
      proposal.evidence,
      proposal.state,
      proposal.resultEventId ?? null,
      JSON.stringify(proposal),
      now,
      now
    );
  }

  static statusOf(event: CalendarEvent): CalendarEventStatus {
    return event.status;
  }
}
