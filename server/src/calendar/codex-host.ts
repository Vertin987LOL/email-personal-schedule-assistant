import { spawn as nodeSpawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertCalendarGatewayUrl, CALENDAR_TOOL_NAMES } from "./mcp-stdio";

export type CodexProviderConfig = {
  providerId: string;
  baseUrl: string;
  wireApi?: "responses" | "chat";
  envKey?: string;
  requiresOpenaiAuth?: boolean;
  name?: string;
  requestMaxRetries?: number;
  streamMaxRetries?: number;
};

export type CodexHostConfig = {
  executable: string;
  workDir: string;
  homeDir: string;
  model: string;
  /** Structured provider allowlist. Raw TOML is deliberately unsupported. */
  providerToml?: CodexProviderConfig;
  /** Use the built-in official OpenAI route; mutually exclusive with providerToml. */
  builtinOpenai?: boolean;
  /** Optional source auth file. It is copied once to the isolated home. */
  authFile?: string;
  gatewayUrl: string;
  capabilityToken: string;
  mcpScript: string;
  timeoutMs?: number;
  effort?: string;
  providerEnv?: Record<string, string>;
};

export type CodexHostRunInput = {
  text: string;
  threadId?: string;
  onThread?: (id: string) => void | Promise<void>;
  onTurn?: (id: string) => void | Promise<void>;
  onEvent?: (event: { kind: string; status?: string; text?: string }) => void;
};

export type CodexHostRunResult = {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  error?: string;
};

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type SpawnedProcess = {
  readonly pid?: number;
  stdin: { write(value: string): boolean; end(): void };
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): unknown; setEncoding?: (encoding: BufferEncoding) => void };
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): unknown; setEncoding?: (encoding: BufferEncoding) => void };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

type Spawn = (command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ["pipe", "pipe", "pipe"];
}) => SpawnedProcess;

type SpawnTaskkill = (command: string, args: string[], options: { windowsHide: boolean; stdio: "ignore" }) => unknown;

type Pending = { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void };
type Outcome = { status: "completed" | "failed" | "interrupted"; error?: string };
type RunContext = {
  threadId: string;
  turnId: string;
  input: CodexHostRunInput;
  textByItem: Map<string, string>;
  phaseByItem: Map<string, string>;
  completedAgentItems: string[];
  fallbackText: string;
  finalText?: string;
  outcome?: Outcome;
  resolveOutcome: (outcome: Outcome) => void;
  outcomePromise: Promise<Outcome>;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const CLOSE_GRACE_MS = 500;
function tomlString(value: string) {
  return JSON.stringify(value);
}

function safeMessage(message: unknown, fallback: string) {
  if (typeof message !== "string" || !message) return fallback;
  return message.slice(0, 1_000);
}

function textFromTurn(turn: Record<string, unknown> | undefined, context: RunContext) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (value.type !== "agentMessage" || typeof value.id !== "string") continue;
    const itemId = value.id;
    if (typeof value.phase === "string") context.phaseByItem.set(itemId, value.phase);
    if (typeof value.text === "string") context.textByItem.set(itemId, value.text);
    if (!context.completedAgentItems.includes(itemId)) context.completedAgentItems.push(itemId);
  }
  const finalMessages = context.completedAgentItems
    .filter(id => context.phaseByItem.get(id) === "final_answer")
    .map(id => context.textByItem.get(id) ?? "")
    .filter(Boolean);
  if (finalMessages.length) return finalMessages.join("");
  const completedMessages = context.completedAgentItems
    .map(id => context.textByItem.get(id) ?? "")
    .filter(Boolean);
  return completedMessages.at(-1) || context.fallbackText;
}

/** Build the isolated CODEX_HOME config. It intentionally contains no user config or credential file. */
export function buildCodexConfig(config: CodexHostConfig) {
  const provider = config.providerToml;
  const builtinOpenai = config.builtinOpenai === true;
  if (builtinOpenai && provider !== undefined) throw new Error("builtinOpenai and providerToml are mutually exclusive");
  if (!builtinOpenai && (!provider || typeof provider !== "object")) throw new Error("structured providerToml is required; isolated execution is disabled");
  if (!isAbsolute(config.homeDir) || !isAbsolute(config.workDir) || !isAbsolute(config.mcpScript)) throw new Error("workDir, homeDir and mcpScript must be absolute paths");
  if (config.authFile !== undefined && (!config.authFile || !isAbsolute(config.authFile))) throw new Error("authFile must be an absolute path");
  if (config.effort !== undefined && (typeof config.effort !== "string" || !/^\S{1,32}$/.test(config.effort))) throw new Error("effort is invalid");
  assertCalendarGatewayUrl(config.gatewayUrl);
  // app-server may run with an empty cwd; a bare `tsx` loader would then fail module resolution.
  const scriptArgs = /\.ts$/i.test(config.mcpScript) ? ["--import", import.meta.resolve("tsx"), config.mcpScript] : [config.mcpScript];
  const hostControls = [
    `model = ${tomlString(config.model)}`,
    `model_provider = ${tomlString(builtinOpenai ? "openai" : provider!.providerId)}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
  ].join("\n");
  let providerTable = "";
  if (!builtinOpenai) {
    const selected = provider!;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(selected.providerId)) throw new Error("providerId is invalid");
    let baseUrl: URL;
    try { baseUrl = new URL(selected.baseUrl); } catch { throw new Error("provider baseUrl is invalid"); }
    if (!(baseUrl.protocol === "http:" || baseUrl.protocol === "https:") || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("provider baseUrl is invalid");
    if (selected.envKey !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(selected.envKey)) throw new Error("provider envKey is invalid");
    if (selected.requiresOpenaiAuth !== undefined && typeof selected.requiresOpenaiAuth !== "boolean") throw new Error("requiresOpenaiAuth is invalid");
    const requestMaxRetries = selected.requestMaxRetries ?? 0;
    const streamMaxRetries = selected.streamMaxRetries ?? 0;
    if (![requestMaxRetries, streamMaxRetries].every(value => Number.isInteger(value) && value >= 0 && value <= 3)) throw new Error("provider retry limits are invalid");
    const providerName = selected.name ?? selected.providerId;
    if (typeof providerName !== "string" || providerName.length === 0 || providerName.length > 200) throw new Error("provider name is invalid");
    const wireApi = selected.wireApi ?? "responses";
    if (wireApi !== "responses" && wireApi !== "chat") throw new Error("provider wireApi is invalid");
    const authFlag = selected.requiresOpenaiAuth === true;
    providerTable = [
      `[model_providers.${selected.providerId}]`,
      `name = ${tomlString(providerName)}`,
      `base_url = ${tomlString(baseUrl.toString())}`,
      `wire_api = ${tomlString(wireApi)}`,
      ...(authFlag ? ["requires_openai_auth = true"] : selected.envKey ? [`env_key = ${tomlString(selected.envKey)}`] : []),
      `request_max_retries = ${requestMaxRetries}`,
      `stream_max_retries = ${streamMaxRetries}`,
    ].join("\n");
  }
  const mcp = [
    "[mcp_servers.calendar]",
    `command = ${tomlString(process.execPath)}`,
    `args = [${scriptArgs.map(tomlString).join(", ")}]`,
    `cwd = ${tomlString(config.workDir)}`,
    `enabled_tools = [${CALENDAR_TOOL_NAMES.map(tomlString).join(", ")}]`,
    'default_tools_approval_mode = "approve"',
    'env_vars = ["CALENDAR_GATEWAY_URL", "CALENDAR_CAPABILITY_TOKEN"]',
  ].join("\n");
  return `${hostControls}\n\n[features]\n${["shell_tool = false", "multi_agent = false", "view_image = false"].join("\n")}\n\n${providerTable ? `${providerTable}\n\n` : ""}${mcp}\n`;
}

function minimalEnvironment(config: CodexHostConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, config.providerEnv ?? {});
  environment.CODEX_HOME = config.homeDir;
  // The MCP process inherits these values from app-server; it reads them only from its environment.
  environment.CALENDAR_GATEWAY_URL = config.gatewayUrl;
  environment.CALENDAR_CAPABILITY_TOKEN = config.capabilityToken;
  return environment;
}

export class CodexHost {
  private readonly spawn: Spawn;
  private readonly spawnTaskkill: SpawnTaskkill;
  private readonly platform: NodeJS.Platform;
  private readonly closeGraceMs: number;
  private process?: SpawnedProcess;
  private processPid?: number;
  private stdoutBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private current?: RunContext;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly config: CodexHostConfig, dependencies: { spawn?: Spawn; spawnTaskkill?: SpawnTaskkill; platform?: NodeJS.Platform; closeGraceMs?: number } = {}) {
    this.spawn = dependencies.spawn ?? (nodeSpawn as unknown as Spawn);
    this.spawnTaskkill = dependencies.spawnTaskkill ?? (nodeSpawn as unknown as SpawnTaskkill);
    this.platform = dependencies.platform ?? process.platform;
    this.closeGraceMs = dependencies.closeGraceMs ?? CLOSE_GRACE_MS;
  }

  private emit(event: { kind: string; status?: string; text?: string }) {
    try { this.current?.input.onEvent?.(event); } catch { /* progress callbacks cannot break the protocol */ }
  }

  private settle(context: RunContext, outcome: Outcome) {
    if (context.settled) return;
    context.settled = true;
    context.outcome = outcome;
    if (context.timer) clearTimeout(context.timer);
    context.resolveOutcome(outcome);
  }

  private handleNotification(message: JsonRpcMessage) {
    const context = this.current;
    if (!context || !message.method) return;
    const params = message.params ?? {};
    switch (message.method) {
      case "thread/started": {
        const thread = params.thread;
        const id = thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string"
          ? (thread as Record<string, unknown>).id as string : undefined;
        if (id) { context.threadId = id; this.emit({ kind: "thread_started", status: "running" }); }
        break;
      }
      case "turn/started": {
        const turn = params.turn;
        const id = turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
          ? (turn as Record<string, unknown>).id as string : undefined;
        if (id) { context.turnId = id; this.emit({ kind: "turn_started", status: "running" }); }
        break;
      }
      case "item/agentMessage/delta":
      case "agent_message_delta": {
        if (typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId : "__default__";
          context.textByItem.set(itemId, `${context.textByItem.get(itemId) ?? ""}${params.delta}`);
          if (typeof params.phase === "string") context.phaseByItem.set(itemId, params.phase);
          context.fallbackText += params.delta;
          this.emit({ kind: "progress", status: "running" });
        }
        break;
      }
      case "item/started": {
        const item = params.item;
        if (item && typeof item === "object") {
          const value = item as Record<string, unknown>;
          if (value.type === "agentMessage" && typeof value.id === "string" && typeof value.phase === "string") context.phaseByItem.set(value.id, value.phase);
        }
        break;
      }
      case "item/completed": {
        const item = params.item;
        if (item && typeof item === "object") {
          const value = item as Record<string, unknown>;
          if (value.type === "agentMessage" && typeof value.id === "string") {
            if (typeof value.phase === "string") context.phaseByItem.set(value.id, value.phase);
            if (typeof value.text === "string") context.textByItem.set(value.id, value.text);
            if (!context.completedAgentItems.includes(value.id)) context.completedAgentItems.push(value.id);
          }
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
        context.finalText = textFromTurn(turn, context);
        const status = turn?.status;
        const error = turn?.error && typeof turn.error === "object" ? (turn.error as Record<string, unknown>).message : undefined;
        if (status === "completed") this.settle(context, { status: "completed" });
        else if (status === "interrupted") this.settle(context, { status: "interrupted", error: safeMessage(error, "turn interrupted") });
        else this.settle(context, { status: "failed", error: safeMessage(error, "turn failed") });
        this.emit({ kind: "turn_completed", status: typeof status === "string" ? status : "unknown" });
        break;
      }
      default:
        // Other notifications are intentionally reduced to a generic progress signal.
        this.emit({ kind: "progress", status: "running" });
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; }
    catch { this.emit({ kind: "protocol_error", status: "invalid_json" }); return; }
    if (message.id !== undefined && message.method) {
      this.respondError(message.id, -32601, "server requests are disabled for the calendar executor");
      this.emit({ kind: "protocol_error", status: "server_request_rejected" });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`app-server request failed: ${safeMessage(message.error.message, "unknown protocol error")}`));
        else waiter.resolve(message);
      }
      return;
    }
    this.handleNotification(message);
  }

  private attachProcess(child: SpawnedProcess) {
    this.process = child;
    this.processPid = child.pid;
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += String(chunk);
      let index;
      while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        this.handleLine(line);
      }
    });
    // stderr is deliberately consumed and discarded: provider output may contain credentials or private prompts.
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      if (this.current && !this.current.settled) this.settle(this.current, { status: "failed", error: "app-server process failed" });
    });
    child.on("close", () => {
      if (this.current && !this.current.settled) this.settle(this.current, { status: "failed", error: "app-server process closed" });
      for (const waiter of this.pending.values()) waiter.reject(new Error("app-server process closed"));
      this.pending.clear();
      if (this.process === child) {
        this.process = undefined;
        this.processPid = undefined;
      }
    });
  }

  private async startProcess() {
    if (this.process) return;
    if (this.closed) throw new Error("Codex host is closed");
    const configText = buildCodexConfig(this.config);
    await mkdir(this.config.homeDir, { recursive: true });
    await writeFile(join(this.config.homeDir, "config.toml"), configText, "utf8");
    if (this.config.authFile) {
      const isolatedAuth = join(this.config.homeDir, "auth.json");
      try { await access(isolatedAuth); }
      catch {
        await copyFile(this.config.authFile, isolatedAuth);
        await chmod(isolatedAuth, 0o600);
      }
    }
    const child = this.spawn(this.config.executable, ["app-server", "--stdio", "--disable", "view_image"], {
      cwd: this.config.workDir,
      env: minimalEnvironment(this.config),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attachProcess(child);
    await this.request("initialize", {
      clientInfo: { name: "calendar-host", title: "Local calendar executor", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  private notify(method: string, params?: Record<string, unknown>) {
    if (!this.process) throw new Error("app-server is not running");
    this.process.stdin.write(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + "\n");
  }

  private respondError(id: number | string, code: number, message: string) {
    try { this.process?.stdin.write(JSON.stringify({ id, error: { code, message } }) + "\n"); } catch { /* process is already gone */ }
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    if (!this.process) return Promise.reject(new Error("app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.process!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("failed to write app-server request"));
      }
    });
  }

  private async callHook(hook: ((id: string) => void | Promise<void>) | undefined, id: string) {
    if (hook) await hook(id);
  }

  private async performRun(context: RunContext): Promise<CodexHostRunResult> {
    try {
      await this.startProcess();
      if (context.outcome) return this.result(context);
      let threadId = context.threadId;
      const threadResponse = threadId
        ? await this.request("thread/resume", { threadId, approvalPolicy: "never", sandbox: "read-only", cwd: this.config.workDir, runtimeWorkspaceRoots: [] })
        : await this.request("thread/start", { model: this.config.model, approvalPolicy: "never", sandbox: "read-only", cwd: this.config.workDir, runtimeWorkspaceRoots: [], ephemeral: false });
      const thread = threadResponse.result?.thread;
      if (!thread || typeof thread !== "object" || typeof (thread as Record<string, unknown>).id !== "string") throw new Error("app-server did not return a thread id");
      threadId = (thread as Record<string, unknown>).id as string;
      context.threadId = threadId;
      await this.callHook(context.input.onThread, threadId);
      if (context.outcome) return this.result(context);
      const turnResponse = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: context.input.text }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        runtimeWorkspaceRoots: [],
        ...(this.config.effort === undefined ? {} : { effort: this.config.effort }),
      });
      const turn = turnResponse.result?.turn;
      if (!turn || typeof turn !== "object" || typeof (turn as Record<string, unknown>).id !== "string") throw new Error("app-server did not return a turn id");
      context.turnId = (turn as Record<string, unknown>).id as string;
      await this.callHook(context.input.onTurn, context.turnId);
      if (!context.outcome) await context.outcomePromise;
      return this.result(context);
    } catch (error) {
      if (!context.outcome) this.settle(context, { status: "failed", error: safeMessage(error instanceof Error ? error.message : error, "Codex host failed") });
      return this.result(context);
    }
  }

  private result(context: RunContext): CodexHostRunResult {
    const outcome = context.outcome ?? { status: "failed" as const, error: "Codex host failed" };
    return {
      threadId: context.threadId,
      turnId: context.turnId,
      status: outcome.status,
      text: context.finalText || context.fallbackText || [...context.textByItem.values()].join(""),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  async run(input: CodexHostRunInput): Promise<CodexHostRunResult> {
    if (this.current) throw new Error("Codex host already has a running turn");
    if (typeof input.text !== "string" || !input.text.trim()) throw new Error("turn text is required");
    if (!Number.isInteger(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1) throw new Error("timeoutMs is invalid");
    // Fail before spawning when the host cannot construct an isolated configuration.
    buildCodexConfig(this.config);
    let resolveOutcome!: (outcome: Outcome) => void;
    const context: RunContext = {
      threadId: input.threadId ?? "",
      turnId: "",
      input,
      textByItem: new Map(),
      phaseByItem: new Map(),
      completedAgentItems: [],
      fallbackText: "",
      resolveOutcome: value => resolveOutcome(value),
      outcomePromise: new Promise(resolve => { resolveOutcome = resolve; }),
      settled: false,
    };
    this.current = context;
    context.timer = setTimeout(() => {
      this.emit({ kind: "timeout", status: "failed" });
      this.settle(context, { status: "failed", error: "Codex turn timed out" });
      void this.interrupt(context);
    }, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try { return await this.performRun(context); }
    finally {
      if (context.timer) clearTimeout(context.timer);
      if (this.current === context) this.current = undefined;
    }
  }

  private async interrupt(context: RunContext) {
    if (!this.process || !context.threadId || !context.turnId) return;
    try { await this.request("turn/interrupt", { threadId: context.threadId, turnId: context.turnId }); }
    catch { /* interruption is best effort after timeout or cancellation */ }
  }

  async cancel() {
    const context = this.current;
    if (!context) return;
    this.settle(context, { status: "interrupted", error: "Codex turn interrupted" });
    await Promise.race([this.interrupt(context), new Promise<void>(resolve => setTimeout(resolve, 250))]);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal() {
    this.closed = true;
    const context = this.current;
    if (context) this.settle(context, { status: "interrupted", error: "Codex host closed" });
    for (const waiter of this.pending.values()) waiter.reject(new Error("Codex host closed"));
    this.pending.clear();
    const child = this.process;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    const exited = await this.waitForProcessClose(child, this.closeGraceMs);
    if (exited || this.process !== child) return;

    const pid = this.processPid;
    if (this.platform === "win32" && typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      try {
        const killer = this.spawnTaskkill("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const on = (killer as { on?: (event: "error", listener: () => void) => unknown } | undefined)?.on;
        on?.call(killer, "error", () => undefined);
      } catch { /* forced cleanup is best effort and must not expose process details */ }
    } else {
      try { child.kill("SIGTERM"); } catch { /* already closed */ }
    }
    if (this.process === child) this.process = undefined;
    this.processPid = undefined;
  }

  private waitForProcessClose(child: SpawnedProcess, timeoutMs: number) {
    if (this.process !== child) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.on("close", () => finish(true));
      if (this.process !== child) finish(true);
    });
  }
}

export function createCodexHost(config: CodexHostConfig, dependencies?: { spawn?: Spawn }) {
  return new CodexHost(config, dependencies);
}
