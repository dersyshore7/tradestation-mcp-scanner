const TRADESTATION_API_KEY_ENV_NAME = "TRADESTATION_API_KEY";
const TRADESTATION_API_SECRET_ENV_NAME = "TRADESTATION_API_SECRET";
const TRADESTATION_REDIRECT_URI_ENV_NAME = "TRADESTATION_REDIRECT_URI";
const TRADESTATION_REFRESH_TOKEN_ENV_NAME = "TRADESTATION_REFRESH_TOKEN";
const TRADESTATION_BASE_URL_ENV_NAME = "TRADESTATION_BASE_URL";
const TRADESTATION_AUTH_STATE_ENV_NAME = "TRADESTATION_AUTH_STATE";
const DEFAULT_TRADESTATION_BASE_URL = "https://api.tradestation.com/v3";
const TRADESTATION_SIGNIN_BASE_URL = "https://signin.tradestation.com";
const TRADESTATION_GET_RETRY_ATTEMPTS = 3;
const TRADESTATION_GET_RETRY_DELAY_MS = 1_500;
const TRADESTATION_SCAN_MIN_INTERVAL_MS_ENV_NAME = "TRADESTATION_SCAN_MIN_INTERVAL_MS";
const TRADESTATION_SCAN_CACHE_TTL_MS_ENV_NAME = "TRADESTATION_SCAN_CACHE_TTL_MS";
const TRADESTATION_QUOTA_BACKOFF_MS_ENV_NAME = "TRADESTATION_QUOTA_BACKOFF_MS";
const DEFAULT_TRADESTATION_SCAN_MIN_INTERVAL_MS = 350;
const DEFAULT_TRADESTATION_SCAN_CACHE_TTL_MS = 120_000;
const DEFAULT_TRADESTATION_QUOTA_BACKOFF_MS = 15_000;

type TradeStationTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type TradeStationResponseFailureDetails = {
  quotaExceeded: boolean;
  errorMessage: string | null;
  retryAfterMs: number | null;
};

type CapturedTradeStationResponse = TradeStationResponseFailureDetails & {
  bodyText: string;
  headers: [string, string][];
  status: number;
  statusText: string;
};

type CachedTradeStationResponse = CapturedTradeStationResponse & {
  expiresAt: number;
};

const marketDataResponseCache = new Map<string, CachedTradeStationResponse>();
let tradeStationGetQueue = Promise.resolve();
let lastTradeStationGetStartedAt = 0;
let tradeStationQuotaBlockedUntil = 0;

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function buildDedupedPath(baseUrl: string, path: string): string {
  const normalizedPath = normalizePath(path);
  return baseUrl.endsWith("/v3") && normalizedPath.startsWith("/v3/")
    ? normalizedPath.slice(3)
    : normalizedPath;
}

function isCacheableMarketDataGet(baseUrl: string, path: string, init?: RequestInit): boolean {
  const method = init?.method ?? "GET";
  return method.toUpperCase() === "GET" && buildDedupedPath(baseUrl, path).startsWith("/marketdata/");
}

function buildCacheKey(baseUrl: string, path: string): string {
  return `${baseUrl}${buildDedupedPath(baseUrl, path)}`;
}

export function readTradeStationRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) {
    return null;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function readErrorMessageFromBody(bodyText: string): string | null {
  if (!bodyText.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["Message", "message", "error_description", "error"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
    }
  } catch {
    // Fall back to compact text below.
  }

  return bodyText.trim().slice(0, 240);
}

function isQuotaExceededMessage(message: string | null): boolean {
  return message?.toLowerCase().includes("quota exceeded") ?? false;
}

export async function readTradeStationResponseFailureDetails(
  response: Response,
): Promise<TradeStationResponseFailureDetails> {
  const bodyText = await response.clone().text();
  const errorMessage = readErrorMessageFromBody(bodyText);
  return {
    quotaExceeded:
      response.status === 429 ||
      (response.status === 403 && isQuotaExceededMessage(errorMessage)),
    errorMessage,
    retryAfterMs: readTradeStationRetryAfterMs(response.headers),
  };
}

async function captureTradeStationResponse(
  response: Response,
): Promise<CapturedTradeStationResponse> {
  const bodyText = await response.text();
  const errorMessage = readErrorMessageFromBody(bodyText);
  return {
    bodyText,
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
    quotaExceeded:
      response.status === 429 ||
      (response.status === 403 && isQuotaExceededMessage(errorMessage)),
    errorMessage,
    retryAfterMs: readTradeStationRetryAfterMs(response.headers),
  };
}

function toResponse(captured: CapturedTradeStationResponse): Response {
  return new Response(captured.bodyText, {
    status: captured.status,
    statusText: captured.statusText,
    headers: captured.headers,
  });
}

function shouldRetryCapturedResponse(response: CapturedTradeStationResponse): boolean {
  return response.quotaExceeded || response.status === 429 || response.status >= 500;
}

function enqueueTradeStationGet<T>(operation: () => Promise<T>): Promise<T> {
  const run = tradeStationGetQueue.then(operation, operation);
  tradeStationGetQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readCachedMarketData(cacheKey: string): Response | null {
  const cached = marketDataResponseCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    marketDataResponseCache.delete(cacheKey);
    return null;
  }

  return toResponse(cached);
}

export function __resetTradeStationRequestGovernorForTests(): void {
  marketDataResponseCache.clear();
  tradeStationGetQueue = Promise.resolve();
  lastTradeStationGetStartedAt = 0;
  tradeStationQuotaBlockedUntil = 0;
}

export function readTradeStationBaseUrl(baseUrlOverride?: string): string {
  return (
    baseUrlOverride
    ?? process.env[TRADESTATION_BASE_URL_ENV_NAME]
    ?? DEFAULT_TRADESTATION_BASE_URL
  ).replace(/\/$/, "");
}

export function buildTradeStationAuthorizationUrl(): string {
  const apiKey = getRequiredEnvVar(TRADESTATION_API_KEY_ENV_NAME);
  const redirectUri = getRequiredEnvVar(TRADESTATION_REDIRECT_URI_ENV_NAME);
  const state = process.env[TRADESTATION_AUTH_STATE_ENV_NAME];

  const query = new URLSearchParams({
    response_type: "code",
    client_id: apiKey,
    audience: "https://api.tradestation.com",
    redirect_uri: redirectUri,
    scope:
      "openid offline_access profile MarketData ReadAccount Trade Matrix OptionSpreads",
  });

  if (state) {
    query.set("state", state);
  }

  return `${TRADESTATION_SIGNIN_BASE_URL}/authorize?${query.toString()}`;
}

async function requestToken(
  body: URLSearchParams,
): Promise<TradeStationTokenResponse> {
  const response = await fetch(`${TRADESTATION_SIGNIN_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });

  const payload = (await response.json()) as TradeStationTokenResponse;

  if (!response.ok || !payload.access_token) {
    const reason =
      payload.error_description ??
      payload.error ??
      `Token request failed with HTTP ${response.status}`;

    throw new Error(`TradeStation token request failed: ${reason}`);
  }

  return payload;
}

export async function exchangeTradeStationAuthorizationCode(
  authorizationCode: string,
): Promise<TradeStationTokenResponse> {
  const apiKey = getRequiredEnvVar(TRADESTATION_API_KEY_ENV_NAME);
  const apiSecret = getRequiredEnvVar(TRADESTATION_API_SECRET_ENV_NAME);
  const redirectUri = getRequiredEnvVar(TRADESTATION_REDIRECT_URI_ENV_NAME);

  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: apiKey,
      client_secret: apiSecret,
      redirect_uri: redirectUri,
    }),
  );
}

export async function refreshTradeStationAccessToken(
  refreshToken: string,
): Promise<TradeStationTokenResponse> {
  const apiKey = getRequiredEnvVar(TRADESTATION_API_KEY_ENV_NAME);
  const apiSecret = getRequiredEnvVar(TRADESTATION_API_SECRET_ENV_NAME);

  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: apiKey,
      client_secret: apiSecret,
      refresh_token: refreshToken,
    }),
  );
}

export async function requestTradeStationAccessToken(): Promise<string> {
  const refreshToken = getRequiredEnvVar(TRADESTATION_REFRESH_TOKEN_ENV_NAME);
  const tokenPayload = await refreshTradeStationAccessToken(refreshToken);

  return tokenPayload.access_token as string;
}

export async function createTradeStationFetcher(options?: {
  baseUrl?: string;
}): Promise<
  (path: string, init?: RequestInit) => Promise<Response>
> {
  const baseUrl = readTradeStationBaseUrl(options?.baseUrl);
  const accessToken = await requestTradeStationAccessToken();

  return async (path: string, init?: RequestInit) => {
    const dedupedPath = buildDedupedPath(baseUrl, path);

    return fetch(`${baseUrl}${dedupedPath}`, {
      ...init,
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  };
}

export async function createTradeStationGetFetcher(baseUrlOverride?: string): Promise<
  (path: string, init?: RequestInit) => Promise<Response>
> {
  const baseUrl = readTradeStationBaseUrl(baseUrlOverride);
  const request = await createTradeStationFetcher(
    baseUrlOverride ? { baseUrl: baseUrlOverride } : undefined,
  );
  const minIntervalMs = readNonNegativeNumberEnv(
    TRADESTATION_SCAN_MIN_INTERVAL_MS_ENV_NAME,
    DEFAULT_TRADESTATION_SCAN_MIN_INTERVAL_MS,
  );
  const cacheTtlMs = readNonNegativeNumberEnv(
    TRADESTATION_SCAN_CACHE_TTL_MS_ENV_NAME,
    DEFAULT_TRADESTATION_SCAN_CACHE_TTL_MS,
  );
  const quotaBackoffMs = readNonNegativeNumberEnv(
    TRADESTATION_QUOTA_BACKOFF_MS_ENV_NAME,
    DEFAULT_TRADESTATION_QUOTA_BACKOFF_MS,
  );

  return async (path: string, init?: RequestInit) => {
    const cacheable = isCacheableMarketDataGet(baseUrl, path, init);
    const cacheKey = cacheable ? buildCacheKey(baseUrl, path) : null;
    if (cacheKey) {
      const cachedResponse = readCachedMarketData(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    return enqueueTradeStationGet(async () => {
      if (cacheKey) {
        const cachedResponse = readCachedMarketData(cacheKey);
        if (cachedResponse) {
          return cachedResponse;
        }
      }

      let captured: CapturedTradeStationResponse | null = null;

      for (let attempt = 1; attempt <= TRADESTATION_GET_RETRY_ATTEMPTS; attempt += 1) {
        const waitMs = Math.max(
          0,
          tradeStationQuotaBlockedUntil - Date.now(),
          lastTradeStationGetStartedAt + minIntervalMs - Date.now(),
        );
        if (waitMs > 0) {
          await delay(waitMs);
        }

        lastTradeStationGetStartedAt = Date.now();
        captured = await captureTradeStationResponse(
          await request(path, {
            ...init,
            method: "GET",
          }),
        );

        if (cacheKey && cacheTtlMs > 0 && captured.status >= 200 && captured.status < 300) {
          marketDataResponseCache.set(cacheKey, {
            ...captured,
            expiresAt: Date.now() + cacheTtlMs,
          });
        }

        if (!shouldRetryCapturedResponse(captured) || attempt === TRADESTATION_GET_RETRY_ATTEMPTS) {
          return toResponse(captured);
        }

        const retryDelayMs =
          captured.retryAfterMs ??
          (captured.quotaExceeded ? quotaBackoffMs : TRADESTATION_GET_RETRY_DELAY_MS * attempt);
        if (captured.quotaExceeded) {
          tradeStationQuotaBlockedUntil = Math.max(
            tradeStationQuotaBlockedUntil,
            Date.now() + retryDelayMs,
          );
        }
        if (retryDelayMs > 0) {
          await delay(retryDelayMs);
        }
      }

      return toResponse(captured as CapturedTradeStationResponse);
    });
  };
}
