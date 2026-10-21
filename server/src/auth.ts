import type express from "express";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken
} from "./auth-crypto";
import { readSettings } from "./store";

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    cookies.set(key, decodeURIComponent(value));
  }

  return cookies;
}

function isSecureRequest(req: express.Request) {
  return req.secure || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function cookieBase(req: express.Request) {
  return ["Path=/", "HttpOnly", "SameSite=Lax", isSecureRequest(req) ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

export function getSessionToken(req: express.Request) {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME) || (typeof req.query?.auth === "string" ? req.query.auth : undefined);
}

export function isAuthenticated(req: express.Request) {
  return verifySessionToken(getSessionToken(req), readSettings().auth);
}

export function setAuthCookie(req: express.Request, res: express.Response) {
  const token = createSessionToken(readSettings().auth);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${cookieBase(req)}`
  );
}

export function clearAuthCookie(req: express.Request, res: express.Response) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Max-Age=0; ${cookieBase(req)}`);
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "请先登录。", authenticated: false });
}
