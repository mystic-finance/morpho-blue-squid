/**
 * Per-request data access.
 *
 * Every loader here is batched: field resolvers ask for one market / vault /
 * APY window at a time, keys accumulate for the current microtask, and one
 * SQL statement per chain serves the whole batch. Without this, a 250-item
 * page with nested allocations would issue thousands of round trips.
 *
 * Loaders are created fresh per request (see `makeLoaders`) so nothing is
 * cached across requests — the indexer is writing continuously and a stale
 * read would be worse than an extra query.
 */
import { ChainConfig } from './config'
import { query } from './db'

// ─────────────── tiny batching primitive ───────────────

type BatchFn<K, V> = (keys: K[]) => Promise<Map<K, V>>

function createBatcher<K extends string, V>(fn: BatchFn<K, V>) {
    let pending: K[] = []
    let inflight: Promise<Map<K, V>> | null = null

    return (key: K): Promise<V | undefined> => {
        if (!inflight) {
            pending = []
            inflight = new Promise<Map<K, V>>(resolve => {
                queueMicrotask(() => {
                    const keys = [...new Set(pending)]
                    inflight = null
                    resolve(keys.length === 0 ? new Map() : fn(keys))
                })
            })
        }
        pending.push(key)
        return inflight.then(m => m.get(key))
    }
}

/** One batcher per chain, created on first use. */
function perChain<K extends string, V>(make: (chain: ChainConfig) => (key: K) => Promise<V | undefined>) {
    const byChain = new Map<number, (key: K) => Promise<V | undefined>>()
    return (chain: ChainConfig, key: K) => {
        let b = byChain.get(chain.id)
        if (!b) {
            b = make(chain)
            byChain.set(chain.id, b)
        }
        return b(key)
    }
}

// ─────────────── row shapes ───────────────

export interface TokenRow {
    id: string
    name: string
    symbol: string
    decimals: number
    last_price_usd: string | null
}

export interface MarketRow {
    id: string
    name: string
    oracle: string
    irm: string
    lltv: string
    fee: string
    total_supply_assets: string
    total_supply_shares: string
    total_borrow_assets: string
    total_borrow_shares: string
    borrow_apy: string
    supply_apy: string
    oracle_price: string | null
    input_token_id: string | null
    borrowed_token_id: string | null
    loan: TokenRow | null
    collateral: TokenRow | null
}

export interface VaultRow {
    id: string
    name: string
    symbol: string
    fee: string
    fee_recipient: string | null
    total_assets: string
    total_supply: string
    total_assets_usd: string
    apy: string
    owner_id: string | null
    curator_id: string | null
    asset: TokenRow | null
}

export interface AllocationRow {
    vault_id: string
    market_id: string
    cap: string
    enabled: boolean
    /** Vault's LENDER shares in the market. */
    shares: string
    /** shares converted to assets at the market's current exchange rate. */
    assets: string
}

export interface ApyWindows {
    supplyApy1d: number | null
    supplyApy7d: number | null
    supplyApy30d: number | null
    borrowApy1d: number | null
    borrowApy7d: number | null
    borrowApy30d: number | null
}

export interface HistoryBucketRow {
    timestamp: string
    supply_apy_1d: string | null
    supply_apy_7d: string | null
    supply_apy_30d: string | null
    borrow_apy_1d: string | null
    borrow_apy_7d: string | null
    borrow_apy_30d: string | null
    borrow_apy: string | null
    total_supply_assets: string
    total_borrow_assets: string
}

export interface VaultHistoryBucketRow {
    timestamp: string
    apy_1d: string | null
    apy_7d: string | null
    apy_30d: string | null
    total_assets: string
}

const MARKET_SELECT = `
  SELECT m.id, m.name, m.oracle, m.irm, m.lltv, m.fee,
         m.total_supply_assets, m.total_supply_shares,
         m.total_borrow_assets, m.total_borrow_shares,
         m.borrow_apy, m.supply_apy, m.oracle_price,
         m.input_token_id, m.borrowed_token_id,
         lt.id AS l_id, lt.name AS l_name, lt.symbol AS l_symbol,
         lt.decimals AS l_decimals, lt.last_price_usd AS l_price,
         ct.id AS c_id, ct.name AS c_name, ct.symbol AS c_symbol,
         ct.decimals AS c_decimals, ct.last_price_usd AS c_price
  FROM market m
  LEFT JOIN token lt ON lt.id = m.borrowed_token_id
  LEFT JOIN token ct ON ct.id = m.input_token_id
`

function toMarketRow(r: any): MarketRow {
    return {
        ...r,
        loan: r.l_id ? { id: r.l_id, name: r.l_name, symbol: r.l_symbol, decimals: r.l_decimals, last_price_usd: r.l_price } : null,
        collateral: r.c_id ? { id: r.c_id, name: r.c_name, symbol: r.c_symbol, decimals: r.c_decimals, last_price_usd: r.c_price } : null,
    }
}

const VAULT_SELECT = `
  SELECT v.id, v.name, v.symbol, v.fee, v.fee_recipient,
         v.total_assets, v.total_supply, v.total_assets_usd, v.apy,
         v.owner_id, v.curator_id,
         t.id AS a_id, t.name AS a_name, t.symbol AS a_symbol,
         t.decimals AS a_decimals, t.last_price_usd AS a_price
  FROM meta_morpho v
  LEFT JOIN token t ON t.id = v.asset_id
`

function toVaultRow(r: any): VaultRow {
    return {
        ...r,
        asset: r.a_id ? { id: r.a_id, name: r.a_name, symbol: r.a_symbol, decimals: r.a_decimals, last_price_usd: r.a_price } : null,
    }
}

const DAY_MS = 86_400_000

// ─────────────── page queries (entry points) ───────────────

export async function pageMarkets(chain: ChainConfig, marketIds: string[] | null, limit: number): Promise<MarketRow[]> {
    const rows = await query(chain, `
      ${MARKET_SELECT}
      WHERE ($1::text[] IS NULL OR lower(m.id) = ANY($1))
      ORDER BY m.total_supply_assets DESC
      LIMIT $2
    `, [marketIds, limit])
    return rows.map(toMarketRow)
}

export async function pageVaults(chain: ChainConfig, vaultAddresses: string[] | null, limit: number): Promise<VaultRow[]> {
    const rows = await query(chain, `
      ${VAULT_SELECT}
      WHERE ($1::text[] IS NULL OR lower(v.id) = ANY($1))
      ORDER BY v.total_assets DESC
      LIMIT $2
    `, [vaultAddresses, limit])
    return rows.map(toVaultRow)
}

export interface VaultPositionRow {
    vault_id: string
    account_id: string
    shares: string
    assets: string
}

export async function pageVaultPositions(
    chain: ChainConfig,
    vaultAddresses: string[] | null,
    accounts: string[] | null,
    limit: number,
): Promise<VaultPositionRow[]> {
    return query(chain, `
      SELECT p.vault_id, p.account_id, p.shares, p.assets
      FROM meta_morpho_position p
      WHERE ($1::text[] IS NULL OR lower(p.vault_id) = ANY($1))
        AND ($2::text[] IS NULL OR lower(p.account_id) = ANY($2))
        AND p.shares > 0
      ORDER BY p.assets DESC
      LIMIT $3
    `, [vaultAddresses, accounts, limit])
}

export interface MarketPositionRow {
    market_id: string
    account_id: string
    collateral: string
    borrow_shares: string
}

/**
 * Morpho exposes one position per (market, account); the indexer stores one
 * row per side. Fold the sides back together here.
 */
export async function pageMarketPositions(
    chain: ChainConfig,
    marketIds: string[] | null,
    accounts: string[] | null,
    limit: number,
): Promise<MarketPositionRow[]> {
    return query(chain, `
      SELECT p.market_id, p.account_id,
             COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'COLLATERAL'), 0) AS collateral,
             COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'BORROWER'), 0)   AS borrow_shares
      FROM position p
      WHERE ($1::text[] IS NULL OR lower(p.market_id) = ANY($1))
        AND ($2::text[] IS NULL OR lower(p.account_id) = ANY($2))
        AND p.side IN ('COLLATERAL', 'BORROWER')
      GROUP BY p.market_id, p.account_id
      HAVING COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'COLLATERAL'), 0) > 0
          OR COALESCE(SUM(p.balance) FILTER (WHERE p.side = 'BORROWER'), 0) > 0
      LIMIT $3
    `, [marketIds, accounts, limit])
}

// ─────────────── history (per entity, not batched) ───────────────

const HISTORY_LIMIT = Number(process.env.GATEWAY_HISTORY_LIMIT ?? 1000)

/**
 * Rolling-average APYs are computed in-database with window frames over the
 * bucket sequence: 24/168/720 hourly buckets, or 1/7/30 daily ones. Frames
 * run over the market's full history and only the tail is returned, so the
 * earliest rows returned still have correct trailing averages.
 */
function historySql(table: string, bucketCol: string, w1: number, w7: number, w30: number) {
    const avg = (col: string, n: number) =>
        `AVG(${col}) OVER (ORDER BY ${bucketCol} ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW)`
    return `
      SELECT * FROM (
        SELECT s.timestamp, s.${bucketCol}, s.total_supply_assets, s.total_borrow_assets, s.borrow_apy,
               ${avg('s.supply_apy', w1)}  AS supply_apy_1d,
               ${avg('s.supply_apy', w7)}  AS supply_apy_7d,
               ${avg('s.supply_apy', w30)} AS supply_apy_30d,
               ${avg('s.borrow_apy', w1)}  AS borrow_apy_1d,
               ${avg('s.borrow_apy', w7)}  AS borrow_apy_7d,
               ${avg('s.borrow_apy', w30)} AS borrow_apy_30d
        FROM ${table} s
        WHERE s.market_id = $1
      ) x
      ORDER BY x.${bucketCol} DESC
      LIMIT $2
    `
}

export async function marketHistory(
    chain: ChainConfig,
    marketId: string,
    granularity: 'daily' | 'hourly',
): Promise<HistoryBucketRow[]> {
    const sql = granularity === 'hourly'
        ? historySql('market_hourly_snapshot', 'hour_id', 24, 168, 720)
        : historySql('market_daily_snapshot', 'day_id', 1, 7, 30)
    const rows = await query<any>(chain, sql, [marketId, HISTORY_LIMIT])
    return rows.reverse()
}

function vaultHistorySql(table: string, bucketCol: string, w1: number, w7: number, w30: number) {
    const avg = (n: number) =>
        `AVG(s.apy) OVER (ORDER BY ${bucketCol} ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW)`
    return `
      SELECT * FROM (
        SELECT s.timestamp, s.${bucketCol}, s.total_assets,
               ${avg(w1)}  AS apy_1d,
               ${avg(w7)}  AS apy_7d,
               ${avg(w30)} AS apy_30d
        FROM ${table} s
        WHERE s.vault_id = $1
      ) x
      ORDER BY x.${bucketCol} DESC
      LIMIT $2
    `
}

export async function vaultHistory(
    chain: ChainConfig,
    vaultId: string,
    granularity: 'daily' | 'hourly',
): Promise<VaultHistoryBucketRow[]> {
    const sql = granularity === 'hourly'
        ? vaultHistorySql('meta_morpho_hourly_snapshot', 'hour_id', 24, 168, 720)
        : vaultHistorySql('meta_morpho_daily_snapshot', 'day_id', 1, 7, 30)
    const rows = await query<any>(chain, sql, [vaultId, HISTORY_LIMIT])
    return rows.reverse()
}

// ─────────────── loaders ───────────────

export interface Loaders {
    market(chain: ChainConfig, id: string): Promise<MarketRow | undefined>
    vault(chain: ChainConfig, id: string): Promise<VaultRow | undefined>
    marketApy(chain: ChainConfig, id: string): Promise<ApyWindows | undefined>
    vaultApy(chain: ChainConfig, id: string): Promise<ApyWindows | undefined>
    sharedLiquidity(chain: ChainConfig, marketId: string): Promise<string | undefined>
    allocationsByVault(chain: ChainConfig, vaultId: string): Promise<AllocationRow[] | undefined>
    allocationsByMarket(chain: ChainConfig, marketId: string): Promise<AllocationRow[] | undefined>
}

export function makeLoaders(now = Date.now()): Loaders {
    const market = perChain<string, MarketRow>(chain => createBatcher(async ids => {
        const rows = await query<any>(chain, `${MARKET_SELECT} WHERE lower(m.id) = ANY($1)`, [ids])
        return new Map(rows.map(r => [r.id.toLowerCase(), toMarketRow(r)]))
    }))

    const vault = perChain<string, VaultRow>(chain => createBatcher(async ids => {
        const rows = await query<any>(chain, `${VAULT_SELECT} WHERE lower(v.id) = ANY($1)`, [ids])
        return new Map(rows.map(r => [r.id.toLowerCase(), toVaultRow(r)]))
    }))

    /**
     * Trailing APY averages, taken over hourly snapshots. Averaging buckets
     * rather than integrating exactly is a deliberate simplification: the
     * indexer writes a snapshot on every AccrueInterest, so buckets are dense
     * where rates move and sparse where they don't.
     */
    const marketApy = perChain<string, ApyWindows>(chain => createBatcher(async ids => {
        const rows = await query<any>(chain, `
          SELECT market_id,
                 AVG(supply_apy) FILTER (WHERE timestamp >= $2) AS s1,
                 AVG(supply_apy) FILTER (WHERE timestamp >= $3) AS s7,
                 AVG(supply_apy) AS s30,
                 AVG(borrow_apy) FILTER (WHERE timestamp >= $2) AS b1,
                 AVG(borrow_apy) FILTER (WHERE timestamp >= $3) AS b7,
                 AVG(borrow_apy) AS b30
          FROM market_hourly_snapshot
          WHERE lower(market_id) = ANY($1) AND timestamp >= $4
          GROUP BY market_id
        `, [ids, now - DAY_MS, now - 7 * DAY_MS, now - 30 * DAY_MS])
        return new Map(rows.map(r => [r.market_id.toLowerCase(), {
            supplyApy1d: r.s1 == null ? null : Number(r.s1),
            supplyApy7d: r.s7 == null ? null : Number(r.s7),
            supplyApy30d: r.s30 == null ? null : Number(r.s30),
            borrowApy1d: r.b1 == null ? null : Number(r.b1),
            borrowApy7d: r.b7 == null ? null : Number(r.b7),
            borrowApy30d: r.b30 == null ? null : Number(r.b30),
        }]))
    }))

    const vaultApy = perChain<string, ApyWindows>(chain => createBatcher(async ids => {
        const rows = await query<any>(chain, `
          SELECT vault_id,
                 AVG(apy) FILTER (WHERE timestamp >= $2) AS s1,
                 AVG(apy) FILTER (WHERE timestamp >= $3) AS s7,
                 AVG(apy) AS s30
          FROM meta_morpho_hourly_snapshot
          WHERE lower(vault_id) = ANY($1) AND timestamp >= $4
          GROUP BY vault_id
        `, [ids, now - DAY_MS, now - 7 * DAY_MS, now - 30 * DAY_MS])
        return new Map(rows.map(r => [r.vault_id.toLowerCase(), {
            supplyApy1d: r.s1 == null ? null : Number(r.s1),
            supplyApy7d: r.s7 == null ? null : Number(r.s7),
            supplyApy30d: r.s30 == null ? null : Number(r.s30),
            borrowApy1d: null, borrowApy7d: null, borrowApy30d: null,
        }]))
    }))

    /**
     * A market's shared liquidity is what the PublicAllocator could actually
     * move today: per vault, the smaller of its remaining outflow cap and the
     * assets it currently has in that market.
     *
     * The table only exists on databases migrated past the flow-cap change,
     * and only fills on chains with PUBLIC_ALLOCATOR_ADDRESS set — a missing
     * table degrades to zero rather than failing the query.
     */
    const sharedLiquidity = perChain<string, string>(chain => createBatcher(async ids => {
        try {
            const rows = await query<any>(chain, `
              SELECT fc.market_id,
                     SUM(LEAST(
                       fc.max_out::numeric,
                       CASE WHEN m.total_supply_shares > 0
                            THEN p.balance::numeric * m.total_supply_assets::numeric / m.total_supply_shares::numeric
                            ELSE 0 END
                     )) AS shared
              FROM public_allocator_flow_cap fc
              JOIN market m ON m.id = fc.market_id
              LEFT JOIN position p
                     ON p.account_id = fc.vault_id AND p.market_id = fc.market_id AND p.side = 'LENDER'
              WHERE lower(fc.market_id) = ANY($1)
              GROUP BY fc.market_id
            `, [ids])
            return new Map(rows.map(r => [
                r.market_id.toLowerCase(),
                String(r.shared ?? '0').split('.')[0],
            ]))
        } catch (err: any) {
            if (err.code !== '42P01') throw err // 42P01 = undefined_table
            console.warn(`[gateway] ${chain.key}: public_allocator_flow_cap missing — reporting zero shared liquidity`)
            return new Map()
        }
    }))

    const ALLOCATION_SELECT = `
      SELECT a.vault_id, a.market_id, a.cap, a.enabled,
             COALESCE(p.balance, 0)::text AS shares,
             (CASE WHEN m.total_supply_shares > 0
                   THEN COALESCE(p.balance, 0)::numeric * m.total_supply_assets::numeric / m.total_supply_shares::numeric
                   ELSE 0 END)::numeric(78,0)::text AS assets
      FROM meta_morpho_market_allocation a
      JOIN market m ON m.id = a.market_id
      LEFT JOIN position p
             ON p.account_id = a.vault_id AND p.market_id = a.market_id AND p.side = 'LENDER'
    `

    const groupBy = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
        const m = new Map<string, T[]>()
        for (const r of rows) {
            const k = key(r)
            const list = m.get(k)
            if (list) list.push(r)
            else m.set(k, [r])
        }
        return m
    }

    const allocationsByVault = perChain<string, AllocationRow[]>(chain => createBatcher(async ids => {
        const rows = await query<AllocationRow>(chain, `${ALLOCATION_SELECT} WHERE lower(a.vault_id) = ANY($1)`, [ids])
        return groupBy(rows, r => r.vault_id.toLowerCase())
    }))

    const allocationsByMarket = perChain<string, AllocationRow[]>(chain => createBatcher(async ids => {
        const rows = await query<AllocationRow>(chain, `${ALLOCATION_SELECT} WHERE lower(a.market_id) = ANY($1)`, [ids])
        return groupBy(rows, r => r.market_id.toLowerCase())
    }))

    return {
        market: (c, id) => market(c, id.toLowerCase()),
        vault: (c, id) => vault(c, id.toLowerCase()),
        marketApy: (c, id) => marketApy(c, id.toLowerCase()),
        vaultApy: (c, id) => vaultApy(c, id.toLowerCase()),
        sharedLiquidity: (c, id) => sharedLiquidity(c, id.toLowerCase()),
        allocationsByVault: (c, id) => allocationsByVault(c, id.toLowerCase()),
        allocationsByMarket: (c, id) => allocationsByMarket(c, id.toLowerCase()),
    }
}
