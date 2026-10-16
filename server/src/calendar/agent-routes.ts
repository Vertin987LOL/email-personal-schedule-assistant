import express from "express";
import { requireAuth } from "../auth";
import { CalendarError } from "./service";
import type { CalendarAgentRuntime } from "./agent-runtime";
import { CalendarTaskError } from "./agent-tasks";

function body(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new CalendarError("INVALID_INPUT", "invalid request fields");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 20_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new CalendarError("INVALID_INPUT", "text is required");
  return value;
}
function key(value: unknown) {
  const result = text(value, 100);
  if (!/^[\w-]+$/.test(result)) throw new CalendarError("INVALID_INPUT", "invalid operation key");
  return result;
}

export function createCalendarAgentRouter(runtime: CalendarAgentRuntime) {
  const router = express.Router();
  router.post("/agent-tools", (req, res, next) => {
    try {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) throw new CalendarError("FORBIDDEN", "local connection required", 403);
      const input = body(req.body, ["name", "args"]);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      res.json(runtime.invoke(token, text(input.name, 100), input.args));
    } catch (error) { next(error); }
  });
  router.use("/agent", requireAuth);
  router.get("/agent/status", (_req, res) => res.json(runtime.status));
  router.get("/agent/tasks", (_req, res) => res.json({ tasks: runtime.tasks.list(100) }));
  router.post("/agent/tasks", (req, res, next) => {
    try {
      const input = body(req.body, ["operationKey", "text"]);
      const sourceKey = `web:${key(input.operationKey)}`;
      const task = runtime.tasks.create({ sourceKey, sourceKind: "manual", sourceRef: sourceKey, text: text(input.text) });
      runtime.schedule();
      res.status(201).json({ task, runtime: runtime.status });
    } catch (error) { next(error); }
  });
  router.get("/agent/tasks/:id", (req, res, next) => {
    try {
      const task = runtime.tasks.get(String(req.params.id));
      if (!task) throw new CalendarError("NOT_FOUND", "task not found", 404);
      res.json({ task, proposals: runtime.proposals(task.id) });
    } catch (error) { next(error); }
  });
  router.post("/agent/tasks/:id/input", (req, res, next) => {
    try {
      const input = body(req.body, ["inputKey", "text"]);
      const task = runtime.tasks.addInput(String(req.params.id), { inputKey: key(input.inputKey), text: text(input.text) });
      if (!task) throw new CalendarError("NOT_FOUND", "task not found", 404);
      runtime.schedule();
      res.json({ task, runtime: runtime.status });
    } catch (error) { next(error); }
  });
  router.post("/agent/tasks/:id/cancel", async (req, res, next) => {
    try { res.json({ task: await runtime.cancel(String(req.params.id)) }); } catch (error) { next(error); }
  });
  router.post("/agent/tasks/:id/proposals/:proposalId/resolve", (req, res, next) => {
    try {
      const input = body(req.body, ["digest", "decision"]);
      if (input.decision !== "approve" && input.decision !== "reject") throw new CalendarError("INVALID_INPUT", "invalid decision");
      const result = runtime.resolve(String(req.params.id), String(req.params.proposalId), text(input.digest, 64), input.decision);
      res.json(result);
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof CalendarError ? error.status : error instanceof CalendarTaskError ? error.code === "NOT_FOUND" ? 404 : error.code.endsWith("CONFLICT") ? 409 : 400 : 500;
    res.status(status).json({ error: error instanceof CalendarError || error instanceof CalendarTaskError ? error.code : "STORAGE_FAILED" });
  });
  return router;
}
