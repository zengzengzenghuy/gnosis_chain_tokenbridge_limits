# Omnibridge Token Limits Export — How to Run

This exports the OmniBridge daily/per-tx limits for the top ~100 Gnosis-chain
tokens on **both** Gnosis and Ethereum into a single CSV.

It is a two-part flow:

1. **Build the token list** (`gnosis_top100_tokens.csv`) — done once via the
   **Blockscout MCP** (cannot run inside a Node script, see Step 1).
2. **Query the bridges** — done by the single script
   `scripts/export_token_data_100.js` (Step 2).

The script handles everything else automatically: it reads the Gnosis limits,
**discovers the equivalent Ethereum token on-chain** (via the OmniBridge
`nativeTokenAddress` registry — no need to fill in the ETH column yourself),
then reads the Ethereum limits. Tokens that are Gnosis-native (no Ethereum
origin) get `null` for the Ethereum row.

---

## Prerequisites

```bash
yarn install            # installs viem
```

Optional — set your own RPCs (defaults to public nodes if unset):

```bash
export GNOSIS_JSON_RPC_URL="https://rpc.gnosischain.com"
export MAINNET_JSON_RPC_URL="https://ethereum.publicnode.com"
```

---

## Step 1 — Build the token list with Blockscout MCP (manual)

The MCP runs inside Claude/your MCP client, not inside the script, so do this
step there and save the result as `gnosis_top100_tokens.csv` in the repo root.

Ask the agent (or call the MCP directly) to fetch the top Gnosis tokens:

> Using the Blockscout MCP `direct_api_call` tool on Gnosis (chain_id `100`),
> call endpoint `/api/v2/tokens?type=ERC-20` and paginate until you have ~100
> tokens. For each, capture **name, symbol, decimals, and contract address**.

Then have it write `gnosis_top100_tokens.csv` with this header:

```csv
Name,Symbol,Decimals,Address on GC,Address on ETH
```

Notes:

- Only the first **4 columns are required**. `Address on ETH` can be left blank —
  the script discovers it on-chain. (If you do fill it, it's used only as a
  fallback when the on-chain registry lookup returns nothing.)
- The repo already ships a populated `gnosis_top100_tokens.csv`; you only need
  Step 1 to refresh the list.

---

## Step 2 — Run the export script

From the **repo root**:

```bash
node scripts/export_token_data_100.js
```

Optional arguments — custom input/output paths:

```bash
node scripts/export_token_data_100.js <inputCsv> <outputCsv>
# default input:  gnosis_top100_tokens.csv
# default output: scripts/token_data_100.csv
```

You'll see a `✓ SYMBOL` line per token (Gnosis-native tokens are marked
`no ETH`), then a summary and the output path.

---

## Output — `scripts/token_data_100.csv`

Two rows per token (one `Gnosis`, one `Ethereum`). Columns:

| Column                                                      | Meaning                                               |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `Name`, `Symbol`, `Decimals`                                | token metadata (decimals read on-chain)               |
| `Chain`                                                     | `Gnosis` or `Ethereum`                                |
| `Token Address`                                             | token address on that chain (`null` if no equivalent) |
| `dailyLimit`, `executionDailyLimit`, `minPerTx`, `maxPerTx` | human-readable (scaled by decimals)                   |
| `…(raw)`                                                    | same values as raw `uint256` (smallest units)         |

The `Ethereum` row is all `null` when the token has no Ethereum equivalent.

---

## How it works (reference)

- **OmniBridge mediators**
  - Ethereum: `0x88ad09518695c6c3712AC10a214bE5109a655671`
  - Gnosis: `0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d`
- **Limit getters** (per token): `dailyLimit`, `executionDailyLimit`,
  `minPerTx`, `maxPerTx`.
- **ETH-equivalent discovery**: `nativeTokenAddress(gnosisToken)` on the Gnosis
  mediator returns the Ethereum origin token (or zero for Gnosis-native tokens).
- **Resilience**: bounded concurrency (4) + exponential-backoff retries so
  public RPCs don't drop requests.
