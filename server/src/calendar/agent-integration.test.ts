import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { CalendarService } from "./service";
import { CalendarAgentRuntime } from "./agent-runtime";
import { createCalendarAgentRouter } from "./agent-routes";

test("real stdio MCP adapter reaches the scoped HTTP gateway and returns a conflict before a second tool call", { timeout: 20_000 }, async () => {
  const calendar = new CalendarService(new DatabaseSync(":memory:"));
  calendar.createEvent("fixture-course", { title: "线性代数", kind: "course", status: "confirmed", sources: [{ kind: "course", ref: "fixture" }],
    time: { kind: "interval", startsAt: "2026-10-20T15:00:00+08:00", endsAt: "2026-10-20T16:30:00+08:00", timeZone: "Asia/Shanghai" } });
  let baseUrl = "";
  const runtime = new CalendarAgentRuntime(calendar, input => ({
    async run(params) {
      await params.onThread?.("test-thread"); await params.onTurn?.("test-turn");
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("server/src/calendar/mcp-stdio.ts")], {
        cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CALENDAR_GATEWAY_URL: `${baseUrl}/api/calendar/agent-tools`, CALENDAR_CAPABILITY_TOKEN: input.capabilityToken }
      });
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let sequence = 0, buffer = "";
      child.stdout.setEncoding("utf8"); child.stderr.on("data", () => {});
      child.stdout.on("data", chunk => {
        buffer += chunk;
        for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const response = JSON.parse(line);
          const item = pending.get(response.id);
          if (item) { pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(new Error("MCP request failed")) : item.resolve(response.result); }
        }
      });
      const rpc = (method: string, args: unknown) => new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP response timeout")); }, 7000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: args }) + "\n");
      });
      try {
        const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "calendar-integration-test", version: "1" } });
        assert.ok(initialized.protocolVersion);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listed = await rpc("tools/list", {});
        assert.equal(listed.tools.length, 7);
        assert.ok(listed.tools.every((tool: { name: string }) => tool.name.startsWith("calendar.") && !tool.name.includes("approve")));
        const checked = await rpc("tools/call", { name: "calendar.preview", arguments: { requireFree: true, event: {
          title: "科研讲座", kind: "activity", time: { kind: "interval", startsAt: "2026-10-20T14:00:00+08:00", endsAt: "2026-10-20T16:00:00+08:00", timeZone: "Asia/Shanghai" }
        } } });
        assert.equal(checked.isError, true);
        const conflict = JSON.parse(checked.content[0].text);
        assert.equal(conflict.error.code, "TIME_CONFLICT");
        assert.equal(conflict.error.details.overlaps[0].overlapMinutes, 60);
        const slots = await rpc("tools/call", { name: "calendar.find_slots", arguments: {
          from: "2026-10-20T14:00:00+08:00", to: "2026-10-20T20:00:00+08:00", durationMinutes: 120, timeZone: "Asia/Shanghai"
        } });
        const free = JSON.parse(slots.content[0].text);
        assert.equal(free.ok, true);
        assert.equal(Date.parse(free.data[0].startsAt), Date.parse("2026-10-20T16:30:00+08:00"));
        return { threadId: "test-thread", turnId: "test-turn", status: "completed", text: "虚构样本已核对" };
      } finally {
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("test closed")); }
        child.stdin.end(); child.kill();
      }
    }, cancel() {}, close() {}
  }));
  const app = express(); app.use(express.json()); app.use("/api/calendar", createCalendarAgentRouter(runtime));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/api/calendar/agent/tasks`)).status, 401);
    const unauthorized = await fetch(`${baseUrl}/api/calendar/agent-tools`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"a".repeat(43)}` }, body: JSON.stringify({ name: "calendar.list", args: {} }) });
    assert.equal((await unauthorized.json()).error.code, "FORBIDDEN");
    const task = runtime.tasks.create({ sourceKey: "stdio-integration", sourceKind: "manual", text: "检查讲座冲突，再找两小时空档" });
    await runtime.drain();
    assert.equal(runtime.tasks.get(task.id)?.state, "succeeded");
    assert.equal(calendar.listProposals().length, 0);
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); calendar.repository.db.close();
  }
});
