import type { DatabaseSync } from "node:sqlite";
import express from "express";
import { requireAuth } from "../auth";
import { CalendarError, CalendarService } from "./service";
import { CourseCalendarService, type IcsImportOptions } from "./courses";
import { CalendarToolService, getProposalPolicy } from "./agent-tools";

export type CalendarRouterInput = DatabaseSync | CalendarService;

function bodyObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalendarError("INVALID_INPUT", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function stringQuery(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CalendarError("INVALID_TIME", `${field} is required`);
  }
  return value;
}

export function createCalendarRouter(input: CalendarRouterInput, ownerId = "local-owner") {
  const service = input instanceof CalendarService ? input : new CalendarService(input, ownerId);
  const courses = new CourseCalendarService(service);
  const tools = new CalendarToolService(service);
  const router = express.Router();

  router.use(requireAuth);

  router.get("/courses", (_req, res, next) => {
    try {
      res.json({ series: courses.listSeries(), exceptions: courses.listExceptions(), proposals: courses.listImportProposals() });
    } catch (error) { next(error); }
  });

  router.post("/courses/import", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      if (body.series !== undefined) {
        if (!Array.isArray(body.series) || body.ics !== undefined) throw new CalendarError("INVALID_INPUT", "provide series or ICS, not both");
        res.json(courses.importSeries(body.operationKey, body.series));
      } else {
        const options = bodyObject(body.options);
        res.json(courses.importIcs(body.operationKey, body.ics, options as IcsImportOptions));
      }
    } catch (error) { next(error); }
  });

  router.post("/courses/proposals/:id/resolve", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      res.json(courses.resolveImportProposal(String(req.params.id), body.decision, body.operationKey));
    } catch (error) { next(error); }
  });

  router.post("/courses/:id/occurrences/:date/exception", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      res.json(courses.setOccurrenceException(body.operationKey, String(req.params.id), String(req.params.date), body.change, body.expectedEventVersion));
    } catch (error) { next(error); }
  });

  router.get("/events", (req, res, next) => {
    try {
      const result = service.listEvents(
        stringQuery(req.query.from, "from"),
        stringQuery(req.query.to, "to")
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/events/:id", (req, res, next) => {
    try {
      res.json({ event: service.getEvent(String(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/events", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      const event = service.createEvent(body.operationKey, body.event);
      res.status(201).json({ event });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/events/:id", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      const event = service.updateEvent(
        String(req.params.id),
        body.expectedVersion,
        body.operationKey,
        body.patch
      );
      res.json({ event });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/events/:id", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      const event = service.cancelEvent(
        String(req.params.id),
        body.expectedVersion,
        body.operationKey
      );
      res.json({ event });
    } catch (error) {
      next(error);
    }
  });

  router.get("/candidates", (req, res, next) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state as never : undefined;
      res.json({ candidates: service.listCandidates(state) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/candidates", (req, res, next) => {
    try {
      res.status(201).json({ candidate: service.upsertCandidate(req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/candidates/:id/confirm", (req, res, next) => {
    try {
      const body = bodyObject(req.body);
      res.json(service.confirmCandidate(String(req.params.id), body.operationKey));
    } catch (error) {
      next(error);
    }
  });

  router.get("/proposals", (req, res, next) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state as never : undefined;
      const proposals = service.listProposals(state);
      const emailReviews = Object.fromEntries(proposals.flatMap(proposal => {
        const source = emailProposalSource(proposal.id);
        if (!source) return [];
        const target = proposal.targetId ? service.getEvent(proposal.targetId) : undefined;
        return [[proposal.id, { ...source, target }]];
      }));
      res.json({ proposals, emailReviews });
    } catch (error) {
      next(error);
    }
  });

  router.post("/proposals", (req, res, next) => {
    try {
      res.status(201).json({ proposal: service.createProposal(req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/proposals/:id/resolve", (req, res, next) => {
    try {
      if (getProposalPolicy(service, String(req.params.id))) throw new CalendarError("FORBIDDEN", "policy-backed proposals require their dedicated confirmation path", 403);
      const body = bodyObject(req.body);
      res.json(service.resolveProposal(
        String(req.params.id),
        body.decision,
        body.operationKey,
        body.expectedVersion
      ));
    } catch (error) {
      next(error);
    }
  });

  function emailProposalSource(proposalId: string) {
    const row = service.repository.db.prepare("SELECT taskId FROM calendar_tool_proposal_policies WHERE ownerId = ? AND proposalId = ?")
      .get(service.ownerId, proposalId) as { taskId: string } | undefined;
    if (!row) return undefined;
    const analyses = service.repository.db.prepare("SELECT data, fromAddress FROM calendar_email_analysis WHERE ownerId = ?")
      .all(service.ownerId) as Array<{ data: string; fromAddress: string | null }>;
    for (const { data, fromAddress } of analyses) {
      try {
        const analysis = JSON.parse(data) as { emailId: string; sourceKey: string; subject: string; activities?: Array<{ proposalId?: string }> };
        if (analysis.activities?.some(activity => activity.proposalId === proposalId)) {
          return { emailId: analysis.emailId, sourceKey: analysis.sourceKey, subject: analysis.subject, fromAddress };
        }
      } catch { /* A malformed historical analysis never grants a review action. */ }
    }
    return undefined;
  }

  router.post("/email-proposals/:id/resolve", (req, res, next) => {
    try {
      const proposalId = String(req.params.id);
      const body = bodyObject(req.body);
      if (body.decision !== "approve" && body.decision !== "reject") throw new CalendarError("INVALID_INPUT", "decision must be approve or reject");
      if (!emailProposalSource(proposalId)) throw new CalendarError("NOT_FOUND", "email proposal not found", 404);
      const policy = service.repository.db.prepare(`
        SELECT taskId, operationId, requireFree, targetId, expectedVersion
        FROM calendar_tool_proposal_policies WHERE ownerId = ? AND proposalId = ?
      `).get(service.ownerId, proposalId) as { taskId: string; operationId: string; requireFree: number; targetId: string; expectedVersion: number };
      const result = service.repository.withTransaction(() => {
        const proposal = service.repository.getProposal(service.ownerId, proposalId);
        if (!proposal || proposal.operationKey !== policy.operationId || proposal.targetId !== policy.targetId ||
            proposal.expectedVersion !== policy.expectedVersion || !["update", "cancel"].includes(proposal.action)) {
          throw new CalendarError("VERSION_CONFLICT", "email proposal policy does not match proposal", 409);
        }
        const target = service.getEvent(policy.targetId);
        if (target.kind === "course" || !target.sources.some(source => source.kind === "email")) {
          throw new CalendarError("FORBIDDEN", "email proposal cannot modify this event", 403);
        }
        if (proposal.state === "pending" && body.decision === "approve") {
          if (target.version !== policy.expectedVersion) throw new CalendarError("VERSION_CONFLICT", "target version changed", 409);
          if (policy.requireFree) {
            const check = tools.invoke("calendar.preview", {
              targetId: proposal.targetId, expectedVersion: proposal.expectedVersion, patch: proposal.patch, requireFree: true
            }, { taskId: policy.taskId, source: { kind: "email", ref: proposal.operationKey }, isActive: () => true });
            if (!check.ok) throw new CalendarError(check.error.code, check.error.message, 409, check.error.details);
          }
        }
        return service.resolveProposal(proposalId, body.decision, body.operationKey, body.expectedVersion);
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof CalendarError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      });
      return;
    }
    res.status(500).json({ error: "STORAGE_FAILED", message: "Calendar storage failed." });
  });

  return router;
}

export default createCalendarRouter;
