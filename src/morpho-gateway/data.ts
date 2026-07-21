/**
 * Morpho-shaped data access.
 *
 * Reuses the row shapes and SELECT joins from src/gateway/data (same tables,
 * same columns) but adds the pagination Morpho's API uses — offset/limit via
 * first/skip, an explicit orderBy, and a countTotal — which the other gateway
 * (cursor-free, single ORDER BY) does not express.
 *
 * A window `COUNT(*) OVER ()` rides along on every page query so the total is a
 * single round trip: the count is on each returned row, and 0 rows means 0.
 */
import { ChainConfig } from '../gateway/config'
import { query } from '../gateway/db'
import {
    MARKET_SELECT, VAULT_SELECT, toMarketRow, toVaultRow,
    MarketRow, VaultRow, TokenRow, MarketPositionRow, VaultPositionRow,
} from '../gateway/data'

const DEFAULT_FIRST = 100
const MAX_FIRST = 1000

function clampFirst(first?: number | null): number {
    if (first == null) return DEFAULT_FIRST
    return Math.max(1, Math.min(MAX_FIRST, first))
}

function dir(orderDirection?: string | null): 'ASC' | 'DESC' {
    return String(orderDirection).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
}

/** Accumulates parameterised WHERE conditions with correct $n numbering. */
class Where {
    private conds: string[] = []
    readonly params: any[] = []

    /** Add `sql` referencing the next positional param bound to `value`. */
    add(sqlTemplate: (p: string) => string, value: any) {
        if (value === undefined || value === null) return
        this.params.push(value)
        this.conds.push(sqlTemplate(`$${this.params.length}`))
    }

    /** Add a raw condition with no parameter. */
    raw(sql: string) {
        this.conds.push(sql)
    }

    clause(): string {
        return this.conds.length ? `WHERE ${this.conds.join(' AND ')}` : ''
    }

    /** Positional index the next appended param would take. */
    next(): string {
        return `$${this.params.length + 1}`
    }
}

const lower = (v?: string[] | null): string[] | null =>
    v && v.length > 0 ? v.map(s => s.toLowerCase()) : null

export interface Page<T> {
    rows: T[]
    countTotal: number
}

function countOf(rows: any[]): number {
    return rows.length > 0 ? Number(rows[0].count_total) : 0
}

// ─────────────── vaults ───────────────

// Values are output-column names (or expressions) of the inner select, so the
// outer ORDER BY can reference them directly with no table qualifier.
const VAULT_ORDER: Record<string, string> = {
    Address: 'id', TotalAssets: 'total_assets', TotalAssetsUsd: 'total_assets_usd',
    TotalSupply: 'total_supply', Fee: 'fee', Apy: 'apy', NetApy: 'apy', Name: 'name',
}

export async function pageVaults(
    chain: ChainConfig, where: any, orderBy: string | null, orderDirection: string | null,
    first: number | null, skip: number | null,
): Promise<Page<VaultRow>> {
    const w = new Where()
    w.add(p => `lower(v.id) = ANY(${p})`, lower(where?.address_in))
    w.add(p => `NOT (lower(v.id) = ANY(${p}))`, lower(where?.address_not_in))
    w.add(p => `lower(v.owner_id) = ANY(${p})`, lower(where?.ownerAddress_in))
    w.add(p => `lower(v.curator_id) = ANY(${p})`, lower(where?.curatorAddress_in))
    w.add(p => `v.symbol = ANY(${p})`, where?.symbol_in ?? null)
    w.add(p => `lower(v.asset_id) = ANY(${p})`, lower(where?.assetAddress_in))
    w.add(p => `v.apy >= ${p}`, where?.apy_gte)
    w.add(p => `v.apy <= ${p}`, where?.apy_lte)
    w.add(p => `(v.fee::numeric / 1e18) >= ${p}`, where?.fee_gte)
    w.add(p => `(v.fee::numeric / 1e18) <= ${p}`, where?.fee_lte)
    w.add(p => `v.total_assets::numeric >= ${p}`, where?.totalAssets_gte)
    w.add(p => `v.total_assets::numeric <= ${p}`, where?.totalAssets_lte)
    w.add(p => `v.total_assets_usd >= ${p}`, where?.totalAssetsUsd_gte)
    w.add(p => `v.total_assets_usd <= ${p}`, where?.totalAssetsUsd_lte)
    w.add(p => `v.total_supply::numeric >= ${p}`, where?.totalSupply_gte)
    w.add(p => `v.total_supply::numeric <= ${p}`, where?.totalSupply_lte)
    // Everything indexed is treated as listed; `listed: false` selects nothing.
    // `featured` and `search` are accepted for schema parity but not filtered on.
    if (where?.listed === false) w.raw('1 = 0')

    const col = VAULT_ORDER[orderBy ?? ''] ?? 'total_assets_usd'
    const limit = clampFirst(first)
    const offset = Math.max(0, skip ?? 0)
    const rows = await query<any>(chain, `
      SELECT sub.*, COUNT(*) OVER () AS count_total FROM (
        ${VAULT_SELECT}
        ${w.clause()}
      ) sub
      ORDER BY ${col} ${dir(orderDirection)} NULLS LAST
      LIMIT ${w.next()} OFFSET ${dollarAfter(w, 1)}
    `, [...w.params, limit, offset])
    return { rows: rows.map(toVaultRow), countTotal: countOf(rows) }
}

// ─────────────── markets ───────────────

// Output-column names / expressions of the inner select (see VAULT_ORDER note).
const MARKET_ORDER: Record<string, string> = {
    UniqueKey: 'id', Lltv: 'lltv', BorrowAssets: 'total_borrow_assets', BorrowAssetsUsd: 'total_borrow_assets',
    SupplyAssets: 'total_supply_assets', SupplyAssetsUsd: 'total_supply_assets', SizeUsd: 'total_supply_assets',
    BorrowShares: 'total_borrow_shares', SupplyShares: 'total_supply_shares',
    SupplyApy: 'supply_apy', BorrowApy: 'borrow_apy', Fee: 'fee',
    TotalLiquidityUsd: '(total_supply_assets - total_borrow_assets)',
    Utilization: '(CASE WHEN total_supply_assets > 0 THEN total_borrow_assets::numeric / total_supply_assets::numeric ELSE 0 END)',
}

export async function pageMarkets(
    chain: ChainConfig, where: any, orderBy: string | null, orderDirection: string | null,
    first: number | null, skip: number | null,
): Promise<Page<MarketRow>> {
    const ZERO = '0x0000000000000000000000000000000000000000'
    const w = new Where()
    w.add(p => `lower(m.id) = ANY(${p})`, lower(where?.uniqueKey_in))
    w.add(p => `lower(m.input_token_id) = ANY(${p})`, lower(where?.collateralAssetAddress_in))
    w.add(p => `lower(m.borrowed_token_id) = ANY(${p})`, lower(where?.loanAssetAddress_in))
    w.add(p => `lower(m.irm) = ANY(${p})`, lower(where?.irmAddress_in))
    w.add(p => `m.lltv::numeric >= ${p}`, where?.lltv_gte)
    w.add(p => `m.lltv::numeric <= ${p}`, where?.lltv_lte)
    w.add(p => `m.total_borrow_assets::numeric >= ${p}`, where?.borrowAssets_gte)
    w.add(p => `m.total_borrow_assets::numeric <= ${p}`, where?.borrowAssets_lte)
    w.add(p => `m.total_supply_assets::numeric >= ${p}`, where?.supplyAssets_gte)
    w.add(p => `m.total_supply_assets::numeric <= ${p}`, where?.supplyAssets_lte)
    w.add(p => `m.supply_apy >= ${p}`, where?.supplyApy_gte)
    w.add(p => `m.supply_apy <= ${p}`, where?.supplyApy_lte)
    w.add(p => `m.borrow_apy >= ${p}`, where?.borrowApy_gte)
    w.add(p => `m.borrow_apy <= ${p}`, where?.borrowApy_lte)
    w.add(p => `(m.fee::numeric / 1e18) >= ${p}`, where?.fee_gte)
    w.add(p => `(m.fee::numeric / 1e18) <= ${p}`, where?.fee_lte)
    if (where?.isIdle === true) w.raw(`(m.input_token_id IS NULL OR lower(m.input_token_id) = '${ZERO}')`)
    if (where?.isIdle === false) w.raw(`(m.input_token_id IS NOT NULL AND lower(m.input_token_id) <> '${ZERO}')`)
    // Everything indexed is treated as listed; `listed: false` selects nothing.
    if (where?.listed === false) w.raw('1 = 0')

    const col = MARKET_ORDER[orderBy ?? ''] ?? 'total_supply_assets'
    const limit = clampFirst(first)
    const offset = Math.max(0, skip ?? 0)
    const rows = await query<any>(chain, `
      SELECT sub.*, COUNT(*) OVER () AS count_total FROM (
        ${MARKET_SELECT}
        ${w.clause()}
      ) sub
      ORDER BY ${col} ${dir(orderDirection)} NULLS LAST
      LIMIT ${w.next()} OFFSET ${dollarAfter(w, 1)}
    `, [...w.params, limit, offset])
    return { rows: rows.map(toMarketRow), countTotal: countOf(rows) }
}

export async function marketById(chain: ChainConfig, marketId: string): Promise<MarketRow | null> {
    const rows = await query<any>(chain, `${MARKET_SELECT} WHERE lower(m.id) = $1`, [marketId.toLowerCase()])
    return rows[0] ? toMarketRow(rows[0]) : null
}

export async function vaultByAddress(chain: ChainConfig, address: string): Promise<VaultRow | null> {
    const rows = await query<any>(chain, `${VAULT_SELECT} WHERE lower(v.id) = $1`, [address.toLowerCase()])
    return rows[0] ? toVaultRow(rows[0]) : null
}

// ─────────────── assets (token table) ───────────────

const TOKEN_SELECT = `SELECT id, name, symbol, decimals, last_price_usd FROM token`

export async function pageAssets(
    chain: ChainConfig, where: any, first: number | null, skip: number | null,
): Promise<Page<TokenRow>> {
    const w = new Where()
    w.add(p => `lower(id) = ANY(${p})`, lower(where?.address_in))
    w.add(p => `symbol = ANY(${p})`, where?.symbol_in ?? null)

    const limit = clampFirst(first)
    const offset = Math.max(0, skip ?? 0)
    const rows = await query<any>(chain, `
      SELECT sub.*, COUNT(*) OVER () AS count_total FROM (
        ${TOKEN_SELECT}
        ${w.clause()}
      ) sub
      ORDER BY sub.id ASC
      LIMIT ${w.next()} OFFSET ${dollarAfter(w, 1)}
    `, [...w.params, limit, offset])
    return { rows: rows as TokenRow[], countTotal: countOf(rows) }
}

export async function assetByAddress(chain: ChainConfig, address: string): Promise<TokenRow | null> {
    const rows = await query<any>(chain, `${TOKEN_SELECT} WHERE lower(id) = $1`, [address.toLowerCase()])
    return rows[0] ?? null
}

// ─────────────── positions ───────────────

export async function pageVaultPositions(
    chain: ChainConfig, where: any, orderDirection: string | null,
    first: number | null, skip: number | null,
): Promise<Page<VaultPositionRow>> {
    const w = new Where()
    w.raw('p.shares > 0')
    w.add(p => `lower(p.vault_id) = ANY(${p})`, lower(where?.vaultAddress_in))
    w.add(p => `lower(p.account_id) = ANY(${p})`, lower(where?.userAddress_in))
    w.add(p => `p.shares::numeric >= ${p}`, where?.shares_gte)
    w.add(p => `p.shares::numeric <= ${p}`, where?.shares_lte)

    const limit = clampFirst(first)
    const offset = Math.max(0, skip ?? 0)
    const rows = await query<any>(chain, `
      SELECT p.vault_id, p.account_id, p.shares, p.assets, COUNT(*) OVER () AS count_total
      FROM meta_morpho_position p
      ${w.clause()}
      ORDER BY p.shares ${dir(orderDirection)}
      LIMIT ${w.next()} OFFSET ${dollarAfter(w, 1)}
    `, [...w.params, limit, offset])
    return { rows: rows as VaultPositionRow[], countTotal: countOf(rows) }
}

const MARKET_POSITION_ORDER: Record<string, string> = {
    Collateral: 'collateral', BorrowShares: 'borrow_assets', SupplyShares: 'collateral',
}

export async function pageMarketPositions(
    chain: ChainConfig, where: any, orderBy: string | null, orderDirection: string | null,
    first: number | null, skip: number | null,
): Promise<Page<MarketPositionRow>> {
    // Filter the raw position rows first, then fold the per-side balances into
    // one row per (market, account) — mirrors src/gateway's market-position query.
    const w = new Where()
    w.raw(`p.side IN ('COLLATERAL', 'BORROWER')`)
    w.add(p => `lower(p.market_id) = ANY(${p})`, lower(where?.marketUniqueKey_in))
    w.add(p => `lower(p.account_id) = ANY(${p})`, lower(where?.userAddress_in))

    const having = new Where()
    having.raw(`(COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'COLLATERAL'), 0) > 0
             OR COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'BORROWER'), 0) > 0)`)

    const col = MARKET_POSITION_ORDER[orderBy ?? ''] ?? 'collateral'
    const limit = clampFirst(first)
    const offset = Math.max(0, skip ?? 0)
    const params = [...w.params]
    const limitP = `$${params.length + 1}`
    const offsetP = `$${params.length + 2}`
    const rows = await query<any>(chain, `
      SELECT *, COUNT(*) OVER () AS count_total FROM (
        SELECT p.market_id, p.account_id,
               COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'COLLATERAL'), 0) AS collateral,
               COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'BORROWER'), 0)   AS borrow_assets
        FROM position p
        ${w.clause()}
        GROUP BY p.market_id, p.account_id
        HAVING ${having.clause().replace(/^WHERE /, '')}
      ) folded
      ORDER BY folded.${col} ${dir(orderDirection)}
      LIMIT ${limitP} OFFSET ${offsetP}
    `, [...params, limit, offset])
    return { rows: rows as MarketPositionRow[], countTotal: countOf(rows) }
}

/**
 * Positional index of the param `after` slots past the current WHERE params —
 * used to number the trailing LIMIT/OFFSET placeholders after the WHERE ones.
 */
function dollarAfter(w: Where, after: number): string {
    return `$${w.params.length + 1 + after}`
}
