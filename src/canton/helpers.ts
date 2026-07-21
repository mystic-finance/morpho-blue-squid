/**
 * Helpers for the Canton main loop. Numeric conversion, APY math, snapshot
 * bucketing, and `getOrCreate*` helpers ported from the EVM processor's
 * patterns in /Users/0xsammy/morpho-blue-squid/src/main.ts.
 */

import { Store } from '@subsquid/typeorm-store'
import { BigDecimal } from '@subsquid/big-decimal'
import { Token } from '../model'

// ─── Time bucketing ─────────────────────────────────────────────────────

const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY  = 86400

/** Epoch-microseconds → epoch-seconds (truncating). */
export function microsToSeconds(micros: bigint): number {
  return Number(micros / 1_000_000n)
}

export function dayIdOf(epochSecs: number): number {
  return Math.floor(epochSecs / SECONDS_PER_DAY)
}

export function hourIdOf(epochSecs: number): number {
  return Math.floor(epochSecs / SECONDS_PER_HOUR)
}

// ─── Numeric 10 decimal-string → bigint ─────────────────────────────────
//
// DAML's `Numeric 10` serializes as a decimal string ("1234.5678900000"),
// always with exactly 10 fractional digits. Multiply by 10^10 and truncate
// to get a bigint in wei-style units (preserves full Numeric 10 precision
// in a representation Postgres can index).

const NUMERIC_SCALE = 10
const SCALE_FACTOR = 10_000_000_000n  // 10^10

export function num10ToBigInt(s: string | undefined | null): bigint {
  if (!s) return 0n
  const [intPart, fracPartRaw = ''] = String(s).split('.')
  // Pad/truncate fractional to exactly 10 digits.
  const fracPart = (fracPartRaw + '0'.repeat(NUMERIC_SCALE)).slice(0, NUMERIC_SCALE)
  return BigInt(intPart) * SCALE_FACTOR + BigInt(fracPart)
}

/** For human-readable display / APY math — Numeric 10 → JS number. */
export function num10ToNumber(s: string | undefined | null): number {
  if (!s) return 0
  return Number(s)  // Numeric 10 fits in a double for our magnitudes
}

// ─── APY computation ────────────────────────────────────────────────────
//
// DAML's `irm.currentRate` is the annualised borrow rate as a Numeric 10
// fraction (1.0 = 100%). Continuous compounding: APY = e^r - 1.
// Supply APY follows the Morpho identity: rate * utilisation * (1 - fee),
// then compounded the same way. Mirrors backend's compute in
// /Users/0xsammy/backend/src/modules/canton/services/canton-cache.service.ts:370-380.

export function computeBorrowAPY(currentRate: string | undefined): BigDecimal {
  const r = num10ToNumber(currentRate)
  if (!isFinite(r) || r === 0) return BigDecimal(0)
  // (e^r - 1) * 100  to express as a percentage
  const apy = (Math.exp(r) - 1) * 100
  return BigDecimal(apy.toFixed(8))  // 8 fractional digits is more than enough for a percent
}

export function computeSupplyAPY(
  currentRate: string | undefined,
  totalSupplyAssets: string | undefined,
  totalBorrowAssets: string | undefined,
  fee: string | undefined,
): BigDecimal {
  const r = num10ToNumber(currentRate)
  if (!isFinite(r) || r === 0) return BigDecimal(0)
  const supply = num10ToNumber(totalSupplyAssets)
  const borrow = num10ToNumber(totalBorrowAssets)
  if (supply <= 0) return BigDecimal(0)
  const utilisation = borrow / supply
  const feeFrac = num10ToNumber(fee)
  const supplyRate = r * utilisation * (1 - feeFrac)
  const apy = (Math.exp(supplyRate) - 1) * 100
  return BigDecimal(apy.toFixed(8))
}

// ─── getOrCreate helpers ────────────────────────────────────────────────

/**
 * Canton tokens: identifier IS the symbol (no on-chain metadata to read
 * like ERC20). We use the same `Token` entity the EVM processor uses, so
 * the GraphQL surface stays uniform.
 *
 * The `Token.id` PK is the instrument id (e.g. "Amulet", "testUSDCx",
 * "CBTC"). The same id may appear with different `admin` parties in DAML
 * but on the FE we display by symbol — we collapse on symbol intentionally.
 */
export async function getOrCreateCantonToken(
  store: Store,
  instrumentId: { id: string; admin?: string },
): Promise<Token> {
  const id = instrumentId.id
  let token = await store.get(Token, id)
  if (!token) {
    token = new Token({
      id,
      name: id,
      symbol: id,
      decimals: cantonDecimalsFor(id),
    })
    await store.upsert(token)
  }
  return token
}

/**
 * Display decimals for Canton tokens, mirrored from
 * /Users/0xsammy/mystic-finance-v2/src/config/cantonTokens.ts. DAML Numeric 10
 * preserves up to 10 fractional digits internally; this is purely a UI hint.
 */
function cantonDecimalsFor(symbol: string): number {
  const m: Record<string, number> = {
    Amulet: 10,
    CC: 10,
    testUSDCx: 6,
    USDCx: 6,
    CBTC: 8,
  }
  return m[symbol] ?? 10
}

// Oracle identity that survives cid churn; matches the DAML's (oracleProvider, pair) binding.
export function oracleKeyOf(provider: string, baseAsset: string, quoteAsset: string): string {
  return `${provider}|${baseAsset}|${quoteAsset}`
}
