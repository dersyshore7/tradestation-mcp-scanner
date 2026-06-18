import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ALL_SCAN_UNIVERSE, SCAN_UNIVERSE_TIERS } from "./scanUniverseTiers.js";

test("expanded scan universe stays unique, uppercase, and within the medium target size", () => {
  assert.equal(SCAN_UNIVERSE_TIERS[0]?.symbols.length, 101);
  assert.equal(SCAN_UNIVERSE_TIERS[1]?.symbols.length, 98);
  assert.equal(SCAN_UNIVERSE_TIERS[2]?.symbols.length, 139);
  assert.equal(SCAN_UNIVERSE_TIERS[3]?.key, "tier4");
  assert.equal(SCAN_UNIVERSE_TIERS[3]?.symbols.length, 185);
  assert.ok(ALL_SCAN_UNIVERSE.length >= 500);
  assert.ok(ALL_SCAN_UNIVERSE.length <= 525);
  assert.equal(new Set(ALL_SCAN_UNIVERSE).size, ALL_SCAN_UNIVERSE.length);
  assert.deepEqual(
    ALL_SCAN_UNIVERSE.filter((symbol) => !/^[A-Z]+$/.test(symbol)),
    [],
  );
});

test("manual and original process scan wording uses dynamic configured tiers", () => {
  const manualScanSource = readFileSync(new URL("../../api/manual-scan.ts", import.meta.url), "utf8");
  const originalProcessSource = readFileSync(new URL("../app/originalProcess.ts", import.meta.url), "utf8");

  assert.equal(manualScanSource.includes("Tier 1, Tier 2, and Tier 3"), false);
  assert.equal(originalProcessSource.includes("Tier 1, Tier 2, and Tier 3"), false);
  assert.ok(manualScanSource.includes("scanUniverseLabel()"));
  assert.ok(originalProcessSource.includes("scanUniverseLabel()"));
});
