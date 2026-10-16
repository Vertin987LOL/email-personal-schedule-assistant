import type { DatabaseSync } from "node:sqlite";

export type CalendarEventKind = "course" | "activity" | "deadline" | "time_block";
export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled" | "ignored";
export type CalendarSourceKind = "manual" | "course" | "email" | "plan";

export type CalendarSource = {
  kind: CalendarSourceKind;
  ref: string;
};

/** Contract alias used by calendar consumers. */
export type Source = CalendarSource;

export type CalendarTime =
  | { kind: "interval"; startsAt: string; endsAt: string; timeZone: string }
  | { kind: "point"; at: string; timeZone: string }
  | { kind: "date"; onDate: string; timeZone: string };

export type CalendarReminder = {
  enabled: boolean;
  minutesBefore?: number;
  at?: string;
};

export type CalendarEvent = {
  id: string;
  ownerId: string;
  title: string;
  kind: CalendarEventKind;
  time: CalendarTime;
  location?: string;
  status: CalendarEventStatus;
  sources: CalendarSource[];
  sourceEvidence?: string;
  seriesId?: string;
  reminder?: CalendarReminder;
  version: number;
};

export type CalendarEventInput = Omit<CalendarEvent, "id" | "ownerId" | "version">;
export type EventPatch = Partial<Pick<CalendarEvent, "title" | "time" | "location" | "status" | "reminder">>;

export type CalendarConflict = {
  eventId: string;
  otherEventId: string;
  reason: "overlap";
};

export type CalendarCandidateState = "needs_details" | "ready" | "ignored" | "confirmed";

export type EventCandidate = {
  id: string;
  ownerId: string;
  source: CalendarSource;
  title: string;
  kind?: CalendarEventKind;
  time?: CalendarTime;
  location?: string;
  evidence: string;
  state: CalendarCandidateState;
  linkedEventId?: string;
  missing: string[];
};

export type ChangeProposalAction = "create" | "update" | "cancel" | "match" | "plan";
export type ChangeProposalState = "pending" | "applied" | "rejected" | "stale";

export type ChangeProposal = {
  id: string;
  ownerId: string;
  operationKey: string;
  action: ChangeProposalAction;
  targetId?: string;
  expectedVersion?: number;
  candidateId?: string;
  patch?: EventPatch;
  event?: CalendarEventInput;
  evidence: string;
  state: ChangeProposalState;
  resultEventId?: string;
};

export type CalendarProposalInput = {
  operationKey: string;
  action: ChangeProposalAction;
  targetId?: string;
  expectedVersion?: number;
  candidateId?: string;
  patch?: EventPatch;
  event?: CalendarEventInput;
  evidence: string;
};

export type CalendarResolveDecision = "approve" | "reject";

export type CalendarListResult = {
  events: CalendarEvent[];
  conflicts: CalendarConflict[];
};

export type CalendarProposalResult = {
  proposal: ChangeProposal;
  event?: CalendarEvent;
};

export type CalendarDatabase = DatabaseSync;

export type CalendarReminderInvalidation = {
  eventId: string;
  previousVersion: number;
  currentVersion: number;
  reason: "updated" | "cancelled";
};

export type CalendarServiceHooks = {
  /** Future reminder worker hook; called only after the event transaction commits. */
  onReminderInvalidated?: (change: CalendarReminderInvalidation) => void;
};
