import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthSettings } from "./types";

const DEFAULT_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD ?? "Admin12345";
const DEFAULT_ITERATIONS = 120_000;
const KEY_LENGTH = 64;
const DIGEST = "sha512";

export const SESSION_COOKIE_NAME = "auto_mail_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function base64Url(buffer: Buffer | string) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function createAuthSettings(password = DEFAULT_PASSWORD): AuthSettings {
  const passwordSalt = randomBytes(24).toString("base64url");
  const passwordIterations = DEFAULT_ITERATIONS;
  return {
    passwordHash: hashPassword(password, passwordSalt, passwordIterations),
    passwordSalt,
    passwordIterations,
    passwordUpdatedAt: new Date().toISOString()
  };
}

export function hashPassword(password: string, salt: string, iterations = DEFAULT_ITERATIONS) {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST).toString("base64url");
}

export function verifyPassword(password: string, settings: AuthSettings) {
  const expected = Buffer.from(settings.passwordHash, "base64url");
  const actual = Buffer.from(hashPassword(password, settings.passwordSalt, settings.passwordIterations), "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isDefaultPassword(settings: AuthSettings) {
  return verifyPassword(DEFAULT_PASSWORD, settings);
}

function signingKey(settings: AuthSettings) {
  return `${settings.passwordHash}.${settings.passwordSalt}.${settings.passwordIterations}`;
}

function sign(value: string, settings: AuthSettings) {
  return createHmac("sha256", signingKey(settings)).update(value).digest("base64url");
}

export function createSessionToken(settings: AuthSettings) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      iat: now,
      exp: now + SESSION_MAX_AGE_SECONDS,
      pv: settings.passwordHash.slice(0, 16)
    })
  );
  return `${payload}.${sign(payload, settings)}`;
}

export function verifySessionToken(token: string | undefined, settings: AuthSettings) {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = sign(payload, settings);
  const expected = Buffer.from(expectedSignature, "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as { exp?: number; pv?: string };
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return false;
    return parsed.pv === settings.passwordHash.slice(0, 16);
  } catch {
    return false;
  }
}
