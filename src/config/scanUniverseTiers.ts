export type ScanUniverseTierKey = "tier1" | "tier2" | "tier3";

export type ScanUniverseTier = {
  key: ScanUniverseTierKey;
  label: string;
  description: string;
  symbols: readonly string[];
};

const TIER_1_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "NFLX", "ADBE",
  "CRM", "ORCL", "AVGO", "QCOM", "INTC", "CSCO", "IBM", "NOW", "JPM", "BAC",
  "WFC", "C", "GS", "MS", "BLK", "UNH", "JNJ", "LLY", "MRK", "ABBV",
  "PFE", "TMO", "XOM", "CVX", "COP", "SLB", "EOG", "OXY", "WMT", "COST",
  "HD", "LOW", "MCD", "SBUX", "NKE", "DIS", "CMG", "BKNG", "CAT", "DE",
  "GE", "RTX", "HON", "UPS", "UNP", "QQQ", "SPY", "IWM", "XLF", "SMH",
  "IYR", "XLE", "XLI", "XLK", "XLV", "XLP", "XLY", "XLC", "XBI", "XLU",
  "GDX", "TLT", "ARKK", "DIA", "VXX", "SPOT", "UBER", "ABNB", "SHOP", "SNOW",
  "PLTR", "PYPL", "SQ", "COIN", "ROKU", "PANW", "CRWD", "ZS", "FTNT", "MU",
  "TXN", "AMAT", "LRCX", "KLAC", "MRVL", "ANET", "ADSK", "INTU", "AXP", "V", "MA",
] as const;

const TIER_2_SYMBOLS = [
  "AMGN", "ISRG", "GILD", "REGN", "VRTX", "MDT", "SYK", "BSX", "CNC", "CI",
  "SCHW", "BK", "USB", "PNC", "TFC", "AIG", "MET", "AFL", "TRV", "CB",
  "MMC", "ICE", "CME", "SPGI", "MCO", "COF", "DFS", "AON", "AJG", "PGR",
  "LIN", "APD", "ECL", "SHW", "NEM", "FCX", "NUE", "STLD", "AA", "MOS",
  "LEN", "DHI", "PHM", "TOL", "NVR", "APO", "KKR", "BX", "KKR", "ARES",
  "ETN", "PH", "EMR", "ROK", "ITW", "TT", "JCI", "CARR", "FAST", "PCAR",
  "LULU", "TJX", "TGT", "DG", "DLTR", "BBY", "ORLY", "AZO", "TSCO", "ULTA",
  "MDLZ", "MNST", "KO", "PEP", "KDP", "CL", "PG", "KMB", "GIS", "HSY",
  "BA", "LMT", "NOC", "GD", "TDG", "DAL", "UAL", "AAL", "UAL", "CSX",
  "NSC", "CPRT", "ODFL", "FDX", "RCL", "CCL", "MAR", "HLT", "EXPE", "WYNN",
] as const;

const TIER_3_SYMBOLS = [
  "DASH", "NET", "DDOG", "MDB", "TEAM", "HUBS", "DOCU", "TWLO", "ESTC", "OKTA",
  "SNPS", "CDNS", "WDAY", "PAYC", "VEEV", "TTD", "APP", "RBLX", "HOOD", "AFRM",
  "UPST", "SOFI", "U", "PATH", "BILL", "ARM", "TEM", "MSTR", "RIOT", "MARA",
  "CVNA", "CAR", "LYFT", "ETSY", "PINS", "WIX", "EBAY", "CHWY", "KMX", "DKNG",
  "PDD", "BABA", "BIDU", "JD", "NIO", "XPEV", "LI", "RIVN", "LCID", "HIMS",
  "ALGN", "ILMN", "IQV", "ZTS", "BMY", "DHR", "EW", "IDXX", "RMD", "MTD",
  "MCK", "COR", "CAH", "HCA", "ELV", "HUM", "CVS", "MOH", "DGX", "LH",
  "FSLR", "ENPH", "SEDG", "RUN", "NEE", "DUK", "SO", "AEP", "D", "VST",
  "PSX", "MPC", "VLO", "KMI", "WMB", "OKE", "HAL", "BKR", "DVN", "MRO",
  "XLB", "XRT", "KRE", "IYT", "IBB", "SOXX", "IGV", "XHB", "XOP", "USO",
  "UNG", "SLV", "GLD", "EEM", "FXI", "HYG", "LQD", "EFA", "XME", "ITB",
  "TLRY", "ACB", "BYND", "CAVA", "SHAK", "WING", "PSTG", "DELL", "HPQ", "NTAP",
  "ON", "MPWR", "SWKS", "TER", "ENTG", "COHR", "OLED", "STM", "ASML", "MCHP",
  "ADM", "BG", "CF", "FMC", "DECK", "ANF", "GME", "NCLH", "VST", "TECK",
] as const;

function uniqueSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols)];
}

export const SCAN_UNIVERSE_TIERS: readonly ScanUniverseTier[] = [
  {
    key: "tier1",
    label: "Tier 1",
    description: "Current core universe of liquid optionable leaders and key ETFs.",
    symbols: uniqueSymbols(TIER_1_SYMBOLS),
  },
  {
    key: "tier2",
    label: "Tier 2",
    description: "Second universe of highly liquid U.S. optionable names.",
    symbols: uniqueSymbols(TIER_2_SYMBOLS),
  },
  {
    key: "tier3",
    label: "Tier 3",
    description: "Broader still-liquid optionable names and ETFs.",
    symbols: uniqueSymbols(TIER_3_SYMBOLS),
  },
] as const;

export const CORE_SCAN_UNIVERSE = SCAN_UNIVERSE_TIERS.find((tier) => tier.key === "tier1")?.symbols ?? [];
export const ALL_SCAN_UNIVERSE = uniqueSymbols(SCAN_UNIVERSE_TIERS.flatMap((tier) => tier.symbols));
export const ALL_SCAN_UNIVERSE_SET = new Set<string>(ALL_SCAN_UNIVERSE);
