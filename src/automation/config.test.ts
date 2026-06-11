import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPaperTraderConfig,
  readAutomationLane,
  readPaperTraderConfig,
  readTradeStationEnvironment,
  TRADESTATION_LIVE_AUTOMATION_BASE_URL,
  TRADESTATION_SIM_AUTOMATION_BASE_URL,
  type PaperTraderConfig,
} from "./config.js";

const ENV_KEYS = [
  "AUTO_TRADER_ALLOW_ORDER_PLACEMENT",
  "AUTO_TRADER_MANAGE_ENTRY_ORDERS",
  "AUTO_TRADER_MAX_POSITION_PCT",
  "AUTO_TRADER_SCAN_PROMPT",
  "AUTO_TRADER_API_SECRET",
  "CRON_SECRET",
  "TRADESTATION_AUTOMATION_BASE_URL",
  "TRADESTATION_AUTOMATION_ACCOUNT_ID",
  "TRADESTATION_ACCOUNT_ID",
  "PAPER_TRADESTATION_AUTOMATION_BASE_URL",
  "PAPER_TRADESTATION_AUTOMATION_ACCOUNT_ID",
  "PAPER_AUTO_TRADER_ALLOW_ORDER_PLACEMENT",
  "PAPER_AUTO_TRADER_MANAGE_ENTRY_ORDERS",
  "PAPER_AUTO_TRADER_MAX_POSITION_PCT",
  "PAPER_AUTO_TRADER_SCAN_PROMPT",
  "LIVE_TRADESTATION_AUTOMATION_BASE_URL",
  "LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID",
  "LIVE_AUTO_TRADER_ALLOW_ORDER_PLACEMENT",
  "LIVE_AUTO_TRADER_MANAGE_ENTRY_ORDERS",
  "LIVE_AUTO_TRADER_MAX_POSITION_PCT",
  "LIVE_AUTO_TRADER_SCAN_PROMPT",
] as const;

function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("paper trader config defaults to SIM paper mode and 10 percent sizing", () => {
  withEnv({}, () => {
    const config = readPaperTraderConfig();

    assert.equal(config.automationBaseUrl, TRADESTATION_SIM_AUTOMATION_BASE_URL);
    assert.equal(config.tradeStationEnvironment, "sim");
    assert.equal(config.accountMode, "paper");
    assert.equal(config.maxPositionPct, 0.1);
  });
});

test("automation lane parser accepts only paper or live", () => {
  assert.equal(readAutomationLane("paper"), "paper");
  assert.equal(readAutomationLane("LIVE"), "live");
  assert.equal(readAutomationLane("sim"), null);
  assert.equal(readAutomationLane(undefined), null);
});

test("paper trader config reads explicit LIVE lane values", () => {
  withEnv({
    LIVE_TRADESTATION_AUTOMATION_BASE_URL: TRADESTATION_LIVE_AUTOMATION_BASE_URL,
    LIVE_TRADESTATION_AUTOMATION_ACCOUNT_ID: "LIVE123",
    LIVE_AUTO_TRADER_ALLOW_ORDER_PLACEMENT: "1",
    LIVE_AUTO_TRADER_MANAGE_ENTRY_ORDERS: "true",
    LIVE_AUTO_TRADER_MAX_POSITION_PCT: "10",
  }, () => {
    const config = readPaperTraderConfig("live");

    assert.equal(config.automationBaseUrl, TRADESTATION_LIVE_AUTOMATION_BASE_URL);
    assert.equal(config.tradeStationEnvironment, "live");
    assert.equal(config.accountMode, "live");
    assert.equal(config.lane, "live");
    assert.equal(config.accountId, "LIVE123");
    assert.equal(config.allowOrderPlacement, true);
    assert.equal(config.manageEntryOrders, true);
    assert.equal(config.maxPositionPct, 0.1);
  });
});

test("live lane falls back to legacy TradeStation account envs only", () => {
  withEnv({
    TRADESTATION_AUTOMATION_BASE_URL: TRADESTATION_LIVE_AUTOMATION_BASE_URL,
    TRADESTATION_AUTOMATION_ACCOUNT_ID: "LEGACYLIVE123",
    AUTO_TRADER_ALLOW_ORDER_PLACEMENT: "1",
    AUTO_TRADER_MAX_POSITION_PCT: "30",
  }, () => {
    const config = readPaperTraderConfig("live");

    assert.equal(config.automationBaseUrl, TRADESTATION_LIVE_AUTOMATION_BASE_URL);
    assert.equal(config.accountId, "LEGACYLIVE123");
    assert.equal(config.allowOrderPlacement, false);
    assert.equal(config.maxPositionPct, 0.1);
  });
});

test("paper lane does not inherit legacy live automation envs", () => {
  withEnv({
    TRADESTATION_AUTOMATION_BASE_URL: TRADESTATION_LIVE_AUTOMATION_BASE_URL,
    TRADESTATION_AUTOMATION_ACCOUNT_ID: "LEGACYLIVE123",
    AUTO_TRADER_ALLOW_ORDER_PLACEMENT: "1",
    AUTO_TRADER_MAX_POSITION_PCT: "30",
  }, () => {
    const config = readPaperTraderConfig("paper");

    assert.equal(config.automationBaseUrl, TRADESTATION_SIM_AUTOMATION_BASE_URL);
    assert.equal(config.tradeStationEnvironment, "sim");
    assert.equal(config.accountMode, "paper");
    assert.equal(config.accountId, null);
    assert.equal(config.allowOrderPlacement, false);
    assert.equal(config.maxPositionPct, 0.1);
  });
});

test("paper trader config accepts ratio sizing env values", () => {
  withEnv({
    PAPER_AUTO_TRADER_MAX_POSITION_PCT: "0.2",
  }, () => {
    const config = readPaperTraderConfig();

    assert.equal(config.maxPositionPct, 0.2);
  });
});

test("paper trader config rejects unknown TradeStation automation base URLs", () => {
  withEnv({
    PAPER_TRADESTATION_AUTOMATION_BASE_URL: "https://example.com/v3",
  }, () => {
    assert.throws(
      () => readPaperTraderConfig(),
      /PAPER automation base URL must be https:\/\/sim-api\.tradestation\.com\/v3 for PAPER or https:\/\/api\.tradestation\.com\/v3 for LIVE/,
    );
  });
});

test("paper trader config rejects lane/base-url mismatches", () => {
  withEnv({
    PAPER_TRADESTATION_AUTOMATION_BASE_URL: TRADESTATION_LIVE_AUTOMATION_BASE_URL,
  }, () => {
    assert.throws(
      () => readPaperTraderConfig("paper"),
      /PAPER automation must use the SIM TradeStation URL/,
    );
  });
});

test("paper trader config assertion rejects crafted unknown automation base URLs", () => {
  const config: PaperTraderConfig = {
    enabled: true,
    allowOrderPlacement: false,
    manageEntryOrders: false,
    maxOpenTrades: null,
    maxDailyLossUsd: null,
    maxPositionPct: 0.1,
    scanPrompt: "scan",
    apiSecret: null,
    automationBaseUrl: "https://example.com/v3",
    tradeStationEnvironment: "sim",
    accountMode: "paper",
    lane: "paper",
    accountId: "123",
  };

  assert.equal(readTradeStationEnvironment(TRADESTATION_SIM_AUTOMATION_BASE_URL), "sim");
  assert.equal(readTradeStationEnvironment(TRADESTATION_LIVE_AUTOMATION_BASE_URL), "live");
  assert.equal(readTradeStationEnvironment(config.automationBaseUrl), null);
  assert.throws(
    () => assertPaperTraderConfig(config),
    /PAPER automation base URL must be https:\/\/sim-api\.tradestation\.com\/v3 for PAPER or https:\/\/api\.tradestation\.com\/v3 for LIVE/,
  );
});
