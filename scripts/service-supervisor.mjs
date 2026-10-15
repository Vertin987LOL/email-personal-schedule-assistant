import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeArgs = [
  `--max-old-space-size=${process.env.APP_MAX_OLD_SPACE_MB ?? "384"}`,
  "--import",
  "tsx",
  "server/src/server.ts"
];
const healthUrl = process.env.APP_HEALTH_URL ?? "http://127.0.0.1:8787/api/health";
const healthIntervalMs = Number(process.env.APP_HEALTH_INTERVAL_SECONDS ?? 30) * 1000;
const healthFailureLimit = Number(process.env.APP_HEALTH_FAILURE_LIMIT ?? 3);
const startupGraceMs = Number(process.env.APP_HEALTH_STARTUP_GRACE_SECONDS ?? 45) * 1000;

let stopping = false;
let child;
let healthTimer;
let restartAttempts = 0;

function log(message) {
  console.log(`[supervisor] ${message}`);
}

function stopChild() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }, 10_000).unref();
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping`);
  if (healthTimer) clearInterval(healthTimer);
  stopChild();
}

async function checkHealth() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    return response.ok && /"ok"\s*:\s*true/.test(body);
  } catch {
    return false;
  }
}

async function monitorHealth(monitoredChild) {
  await new Promise((resolve) => setTimeout(resolve, startupGraceMs));
  if (stopping || monitoredChild !== child) return;

  let failures = 0;
  healthTimer = setInterval(async () => {
    if (stopping || monitoredChild !== child || monitoredChild.exitCode !== null) return;
    if (await checkHealth()) {
      failures = 0;
      return;
    }

    failures += 1;
    log(`health check failed ${failures}/${healthFailureLimit}`);
    if (failures >= healthFailureLimit) {
      log(`health check failure limit reached; restarting app pid=${monitoredChild.pid}`);
      monitoredChild.kill("SIGTERM");
    }
  }, healthIntervalMs);
}

async function run() {
  while (!stopping) {
    const startedAt = Date.now();
    child = spawn(process.execPath, nodeArgs, {
      cwd: projectRoot,
      env: { ...process.env, MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? "2" },
      stdio: "inherit",
      windowsHide: true
    });
    const currentChild = child;
    log(`app started pid=${currentChild.pid}`);
    void monitorHealth(currentChild);

    const exitCode = await new Promise((resolve) => {
      currentChild.once("exit", (code, signal) => resolve(`${code ?? "signal:" + signal}`));
      currentChild.once("error", (error) => {
        log(`app spawn failed: ${error.message}`);
        resolve("spawn-error");
      });
    });

    if (healthTimer) clearInterval(healthTimer);
    healthTimer = undefined;
    child = undefined;
    if (stopping) break;

    if (Date.now() - startedAt >= 60_000) restartAttempts = 0;
    const delayMs = Math.min(30_000, 2 ** restartAttempts * 1_000);
    restartAttempts = Math.min(5, restartAttempts + 1);
    log(`app exited code=${exitCode}; restarting in ${delayMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  log("supervisor stopped");
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
void run();
