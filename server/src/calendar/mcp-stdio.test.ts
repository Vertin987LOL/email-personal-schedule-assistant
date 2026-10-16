import assert from "node:assert/strict";
import test from "node:test";
import { assertCalendarGatewayUrl, callCalendarGateway, CALENDAR_GATEWAY_URL_ENV, CALENDAR_CAPABILITY_TOKEN_ENV, CALENDAR_TOOL_ANNOTATIONS, CALENDAR_TOOL_NAMES, createCalendarMcpServer } from "./mcp-stdio";

const gatewayUrl = "http://127.0.0.1:8787/api/calendar/agent-tools";

test("calendar gateway accepts only the loopback agent-tools URL", () => {
  assert.equal(assertCalendarGatewayUrl(gatewayUrl), gatewayUrl);
  for (const value of [
    "http://localhost:8787/api/calendar/agent-tools",
    "https://127.0.0.1:8787/api/calendar/agent-tools",
    "http://127.0.0.1:8787/api/calendar/agent-tools/other",
    "http://127.0.0.1:8787/api/calendar/agent-tools?x=1",
  ]) assert.throws(() => assertCalendarGatewayUrl(value));
});

test("MCP forwarding preserves structured conflict results for the next model call", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const results = [
    { ok: false, error: { code: "TIME_CONFLICT", recovery: "replan", message: "busy", details: { suggestion: { tool: "calendar.find_slots" } } } },
    { ok: true, data: [{ startsAt: "2026-10-16T10:00:00Z", endsAt: "2026-10-16T11:00:00Z" }] },
  ];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(results.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = { gatewayUrl, capabilityToken: "capability-token", fetchImpl };
  const conflict = await callCalendarGateway("calendar.preview", { event: {
    title: "study", kind: "activity", time: { kind: "interval", startsAt: "2026-10-16T10:00:00Z", endsAt: "2026-10-16T11:00:00Z", timeZone: "Asia/Shanghai" },
  } }, config);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "TIME_CONFLICT");
  const slots = await callCalendarGateway("calendar.find_slots", {
    from: "2026-10-16T00:00:00Z", to: "2026-10-17T00:00:00Z", durationMinutes: 60, timeZone: "Asia/Shanghai",
  }, config);
  assert.equal(slots.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, gatewayUrl);
  assert.equal((requests[0].init?.headers as Record<string, string>).authorization, "Bearer capability-token");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    name: "calendar.preview",
    args: { event: { title: "study", kind: "activity", time: { kind: "interval", startsAt: "2026-10-16T10:00:00Z", endsAt: "2026-10-16T11:00:00Z", timeZone: "Asia/Shanghai" } } },
  });
});

test("MCP rejects unknown fields and the native interaction tool", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
  const config = { gatewayUrl, capabilityToken: "capability-token", fetchImpl };
  const invalid = await callCalendarGateway("calendar.list", { from: "a", to: "b", ownerId: "not allowed" }, config);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_INPUT");
  const interaction = await callCalendarGateway("request_user_input", {}, config);
  assert.equal(interaction.ok, false);
  assert.equal(interaction.error.code, "UNSUPPORTED_INTERACTION");
  assert.equal(calls, 0);
});

test("MCP entrypoint names are environment-only configuration", () => {
  assert.equal(CALENDAR_GATEWAY_URL_ENV, "CALENDAR_GATEWAY_URL");
  assert.equal(CALENDAR_CAPABILITY_TOKEN_ENV, "CALENDAR_CAPABILITY_TOKEN");
});

test("MCP registers the seven calendar tools with truthful annotations", () => {
  const server = createCalendarMcpServer({ gatewayUrl, capabilityToken: "capability-token" });
  const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: unknown }> })._registeredTools;
  assert.deepEqual(Object.keys(tools), [...CALENDAR_TOOL_NAMES]);
  assert.deepEqual(tools["calendar.list"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.list"]);
  assert.deepEqual(tools["calendar.get"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.get"]);
  assert.deepEqual(tools["calendar.find_slots"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.find_slots"]);
  assert.deepEqual(tools["calendar.preview"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.preview"]);
  assert.deepEqual(tools["calendar.propose"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.propose"]);
  assert.deepEqual(tools["calendar.get_operation"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.get_operation"]);
  assert.deepEqual(tools["calendar.request_input"].annotations, CALENDAR_TOOL_ANNOTATIONS["calendar.request_input"]);
});
