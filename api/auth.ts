import { timingSafeEqual } from "node:crypto";
import { sendError, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | string[] | undefined>;
};

type ApiAuthKind = "operator" | "cron";

function readSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function readAuthorizationHeader(req: VercelRequestLike): string | null {
  const headers = (req as RequestWithHeaders).headers;
  return firstHeaderValue(headers?.authorization ?? headers?.Authorization);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function configuredSecrets(kind: ApiAuthKind): string[] {
  const operatorSecret = readSecret("AUTO_TRADER_API_SECRET");
  const cronSecret = kind === "cron" ? readSecret("CRON_SECRET") : null;
  return [operatorSecret, cronSecret].filter(
    (value, index, values): value is string =>
      value !== null && values.indexOf(value) === index,
  );
}

export function isApiBearerAuthorized(
  req: VercelRequestLike,
  kind: ApiAuthKind = "operator",
): boolean {
  const authorization = readAuthorizationHeader(req);
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const provided = authorization.slice("Bearer ".length);
  return configuredSecrets(kind).some((secret) => safeEqual(provided, secret));
}

export function requireApiBearerAuth(
  req: VercelRequestLike,
  res: VercelResponseLike,
  kind: ApiAuthKind = "operator",
): boolean {
  if (configuredSecrets(kind).length === 0) {
    sendError(res, 503, "API bearer authentication is not configured.");
    return false;
  }
  if (!isApiBearerAuthorized(req, kind)) {
    res.setHeader?.("WWW-Authenticate", "Bearer");
    sendError(res, 401, "Unauthorized.");
    return false;
  }
  return true;
}
