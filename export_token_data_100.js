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

const ETH_RPC = process.env.MAINNET_JSON_RPC_URL || "https://ethereum.publicnode.com";
const GNO_RPC = process.env.GNOSIS_JSON_RPC_URL || "https://rpc.gnosis.gateway.fm";

const ethereumClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
const gnosisClient = createPublicClient({ chain: gnosis, transport: http(GNO_RPC) });

// Omnibridge (OmniBridge mediator) addresses
const OMNI_ETH = "0x88ad09518695c6c3712AC10a214bE5109a655671";
const OMNI_GNO = "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const omniAbi = [
  parseAbiItem("function dailyLimit(address token) view returns (uint256)"),
  parseAbiItem("function executionDailyLimit(address token) view returns (uint256)"),
  parseAbiItem("function minPerTx(address token) view returns (uint256)"),
  parseAbiItem("function maxPerTx(address token) view returns (uint256)"),
  // registry getter: bridged (this-chain) token -> native (other-chain) token
  parseAbiItem("function nativeTokenAddress(address bridgedToken) view returns (address)"),
];

const erc20Abi = [parseAbiItem("function decimals() view returns (uint8)")];

const LIMIT_FUNCTIONS = ["dailyLimit", "executionDailyLimit", "minPerTx", "maxPerTx"];

// Limit concurrency so the public RPCs don't rate-limit us.
const CONCURRENCY = 4;
const MAX_RETRIES = 6;

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
const INPUT_CSV = resolvePath(inputArg, join(__dirname, "..", "gnosis_top100_tokens.csv"));
const OUTPUT_CSV = resolvePath(outputArg, join(__dirname, "token_data_100.csv"));

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
        client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
      )
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
          client.readContract({ address: bridge, abi: omniAbi, functionName: fn, args: [token] })
        )
      )
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
      })
    );
    if (!isZeroOrEmpty(native)) return native;
  } catch {
    /* registry call failed — fall through to hint */
  }
  return isZeroOrEmpty(hint) ? "" : hint;
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
      const ethereum = await readChainData(ethereumClient, OMNI_ETH, ethereumToken);
      console.log(`✓ ${token.symbol}${ethereum ? "" : " (Gnosis-native, no ETH)"}`);
      return { ...token, ethereumToken, gnosis: gnosisChainData, ethereum };
    } catch (error) {
      console.error(`✗ ${token.symbol}:`, error.shortMessage || error.message);
      return { ...token, error: error.shortMessage || error.message };
    }
  });

  const withEth = results.filter((r) => r.ethereum).length;
  console.log(`\nProcessed ${results.length} tokens (${withEth} with an Ethereum equivalent).`);
  return results;
}

function toCsv(results) {
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
  const rowFor = (r, chain, tokenAddr, data) => {
    const decimals = data?.decimals ?? r.decimals;
    return [
      `"${r.name}"`,
      r.symbol,
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

  for (const r of results) {
    if (r.error) {
      rows.push([`"${r.name}"`, r.symbol, r.decimals, "ERROR", "", `ERROR: ${r.error}`].join(","));
      continue;
    }
    rows.push(rowFor(r, "Gnosis", r.gnosisToken, r.gnosis));
    rows.push(rowFor(r, "Ethereum", r.ethereumToken, r.ethereum));
  }

  return rows.join("\n") + "\n";
}

collectData()
  .then((results) => {
    writeFileSync(OUTPUT_CSV, toCsv(results));
    console.log(`\nExported: ${OUTPUT_CSV}`);
  })
  .catch((error) => {
    console.error("Error exporting token data:", error);
    process.exit(1);
  });
