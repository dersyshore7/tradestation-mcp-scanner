import { exchangeTradeStationAuthorizationCode } from "./client.js";

async function main() {
  const authorizationCode = process.argv[2];

  if (!authorizationCode) {
    throw new Error(
      "Missing authorization code. Usage: npm run tradestation:exchange-code -- <code>",
    );
  }

  const tokenPayload = await exchangeTradeStationAuthorizationCode(
    authorizationCode,
  );

  console.log("Token exchange succeeded.");
  console.log(`Access token: ${tokenPayload.access_token}`);
  console.log(`Refresh token: ${tokenPayload.refresh_token ?? "(not provided)"}`);
  console.log("Save the refresh token in your .env as TRADESTATION_REFRESH_TOKEN.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
