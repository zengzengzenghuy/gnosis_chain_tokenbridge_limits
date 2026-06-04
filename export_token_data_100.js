// Single-file Omnibridge limits exporter.
//
// For every Gnosis-chain token in the input CSV it:
//   1. Reads the Gnosis Omnibridge limits (dailyLimit, executionDailyLimit,
//      minPerTx, maxPerTx) and the token's decimals.
//   2. Discovers the equivalent token on Ethereum on-chain via the Gnosis
//      Omnibridge registry (`nativeTokenAddress`). Falls back to the CSV's
//      "Address on ETH" column if present; null if the token is Gnosis-native.
//   3. If an Ethereum equivalent exists, reads the Ethereum Omnibridge limits
//      and decimals for it.
//
// Output: token_data_100.csv with one Gnosis row and one Ethereum row per
// token (Ethereum row is all "null" when the token has no Ethereum equivalent).
//
// Usage:
//   node scripts/export_token_data_100.js [inputCsv] [outputCsv]
// Defaults: input = gnosis_top100_tokens.csv, output = scripts/token_data_100.csv
//
// The input CSV is produced manually from Blockscout MCP — see guidance.md.

import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { mainnet, gnosis } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, isAbsolute } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ETH_RPC =
  process.env.MAINNET_JSON_RPC_URL || "https://ethereum.publicnode.com";
const GNO_RPC =
  process.env.GNOSIS_JSON_RPC_URL || "https://rpc.gnosis.gateway.fm";

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC),
});
const gnosisClient = createPublicClient({
  chain: gnosis,
  transport: http(GNO_RPC),
});

// Omnibridge (OmniBridge mediator) addresses
const OMNI_ETH = "0x88ad09518695c6c3712AC10a214bE5109a655671";
const OMNI_GNO = "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const omniAbi = [
  parseAbiItem("function dailyLimit(address token) view returns (uint256)"),
  parseAbiItem(
    "function executionDailyLimit(address token) view returns (uint256)",
  ),
  parseAbiItem("function minPerTx(address token) view returns (uint256)"),
  parseAbiItem("function maxPerTx(address token) view returns (uint256)"),
  // registry getter: bridged (this-chain) token -> native (other-chain) token
  parseAbiItem(
    "function nativeTokenAddress(address bridgedToken) view returns (address)",
  ),
];

const erc20Abi = [parseAbiItem("function decimals() view returns (uint8)")];

const LIMIT_FUNCTIONS = [
  "dailyLimit",
  "executionDailyLimit",
  "minPerTx",
  "maxPerTx",
];

// xDAI bridge: a separate single-asset bridge (xDAI <-> USDS). Its limit getters
// take NO token argument, and its Gnosis side is the native xDAI gas token.
const XDAI_BRIDGE_ETH = "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016";
const XDAI_BRIDGE_GNO = "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6";
const xdaiBridgeAbi = [
  parseAbiItem("function dailyLimit() view returns (uint256)"),
  parseAbiItem("function executionDailyLimit() view returns (uint256)"),
  parseAbiItem("function minPerTx() view returns (uint256)"),
  parseAbiItem("function maxPerTx() view returns (uint256)"),
  // collateral token held on the Ethereum side (currently USDS)
  parseAbiItem("function erc20token() view returns (address)"),
];

// Curated "top 20" ordering (from token_data.csv): these tokens are emitted
// first, in this order. Entries are lowercased Gnosis token addresses, plus the
// "XDAI_BRIDGE" sentinel for the native xDAI <-> USDS bridge. Everything else
// keeps the input-CSV order after these.
const TOP20_ORDER = [
  "0x9c58bacc331c9aa871afd802db6379a98e80cedb", // GNO
  "0x6c76971f98945ae98dd7d4dfca8711ebea946ea6", // wstETH
  "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83", // USDC
  "0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1", // WETH
  "0xeddd81e0792e764501aae206eb432399a0268db5", // TRAC (Trace)
  "0x177127622c4a00f3d409b75571e12cb3c8973d3c", // COW
  "0x8e5bbbb09ed1ebde8674cda39a0c169401db4252", // WBTC
  "0xd057604a14982fe8d88c5fc25aac3267ea142a08", // HOPR
  "0x4ecaba5870353805a9f068101a40e0f32ed605c6", // USDT
  "0x778aa03021b0cd2b798b0b506403e070125d81c9", // BDT
  "0xce11e14225575945b8e6dc0d4f2dd4c570f79d9f", // OLAS
  "0x4d18815d14fe5c3304e87b3fa18318baa5c23820", // SAFE
  "0xc791240d1f2def5938e2031364ff4ed887133c3d", // rETH (Rocket Pool)
  "0x4f4f9b8d5b4d0dc10506e5551b0513b61fd59e75", // GIV (Giveth)
  "0x37b60f4e9a31a64ccc0024dce7d0fd07eaa0f7b3", // PNK
  "0xc9b6218affe8aba68a13899cbf7cf7f14ddd304c", // CLNY
  "0x54e4cb2a4fa0ee46e3d9a98d13bea119666e09f6", // EURC
  "0xe2e73a1c69ecf83f464efce6a5be353a37ca09b2", // LINK
  "0x7ef541e2a22058048904fe5744f9c7e4c57af717", // BAL
  "xdai_bridge", // native xDAI <-> USDS bridge (sentinel)
];

// Priority index for ordering (lower = earlier); non-top-20 -> Infinity.
function priorityOf(key) {
  const i = TOP20_ORDER.indexOf((key || "").toLowerCase());
  return i === -1 ? Infinity : i;
}

// Limit concurrency so the public RPCs don't rate-limit us.
const CONCURRENCY = 3;
const MAX_RETRIES = 8;

// Retry a flaky RPC call with exponential backoff (public nodes drop requests).
async function withRetry(fn, label) {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// CLI args (optional): inputCsv, outputCsv
const [inputArg, outputArg] = process.argv.slice(2);
const INPUT_CSV = resolvePath(
  inputArg,
  join(__dirname, "..", "gnosis_top100_tokens.csv"),
);
const OUTPUT_CSV = resolvePath(
  outputArg,
  join(__dirname, "token_data_100.csv"),
);

function resolvePath(p, fallback) {
  if (!p) return fallback;
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

function isZeroOrEmpty(addr) {
  return !addr || addr.toLowerCase() === ZERO_ADDRESS;
}

// Parse input CSV. Required columns: Name, Symbol, Decimals, Address on GC.
// Optional 5th column "Address on ETH" is used as a fallback only.
function parseTokens() {
  const raw = readFileSync(INPUT_CSV, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const tokens = [];

  for (let i = 1; i < lines.length; i++) {
    // header: Name,Symbol,Decimals,Address on GC[,Address on ETH]
    const cols = lines[i].split(",").map((c) => c.trim());
    const [name, symbol, decimals, gnosisToken, ethereumToken] = cols;
    if (!symbol || isZeroOrEmpty(gnosisToken)) continue;
    tokens.push({
      name,
      symbol,
      decimals: decimals ? parseInt(decimals) : 18,
      gnosisToken,
      ethereumTokenHint: ethereumToken || "", // CSV fallback
    });
  }
  return tokens;
}

async function readDecimals(client, token) {
  try {
    return Number(
      await withRetry(() =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      ),
    );
  } catch {
    return null; // some tokens may not expose decimals() on this chain
  }
}

// Read the four bridge limits plus token decimals for one (chain, token) pair.
async function readChainData(client, bridge, token) {
  if (isZeroOrEmpty(token)) return null;
  const [limits, decimals] = await Promise.all([
    Promise.all(
      LIMIT_FUNCTIONS.map((fn) =>
        withRetry(() =>
          client.readContract({
            address: bridge,
            abi: omniAbi,
            functionName: fn,
            args: [token],
          }),
        ),
      ),
    ),
    readDecimals(client, token),
  ]);
  const [dailyLimit, executionDailyLimit, minPerTx, maxPerTx] = limits;
  return { dailyLimit, executionDailyLimit, minPerTx, maxPerTx, decimals };
}

// Discover the Ethereum equivalent for a Gnosis bridged token via the registry,
// falling back to the CSV hint, then to "" (Gnosis-native).
async function discoverEthAddress(gnosisToken, hint) {
  try {
    const native = await withRetry(() =>
      gnosisClient.readContract({
        address: OMNI_GNO,
        abi: omniAbi,
        functionName: "nativeTokenAddress",
        args: [gnosisToken],
      }),
    );
    if (!isZeroOrEmpty(native)) return native;
  } catch {
    /* registry call failed — fall through to hint */
  }
  return isZeroOrEmpty(hint) ? "" : hint;
}

// Read the xDAI bridge (no-arg limits) on a single chain.
async function readXdaiBridgeLimits(client, bridge) {
  const [dailyLimit, executionDailyLimit, minPerTx, maxPerTx] =
    await Promise.all(
      LIMIT_FUNCTIONS.map((fn) =>
        withRetry(() =>
          client.readContract({
            address: bridge,
            abi: xdaiBridgeAbi,
            functionName: fn,
          }),
        ),
      ),
    );
  return { dailyLimit, executionDailyLimit, minPerTx, maxPerTx };
}

// Build the special xDAI <-> USDS bridge entry. Gnosis side is native xDAI; the
// Ethereum side is the collateral token reported by the bridge (USDS).
async function readXdaiBridge() {
  const [gno, eth, ethToken] = await Promise.all([
    readXdaiBridgeLimits(gnosisClient, XDAI_BRIDGE_GNO),
    readXdaiBridgeLimits(ethereumClient, XDAI_BRIDGE_ETH),
    withRetry(() =>
      ethereumClient.readContract({
        address: XDAI_BRIDGE_ETH,
        abi: xdaiBridgeAbi,
        functionName: "erc20token",
      }),
    ),
  ]);
  console.log("✓ xDAI bridge (xDAI <-> USDS)");
  return {
    gnosisRow: {
      name: "xDAI",
      symbol: "xDAI",
      decimals: 18,
      address: "native",
      data: { ...gno, decimals: 18 },
    },
    ethereumRow: {
      name: "USDS Stablecoin",
      symbol: "USDS",
      decimals: 18,
      address: ethToken,
      data: { ...eth, decimals: 18 },
    },
  };
}

function fmt(value, decimals) {
  if (value === undefined || value === null) return "null";
  return formatUnits(value, decimals ?? 18);
}

function raw(value) {
  if (value === undefined || value === null) return "null";
  return value.toString();
}

// Run async thunks with a bounded number in flight at once.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function collectData() {
  const tokens = parseTokens();
  console.log(`Loaded ${tokens.length} Gnosis tokens from ${INPUT_CSV}\n`);

  const results = await pool(tokens, CONCURRENCY, async (token) => {
    try {
      // Gnosis limits + the discovered Ethereum equivalent, in parallel.
      const [gnosisChainData, ethereumToken] = await Promise.all([
        readChainData(gnosisClient, OMNI_GNO, token.gnosisToken),
        discoverEthAddress(token.gnosisToken, token.ethereumTokenHint),
      ]);
      // Ethereum limits (only if there is an equivalent token).
      const ethereum = await readChainData(
        ethereumClient,
        OMNI_ETH,
        ethereumToken,
      );
      console.log(
        `✓ ${token.symbol}${ethereum ? "" : " (Gnosis-native, no ETH)"}`,
      );
      return { ...token, ethereumToken, gnosis: gnosisChainData, ethereum };
    } catch (error) {
      console.error(`✗ ${token.symbol}:`, error.shortMessage || error.message);
      return { ...token, error: error.shortMessage || error.message };
    }
  });

  const withEth = results.filter((r) => r.ethereum).length;
  console.log(
    `\nProcessed ${results.length} tokens (${withEth} with an Ethereum equivalent).`,
  );

  // The xDAI <-> USDS bridge is separate from the Omnibridge; append it explicitly.
  let xdai = null;
  try {
    xdai = await readXdaiBridge();
  } catch (error) {
    console.error("✗ xDAI bridge:", error.shortMessage || error.message);
  }

  return { results, xdai };
}

function toCsv(results, xdai) {
  const header = [
    "Name",
    "Symbol",
    "Decimals",
    "Chain",
    "Token Address",
    "dailyLimit",
    "executionDailyLimit",
    "minPerTx",
    "maxPerTx",
    "dailyLimit (raw)",
    "executionDailyLimit (raw)",
    "minPerTx (raw)",
    "maxPerTx (raw)",
  ];
  const rows = [header.join(",")];

  // `data` is null when the token has no address on that chain -> all "null".
  const buildRow = (name, symbol, fallbackDecimals, chain, tokenAddr, data) => {
    const decimals = data?.decimals ?? fallbackDecimals;
    return [
      `"${name}"`,
      symbol,
      decimals ?? "null",
      chain,
      tokenAddr || "null",
      fmt(data?.dailyLimit, decimals),
      fmt(data?.executionDailyLimit, decimals),
      fmt(data?.minPerTx, decimals),
      fmt(data?.maxPerTx, decimals),
      raw(data?.dailyLimit),
      raw(data?.executionDailyLimit),
      raw(data?.minPerTx),
      raw(data?.maxPerTx),
    ].join(",");
  };

  // Order entries: curated top-20 first (TOP20_ORDER), then input order. Each
  // entry is either an Omnibridge result or the special xDAI bridge.
  const entries = results.map((r, i) => ({
    kind: "omni",
    r,
    orig: i,
    priority: priorityOf(r.gnosisToken),
  }));
  if (xdai) {
    entries.push({
      kind: "xdai",
      xdai,
      orig: results.length,
      priority: priorityOf("xdai_bridge"),
    });
  }
  entries.sort((a, b) => a.priority - b.priority || a.orig - b.orig);

  for (const e of entries) {
    if (e.kind === "xdai") {
      const g = e.xdai.gnosisRow;
      const x = e.xdai.ethereumRow;
      rows.push(
        buildRow(g.name, g.symbol, g.decimals, "Gnosis", g.address, g.data),
      );
      rows.push(
        buildRow(x.name, x.symbol, x.decimals, "Ethereum", x.address, x.data),
      );
      continue;
    }
    const r = e.r;
    if (r.error) {
      rows.push(
        [
          `"${r.name}"`,
          r.symbol,
          r.decimals,
          "ERROR",
          "",
          `ERROR: ${r.error}`,
        ].join(","),
      );
      continue;
    }
    rows.push(
      buildRow(r.name, r.symbol, r.decimals, "Gnosis", r.gnosisToken, r.gnosis),
    );
    rows.push(
      buildRow(
        r.name,
        r.symbol,
        r.decimals,
        "Ethereum",
        r.ethereumToken,
        r.ethereum,
      ),
    );
  }

  return rows.join("\n") + "\n";
}

collectData()
  .then(({ results, xdai }) => {
    writeFileSync(OUTPUT_CSV, toCsv(results, xdai));
    console.log(`\nExported: ${OUTPUT_CSV}`);
  })
  .catch((error) => {
    console.error("Error exporting token data:", error);
    process.exit(1);
  });
