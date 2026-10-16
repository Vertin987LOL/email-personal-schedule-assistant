import type { DatabaseSync } from "node:sqlite";
import express from "express";
import { requireAuth } from "../auth";
import { CalendarError, CalendarService } from "./service";

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
  const router = express.Router();

  router.use(requireAuth);

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
      res.json({ proposals: service.listProposals(state) });
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
