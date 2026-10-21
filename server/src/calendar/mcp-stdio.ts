import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

export const CALENDAR_GATEWAY_URL_ENV = "CALENDAR_GATEWAY_URL";
export const CALENDAR_CAPABILITY_TOKEN_ENV = "CALENDAR_CAPABILITY_TOKEN";
export const CALENDAR_TOOL_NAMES = [
  "calendar.list",
  "calendar.get",
  "calendar.find_slots",
  "calendar.preview",
  "calendar.propose",
  "calendar.get_operation",
  "calendar.request_input",
  "mail.list_recent",
  "mail.search",
] as const;

export type CalendarToolName = (typeof CALENDAR_TOOL_NAMES)[number];
export type CalendarToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};
export const CALENDAR_TOOL_ANNOTATIONS: Record<CalendarToolName, CalendarToolAnnotations> = {
  "calendar.list": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "calendar.get": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "calendar.find_slots": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "calendar.preview": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "calendar.propose": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  "calendar.get_operation": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "calendar.request_input": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  "mail.list_recent": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "mail.search": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export type CalendarMcpConfig = {
  gatewayUrl?: string;
  capabilityToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ToolResult = { ok: true; data?: unknown } | {
  ok: false;
  error: { code: string; message: string; recovery?: string; details?: unknown };
};

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const timeSchema = z.discriminatedUnion("kind", [
  strictObject({ kind: z.literal("interval"), startsAt: z.string(), endsAt: z.string(), timeZone: z.string() }),
  strictObject({ kind: z.literal("point"), at: z.string(), timeZone: z.string() }),
  strictObject({ kind: z.literal("date"), onDate: z.string(), timeZone: z.string() }),
]);
const reminderSchema = strictObject({
  enabled: z.boolean(),
  minutesBefore: z.number().int().nonnegative().optional(),
  at: z.string().optional(),
});
const eventSchema = strictObject({
  title: z.string(),
  // Courses are imported by the calendar service; the model may propose only personal entries.
  kind: z.enum(["activity", "deadline", "time_block"]),
  time: timeSchema,
  location: z.string().optional(),
  status: z.enum(["confirmed", "tentative", "cancelled", "ignored"]).optional(),
  reminder: reminderSchema.optional(),
});
const patchSchema = strictObject({
  title: z.string().optional(),
  time: timeSchema.optional(),
  location: z.string().nullable().optional(),
  status: z.enum(["confirmed", "tentative", "cancelled", "ignored"]).optional(),
  reminder: reminderSchema.optional(),
});

/** The schemas are deliberately closed: the model cannot smuggle host fields through an MCP call. */
export const CALENDAR_TOOL_SCHEMAS = {
  "calendar.list": strictObject({ from: z.string(), to: z.string() }),
  "calendar.get": strictObject({ eventId: z.string() }),
  "calendar.find_slots": strictObject({
    from: z.string(),
    to: z.string(),
    durationMinutes: z.number().int().positive(),
    timeZone: z.string(),
    dayStart: z.string().optional(),
    dayEnd: z.string().optional(),
    limit: z.number().int().positive().max(10).optional(),
  }),
  "calendar.preview": strictObject({
    event: eventSchema.optional(),
    targetId: z.string().optional(),
    patch: patchSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
    requireFree: z.boolean().optional(),
  }),
  "calendar.propose": strictObject({
    action: z.enum(["create", "update", "cancel"]),
    event: eventSchema.optional(),
    targetId: z.string().optional(),
    expectedVersion: z.number().int().positive().optional(),
    patch: patchSchema.optional(),
    evidence: z.string(),
    requireFree: z.boolean().optional(),
  }),
  "calendar.get_operation": strictObject({ operationId: z.string() }),
  "calendar.request_input": strictObject({
    question: z.string(),
    missing: z.array(z.string()).min(1).max(32),
  }),
  "mail.list_recent": strictObject({
    limit: z.number().int().positive().max(15).optional(),
    category: z.enum(["all", "important", "secondary"]).optional(),
  }),
  "mail.search": strictObject({
    query: z.string().min(1).max(500),
    limit: z.number().int().positive().max(15).optional(),
  }),
} as const;

function structuredError(code: string, message: string, recovery = "stop"): ToolResult {
  return { ok: false, error: { code, message, recovery } };
}

export function assertCalendarGatewayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("calendar gateway URL is invalid"); }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535 ||
      url.pathname !== "/api/calendar/agent-tools" || url.search || url.hash || url.username || url.password) {
    throw new Error("calendar gateway must be http://127.0.0.1:<port>/api/calendar/agent-tools");
  }
  return url.toString();
}

function configFromEnvironment(config: CalendarMcpConfig): Required<Pick<CalendarMcpConfig, "gatewayUrl" | "capabilityToken" | "fetchImpl" | "timeoutMs">> {
  const gatewayUrl = assertCalendarGatewayUrl(config.gatewayUrl ?? process.env[CALENDAR_GATEWAY_URL_ENV] ?? "");
  const capabilityToken = config.capabilityToken ?? process.env[CALENDAR_CAPABILITY_TOKEN_ENV] ?? "";
  if (!capabilityToken || capabilityToken.length > 512 || /[\r\n]/.test(capabilityToken)) throw new Error("calendar capability token is missing");
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("calendar gateway timeout is invalid");
  return { gatewayUrl, capabilityToken, fetchImpl: config.fetchImpl ?? fetch, timeoutMs };
}

function jsonText(value: unknown) {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ ok: false, error: { code: "INVALID_RESULT", message: "gateway returned an unserializable result" } }); }
}

export async function callCalendarGateway(name: string, args: unknown, config: CalendarMcpConfig = {}): Promise<ToolResult> {
  if (name === "request_user_input") return structuredError("UNSUPPORTED_INTERACTION", "call calendar.request_input instead", "ask_user");
  if (!(CALENDAR_TOOL_NAMES as readonly string[]).includes(name)) return structuredError("UNKNOWN_TOOL", `unknown calendar tool: ${name}`);
  const parsed = CALENDAR_TOOL_SCHEMAS[name as CalendarToolName].safeParse(args);
  if (!parsed.success) return structuredError("INVALID_INPUT", "calendar tool arguments are invalid", "ask_user");
  const resolved = configFromEnvironment(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const response = await resolved.fetchImpl(resolved.gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resolved.capabilityToken}` },
      body: JSON.stringify({ name, args: parsed.data }),
      signal: controller.signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { return structuredError("GATEWAY_INVALID_RESPONSE", "calendar gateway returned invalid JSON", "retry"); }
    if (!response.ok) return structuredError("GATEWAY_HTTP_ERROR", `calendar gateway returned HTTP ${response.status}`, "retry");
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { ok?: unknown }).ok !== "boolean") {
      return structuredError("GATEWAY_INVALID_RESPONSE", "calendar gateway returned an invalid result", "retry");
    }
    return body as ToolResult;
  } catch (error) {
    return structuredError(error instanceof DOMException && error.name === "AbortError" ? "GATEWAY_TIMEOUT" : "GATEWAY_UNAVAILABLE",
      error instanceof DOMException && error.name === "AbortError" ? "calendar gateway timed out" : "calendar gateway is unavailable", "retry");
  } finally { clearTimeout(timer); }
}

function registerCalendarTools(server: McpServer, config: CalendarMcpConfig) {
  const descriptions: Record<CalendarToolName, string> = {
    "calendar.list": "List calendar entries in a bounded time range.",
    "calendar.get": "Read one calendar event.",
    "calendar.find_slots": "Find free calendar slots.",
    "calendar.preview": "Check a calendar candidate before proposing it.",
    "calendar.propose": "Save a calendar change proposal for host confirmation.",
    "calendar.get_operation": "Read a prior calendar operation result.",
    "calendar.request_input": "Pause and ask the person for missing calendar information.",
    "mail.list_recent": "List recent processed emails with summaries and action items.",
    "mail.search": "Search processed emails using keyword full-text search.",
  };
  type McpResponse = { content: [{ type: "text"; text: string }]; isError?: boolean };
  type RegisterTool = (name: string, options: { description: string; inputSchema: z.ZodType; annotations: CalendarToolAnnotations }, callback: (args: Record<string, unknown>) => Promise<McpResponse>) => unknown;
  // The SDK overload preserves each schema's inferred object type. The loop is intentionally heterogeneous,
  // so this local erased view is used only at the registration boundary; runtime validation remains in zod.
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  for (const name of CALENDAR_TOOL_NAMES) {
    registerTool(name, { description: descriptions[name], inputSchema: CALENDAR_TOOL_SCHEMAS[name], annotations: CALENDAR_TOOL_ANNOTATIONS[name] }, async (args) => {
      const result = await callCalendarGateway(name, args, config);
      return { content: [{ type: "text", text: jsonText(result) }], ...(result.ok ? {} : { isError: true }) };
    });
  }
}

export function createCalendarMcpServer(config: CalendarMcpConfig = {}) {
  // Resolve configuration before exposing a server, so a missing token cannot yield a half-working process.
  const resolved = configFromEnvironment(config);
  const server = new McpServer({ name: "calendar", version: "0.1.0" });
  registerCalendarTools(server, resolved);
  return server;
}

export function serveCalendarMcpStdio(config: CalendarMcpConfig = {}): StdioServerHandle {
  return serveStdio(() => createCalendarMcpServer(config), {
    onerror: () => { process.stderr.write("calendar MCP server error\n"); },
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  try { serveCalendarMcpStdio(); }
  catch { process.stderr.write("calendar MCP server failed to start\n"); process.exitCode = 1; }
}
