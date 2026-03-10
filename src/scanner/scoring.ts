export type ScanDirection = "bullish" | "bearish";
export type ScanConfidence = "65-74" | "75-84" | "85-92" | "93-97";

/**
 * Fake scoring helper for the starter project.
 * Keeps confidence ranges simple and predictable.
 */
export function getFakeConfidence(direction: ScanDirection): ScanConfidence {
  if (direction === "bullish") {
    return "85-92";
  }

  return "75-84";
}
