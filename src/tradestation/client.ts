const TRADESTATION_API_KEY_ENV_NAME = "TRADESTATION_API_KEY";
const TRADESTATION_API_SECRET_ENV_NAME = "TRADESTATION_API_SECRET";
const TRADESTATION_REDIRECT_URI_ENV_NAME = "TRADESTATION_REDIRECT_URI";
const TRADESTATION_REFRESH_TOKEN_ENV_NAME = "TRADESTATION_REFRESH_TOKEN";
const TRADESTATION_BASE_URL_ENV_NAME = "TRADESTATION_BASE_URL";
const TRADESTATION_AUTH_STATE_ENV_NAME = "TRADESTATION_AUTH_STATE";
const DEFAULT_TRADESTATION_BASE_URL = "https://api.tradestation.com/v3";
const TRADESTATION_SIGNIN_BASE_URL = "https://signin.tradestation.com";

type TradeStationTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name} environment variable.`);
  }

  return value;
}

function getTradeStationBaseUrl(): string {
  return (
    process.env[TRADESTATION_BASE_URL_ENV_NAME] ?? DEFAULT_TRADESTATION_BASE_URL
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

export async function createTradeStationGetFetcher(): Promise<
  (path: string, init?: RequestInit) => Promise<Response>
> {
  const baseUrl = getTradeStationBaseUrl();
  const accessToken = await requestTradeStationAccessToken();

  return async (path: string, init?: RequestInit) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dedupedPath = baseUrl.endsWith("/v3") && normalizedPath.startsWith("/v3/")
      ? normalizedPath.slice(3)
      : normalizedPath;

    return fetch(`${baseUrl}${dedupedPath}`, {
      ...init,
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...init?.headers,
      },
    });
  };
}
