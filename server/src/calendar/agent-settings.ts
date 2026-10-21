import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexHost, type CodexHostConfig } from "./codex-host";
import type { CalendarExecutorFactory } from "./agent-runtime";

export type CalendarExecutorSettings = {
  enabled: boolean;
  executable: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
  builtinOpenai: true;
  authFile?: string;
  homeDir?: string;
  workDir?: string;
};
export function readCalendarExecutorSettings(rootDir: string): CalendarExecutorSettings | undefined {
  const filename = path.join(rootDir, "data", "calendar-codex", "runtime.json");
  if (!fs.existsSync(filename)) return undefined;
  const input: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid calendar executor settings");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["enabled", "executable", "model", "effort", "builtinOpenai", "authFile", "homeDir", "workDir"].includes(key)) ||
    typeof value.enabled !== "boolean" || value.builtinOpenai !== true || typeof value.executable !== "string" || !path.isAbsolute(value.executable) ||
    typeof value.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.model) ||
    !["low", "medium", "high", "xhigh"].includes(String(value.effort)) ||
    (value.authFile !== undefined && (typeof value.authFile !== "string" || !path.isAbsolute(value.authFile))) ||
    (value.homeDir !== undefined && (typeof value.homeDir !== "string" || !path.isAbsolute(value.homeDir))) ||
    (value.workDir !== undefined && (typeof value.workDir !== "string" || !path.isAbsolute(value.workDir)))) throw new Error("invalid calendar executor settings");
  return value as CalendarExecutorSettings;
}
export function calendarExecutorFactory(settings: CalendarExecutorSettings, rootDir: string, gatewayUrl: string): CalendarExecutorFactory {
  if (!settings.enabled) throw new Error("calendar executor is disabled");
  const homeDir = settings.homeDir ?? (process.platform === "win32" ? path.join(rootDir, "data", "calendar-codex", "home") : path.join(os.homedir(), ".calendar-codex", "home"));
  const workDir = settings.workDir ?? (process.platform === "win32" ? path.join(rootDir, "data", "calendar-codex", "work") : path.join(os.homedir(), ".calendar-codex", "work"));
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  return ({ capabilityToken }) => {
    const config: CodexHostConfig = { executable: settings.executable, model: settings.model, effort: settings.effort,
      builtinOpenai: true, authFile: settings.authFile, homeDir, workDir, gatewayUrl, capabilityToken,
      mcpScript: path.join(rootDir, "server", "src", "calendar", "mcp-stdio.ts") };
    return new CodexHost(config);
  };
}
