import { createTradeStationGetFetcher } from "./client.js";

async function main() {
  const symbol = process.argv[2] ?? "AAPL";
  const get = await createTradeStationGetFetcher();

  // Minimal read-only smoke test: fetch a single quote by symbol.
  // Endpoint chosen for simplicity: GET /marketdata/quotes/{symbol}
  const endpoint = `/marketdata/quotes/${encodeURIComponent(symbol)}`;
  const response = await get(endpoint);

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `TradeStation smoke test failed (${response.status}): ${bodyText}`,
    );
  }

  const quotePayload = (await response.json()) as unknown;

  console.log("TradeStation smoke test succeeded.");
  console.log(
    JSON.stringify(
      {
        symbol,
        endpoint,
        httpStatus: response.status,
        hasData: quotePayload !== null,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
