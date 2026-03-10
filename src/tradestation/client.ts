const TRADESTATION_API_KEY_ENV_NAME = "TRADESTATION_API_KEY";
const TRADESTATION_API_SECRET_ENV_NAME = "TRADESTATION_API_SECRET";
const TRADESTATION_REFRESH_TOKEN_ENV_NAME = "TRADESTATION_REFRESH_TOKEN";
const TRADESTATION_BASE_URL_ENV_NAME = "TRADESTATION_BASE_URL";
const DEFAULT_TRADESTATION_BASE_URL = "https://api.tradestation.com/v3";

type TradeStationTokenResponse = {
  access_token?: string;
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

export async function requestTradeStationAccessToken(): Promise<string> {
  const baseUrl = getTradeStationBaseUrl();
  const apiKey = getRequiredEnvVar(TRADESTATION_API_KEY_ENV_NAME);
  const apiSecret = getRequiredEnvVar(TRADESTATION_API_SECRET_ENV_NAME);
  const refreshToken = getRequiredEnvVar(TRADESTATION_REFRESH_TOKEN_ENV_NAME);

  const response = await fetch(`${baseUrl}/security/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: apiKey,
      client_secret: apiSecret,
      refresh_token: refreshToken,
    }),
  });

  const payload = (await response.json()) as TradeStationTokenResponse;

  if (!response.ok || !payload.access_token) {
    const reason =
      payload.error_description ??
      payload.error ??
      `Token request failed with HTTP ${response.status}`;

    throw new Error(`TradeStation token refresh failed: ${reason}`);
  }

  return payload.access_token;
}

export async function createTradeStationGetFetcher(): Promise<
  (path: string, init?: RequestInit) => Promise<Response>
> {
  const baseUrl = getTradeStationBaseUrl();
  const accessToken = await requestTradeStationAccessToken();

  return async (path: string, init?: RequestInit) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return fetch(`${baseUrl}${normalizedPath}`, {
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
