import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexConfig, CodexHost, type CodexHostConfig } from "./codex-host";

class FakeStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding) { /* no-op */ }
}

class FakeProcess extends EventEmitter {
  readonly stdin = {
    writes: [] as string[],
    write: (value: string) => {
      this.stdin.writes.push(value);
      for (const line of value.trim().split("\n")) this.onRequest(JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> });
      return true;
    },
    end: () => undefined,
  };
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  cancelled = false;
  mode: "complete" | "hold" = "complete";
  private onRequest(request: { id?: number; method: string; params?: Record<string, unknown> }) {
    const reply = (result: Record<string, unknown>) => setImmediate(() => this.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
    if (request.method === "initialize") return reply({ protocolVersion: "2026-01-01", capabilities: {}, serverInfo: { name: "fake", version: "1" } });
    if (request.method === "thread/start") return reply({ thread: { id: "thread-1" } });
    if (request.method === "thread/resume") return reply({ thread: { id: request.params?.threadId ?? "thread-resumed" } });
    if (request.method === "turn/start") {
      reply({ turn: { id: "turn-1", status: "inProgress", items: [] } });
      if (this.mode === "complete") setImmediate(() => {
        this.stdout.emit("data", JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "not allowed" } }) + "\n");
        this.stdout.emit("data", JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "item-1", delta: "done" } }) + "\n");
        this.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "done" }] } } }) + "\n");
      });
      return;
    }
    if (request.method === "turn/interrupt") {
      this.cancelled = true;
      reply({});
    }
  }
  kill() { this.emit("close", null, "SIGTERM"); return true; }
}

async function configFixture(homeDir: string): Promise<CodexHostConfig> {
  return {
    executable: "codex-fake",
    workDir: process.cwd(),
    homeDir,
    model: "calendar-test-model",
    providerToml: { providerId: "fake", baseUrl: "http://127.0.0.1:8788/v1", wireApi: "responses", requestMaxRetries: 0, streamMaxRetries: 0 },
    gatewayUrl: "http://127.0.0.1:8787/api/calendar/agent-tools",
    capabilityToken: "secret-capability-token",
    mcpScript: join(process.cwd(), "server/src/calendar/mcp-stdio.ts"),
    timeoutMs: 2_000,
  };
}

test("CodexHost isolates CODEX_HOME, starts the fixed protocol, and awaits hooks", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "calendar-codex-host-"));
  const fake = new FakeProcess();
  let spawnOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
  const host = new CodexHost(await configFixture(homeDir), {
    spawn: (_command, args, options) => {
      assert.deepEqual(args, ["app-server", "--stdio"]);
      spawnOptions = options;
      return fake;
    },
  });
  const hooks: string[] = [];
  const result = await host.run({
    text: "list my calendar",
    onThread: async id => { await new Promise(resolve => setImmediate(resolve)); hooks.push(`thread:${id}`); },
    onTurn: async id => { await new Promise(resolve => setImmediate(resolve)); hooks.push(`turn:${id}`); },
  });
  assert.deepEqual(result, { threadId: "thread-1", turnId: "turn-1", status: "completed", text: "done" });
  assert.deepEqual(hooks, ["thread:thread-1", "turn:turn-1"]);
  assert.ok(fake.stdin.writes.every(value => !Object.prototype.hasOwnProperty.call(JSON.parse(value.trim()), "jsonrpc")));
  assert.ok(spawnOptions);
  assert.equal(spawnOptions!.env.CODEX_HOME, homeDir);
  assert.equal(spawnOptions!.env.CALENDAR_CAPABILITY_TOKEN, "secret-capability-token");
  assert.equal(spawnOptions!.env.OPENAI_API_KEY, undefined);
  assert.equal(spawnOptions!.env.HOME, undefined);
  const configText = await readFile(join(homeDir, "config.toml"), "utf8");
  assert.match(configText, /approval_policy = "never"/);
  assert.match(configText, /sandbox_mode = "read-only"/);
  assert.match(configText, /shell_tool = false/);
  assert.match(configText, /mcp_servers\.calendar/);
  assert.match(configText, /loader\.mjs/);
  assert.doesNotMatch(configText, /secret-capability-token/);
  const firstTable = configText.indexOf("[");
  assert.ok(firstTable > 0);
  assert.match(configText.slice(0, firstTable), /approval_policy = "never"/);
  assert.match(configText.slice(0, firstTable), /web_search = "disabled"/);
  assert.ok(configText.indexOf("[features]") < configText.indexOf("[model_providers.fake]"));
  assert.ok(configText.indexOf("[model_providers.fake]") < configText.indexOf("[mcp_servers.calendar]"));
  const rejected = fake.stdin.writes.map(value => JSON.parse(value.trim()) as { id?: string; error?: { code?: number } }).find(message => message.id === "approval-1");
  assert.deepEqual(rejected?.error, { code: -32601, message: "server requests are disabled for the calendar executor" });
  await host.close();
});

test("CodexHost resumes a thread and sends turn/interrupt on cancel", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "calendar-codex-host-"));
  const fake = new FakeProcess();
  fake.mode = "hold";
  const host = new CodexHost(await configFixture(homeDir), { spawn: () => fake });
  const running = host.run({ text: "continue", threadId: "thread-old" });
  for (let attempt = 0; attempt < 20 && !fake.stdin.writes.some(value => JSON.parse(value.trim()).method === "turn/start"); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await host.cancel();
  const result = await running;
  assert.equal(result.status, "interrupted");
  assert.equal(fake.cancelled, true);
  const requests = fake.stdin.writes.map(value => JSON.parse(value.trim()) as { method: string; params?: Record<string, unknown> });
  assert.ok(requests.some(request => request.method === "thread/resume" && request.params?.threadId === "thread-old"));
  assert.ok(requests.some(request => request.method === "turn/interrupt" && request.params?.turnId === "turn-1"));
  await host.close();
});

test("CodexHost refuses to start without an isolated provider config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "calendar-codex-host-"));
  let spawned = false;
  const config = await configFixture(homeDir);
  delete config.providerToml;
  const host = new CodexHost(config, { spawn: () => { spawned = true; return new FakeProcess(); } });
  await assert.rejects(() => host.run({ text: "must not start" }), /providerToml is required/);
  assert.equal(spawned, false);
});

test("CodexHost rejects raw TOML that could change the effective root policy", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "calendar-codex-host-"));
  const config = await configFixture(homeDir);
  (config as unknown as { providerToml: unknown }).providerToml = '[model_providers.fake]\nweb_search = "enabled"';
  const host = new CodexHost(config, { spawn: () => new FakeProcess() });
  await assert.rejects(() => host.run({ text: "must not start" }), /structured providerToml/);
});

test("the TypeScript MCP entrypoint starts from an empty work directory", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "calendar-codex-host-"));
  const emptyWorkDir = await mkdtemp(join(tmpdir(), "calendar-empty-cwd-"));
  const config = await configFixture(homeDir);
  const configText = buildCodexConfig(config);
  const argsLine = configText.split("\n").find(line => line.startsWith("args = "));
  assert.ok(argsLine);
  const args = JSON.parse(argsLine!.slice("args = ".length)) as string[];
  assert.equal(args[0], "--import");
  assert.match(args[1], /loader\.mjs$/);
  const child = realSpawn(process.execPath, args, {
    cwd: emptyWorkDir,
    env: { PATH: process.env.PATH, TEMP: process.env.TEMP, SystemRoot: process.env.SystemRoot, CALENDAR_GATEWAY_URL: config.gatewayUrl, CALENDAR_CAPABILITY_TOKEN: config.capabilityToken },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("MCP startup timed out")), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "empty-cwd-test", version: "1" },
    } }) + "\n");
  });
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.ok(response.result);
  child.kill();
});
