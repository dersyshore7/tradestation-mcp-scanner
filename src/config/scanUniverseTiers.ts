export type ScanUniverseTierKey = "tier1" | "tier2" | "tier3" | "tier4";

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

const TIER_4_SYMBOLS = [
  "ADI", "A", "ACGL", "AES", "ALB", "ALK", "ALL", "AME", "AMT", "APH",
  "APTV", "ARE", "ATO", "AWK", "BAX", "BDX", "BEN", "BIIB", "BRO", "BURL",
  "CBOE", "CCEP", "CDW", "CEG", "CFG", "CHD", "CHRW", "CINF", "CLX", "CMA",
  "CMI", "CMS", "COO", "CP", "CTVA", "CTSH", "DD", "DLR", "DOV", "DOW",
  "DPZ", "DRI", "DTE", "EA", "ED", "EFX", "EIX", "EL", "EPAM", "EQR",
  "EQT", "ES", "ESS", "EVRG", "EXC", "EXR", "FANG", "FDS", "FE", "FI",
  "FICO", "FITB", "FIS", "FOXA", "FTV", "GEHC", "GLW", "GM", "GNRC", "GPN",
  "HES", "HIG", "HOLX", "HST", "HWM", "IFF", "INVH", "IR", "J", "JBHT",
  "JBL", "JKHY", "K", "KEY", "KEYS", "KHC", "KIM", "KVUE", "LDOS", "LHX",
  "LVS", "LYB", "MAA", "MAS", "MGM", "MKC", "MKTX", "MLM", "MSCI", "NDAQ",
  "NI", "NTRS", "O", "OMC", "OTIS", "PAYX", "PKG", "PPG", "PRU", "PSA",
  "PWR", "QRVO", "ROL", "ROST", "RSG", "SBAC", "SJM", "SNA", "STT", "SWK",
  "SYF", "TEL", "TROW", "TXT", "VFC", "VTR", "WAB", "WAT", "WBD", "WEC",
  "WELL", "WRB", "WST", "WY", "XYL", "YUM", "ZBH", "ZBRA", "ACHR", "AI",
  "ASTS", "CLSK", "GEV", "HUT", "IBIT", "IONQ", "IOT", "JOBY", "KWEB", "LABD",
  "LABU", "LUNR", "OKLO", "OPEN", "QLD", "RDDT", "RKLB", "SDS", "SMCI", "SOXL",
  "SOXS", "SPXL", "SPXS", "SQQQ", "TNA", "TQQQ", "TZA", "UPRO", "UVXY", "WULF",
  "ARKG", "ARKW", "BITO", "EWA", "EWC", "EWG", "EWH", "EWJ", "EWQ", "EWU",
  "EWY", "EWZ", "FBTC", "INDA", "MCHI",
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
  {
    key: "tier4",
    label: "Tier 4",
    description: "Expanded liquid optionable U.S. names and active ETFs.",
    symbols: uniqueSymbols(TIER_4_SYMBOLS),
  },
] as const;

export const CORE_SCAN_UNIVERSE = SCAN_UNIVERSE_TIERS.find((tier) => tier.key === "tier1")?.symbols ?? [];
export const ALL_SCAN_UNIVERSE = uniqueSymbols(SCAN_UNIVERSE_TIERS.flatMap((tier) => tier.symbols));
export const ALL_SCAN_UNIVERSE_SET = new Set<string>(ALL_SCAN_UNIVERSE);
