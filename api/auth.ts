import { readPaperTraderApiSecrets } from "../src/automation/config.js";
import { sendError, type VercelRequestLike, type VercelResponseLike } from "./journal/shared.js";

type RequestWithHeaders = VercelRequestLike & {
  headers?: Record<string, string | string[] | undefined>;
};

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function readAuthorizationHeader(req: RequestWithHeaders): string | null {
  return firstHeaderValue(req.headers?.authorization ?? req.headers?.Authorization);
}

export function isApiBearerAuthorized(req: VercelRequestLike): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    return false;
  }

  const authorization = readAuthorizationHeader(req as RequestWithHeaders);
  return secrets.some((secret) => authorization === `Bearer ${secret}`);
}

export function requireApiBearerAuth(req: VercelRequestLike, res: VercelResponseLike): boolean {
  const secrets = readPaperTraderApiSecrets();
  if (secrets.length === 0) {
    sendError(res, 503, "API bearer auth is not configured.");
    return false;
  }

  if (!isApiBearerAuthorized(req)) {
    sendError(res, 401, "Unauthorized.");
    return false;
  }

  return true;
}
