/**
 * Value-object builders.
 *
 * `formatted` and `usd` are derivations of `raw` + token decimals + token
 * price. They are computed here at read time and never stored — keeping them
 * out of the database means a price refresh doesn't require a backfill.
 */
import { CuratorMetadata, TokenMetadata } from './config'

export const WAD = 1e18

export interface Money {
    raw: string
    formatted: number
    usd: number | null
}

export function money(
    raw: bigint | string | number | null | undefined,
    decimals: number,
    priceUsd?: number | null,
): Money {
    const value = raw == null ? 0n : BigInt(raw as any)
    const formatted = Number(value) / 10 ** decimals
    return {
        raw: value.toString(),
        formatted,
        usd: priceUsd == null ? null : formatted * priceUsd,
    }
}

/** A WAD-scaled on-chain ratio (lltv, fee, …) as {raw, formatted}. */
export interface Ratio {
    raw: string
    formatted: number
}

export function wadRatio(raw: bigint | string | number | null | undefined): Ratio {
    const value = raw == null ? 0n : BigInt(raw as any)
    return { raw: value.toString(), formatted: Number(value) / WAD }
}

export interface Apy {
    base: number
    rewards: never[]
    total: number
    fee: number
}

/**
 * Reward APRs are not indexed on any of our chains (no distributor is
 * deployed), so `rewards` is always empty and `total` equals `base`. The
 * shape is kept so callers don't have to special-case it if a distributor
 * shows up later.
 */
export function apy(base: number | null | undefined, fee = 0): Apy {
    const b = Number(base ?? 0)
    return { base: b, rewards: [], total: b, fee }
}

export interface TokenView {
    address: string
    symbol: string
    decimals: number
    name: string
    icon: string | null
    category: string | null
    priceUsd: number | null
    chain: { id: number }
}

export function tokenView(
    row: { id: string; symbol: string; decimals: number; name: string; last_price_usd: string | null },
    chainId: number,
    meta: TokenMetadata,
): TokenView {
    return {
        address: row.id,
        symbol: row.symbol,
        decimals: row.decimals,
        name: meta.name ?? row.name,
        icon: meta.icon ?? null,
        category: meta.category ?? null,
        priceUsd: row.last_price_usd == null ? null : Number(row.last_price_usd),
        chain: { id: chainId },
    }
}

export function curatorsView(curators: CuratorMetadata[]) {
    return curators.map(c => ({ name: c.name, image: c.image ?? null, url: c.url ?? null }))
}

/**
 * Derived from LLTV rather than read from `market.liquidation_penalty`.
 *
 * The indexer now populates that column at CreateMarket, but it is only
 * written on market creation — databases indexed before that change still
 * hold zeros for every market, and re-deriving costs nothing. Both paths use
 * the same helper, so the column and this value cannot disagree.
 */
export { liquidationPenaltyFromLltv as liquidationPenalty } from '../utils/morphoMath'

export function utilization(borrowAssets: bigint, supplyAssets: bigint): number {
    if (supplyAssets === 0n) return 0
    return Number(borrowAssets) / Number(supplyAssets)
}

/** Convert a squid millisecond timestamp column to the seconds Morpho uses. */
export function toSeconds(ms: string | number | bigint | null | undefined): number {
    if (ms == null) return 0
    return Math.floor(Number(ms) / 1000)
}

export function num(v: string | number | null | undefined): number {
    return v == null ? 0 : Number(v)
}

export function big(v: string | number | bigint | null | undefined): bigint {
    if (v == null) return 0n
    if (typeof v === 'bigint') return v
    // numeric columns come back as strings; strip any decimal tail postgres added
    return BigInt(String(v).split('.')[0])
}
