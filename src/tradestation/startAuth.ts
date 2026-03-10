import { buildTradeStationAuthorizationUrl } from "./client.js";

function main() {
  const loginUrl = buildTradeStationAuthorizationUrl();

  console.log("Open this TradeStation login URL in your browser:");
  console.log(loginUrl);
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
