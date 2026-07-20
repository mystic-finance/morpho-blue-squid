/**
 * One connection pool per configured chain, created lazily and reused.
 *
 * The gateway only ever reads. It deliberately does not go through TypeORM /
 * the squid store: those are shaped around the indexer's write path, and the
 * gateway's queries are joins and window functions that are clearer as SQL.
 */
import { Pool, QueryResultRow } from 'pg'
import { ChainConfig, loadConfig } from './config'

const pools = new Map<number, Pool>()

export function poolFor(chain: ChainConfig): Pool {
    let pool = pools.get(chain.id)
    if (!pool) {
        pool = new Pool({
            host: chain.db.host,
            port: chain.db.port,
            database: chain.db.database,
            user: chain.db.user,
            password: chain.db.password,
            ssl: chain.db.ssl ? { rejectUnauthorized: false } : undefined,
            max: Number(process.env.GATEWAY_DB_POOL_SIZE ?? 8),
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        })
        pool.on('error', err => {
            console.error(`[gateway] idle pg client error on ${chain.key}:`, err.message)
        })
        pools.set(chain.id, pool)
    }
    return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
    chain: ChainConfig,
    sql: string,
    params: unknown[] = [],
): Promise<T[]> {
    const res = await poolFor(chain).query<T>(sql, params)
    return res.rows
}

/**
 * Run the same logical query across several chains concurrently. A chain that
 * errors (down DB, missing table) is logged and yields no rows rather than
 * failing the whole request — a partial answer beats a 500 when the caller
 * asked for four chains and one is mid-migration.
 */
export async function queryChains<T>(
    chains: ChainConfig[],
    fn: (chain: ChainConfig) => Promise<T[]>,
): Promise<T[]> {
    const settled = await Promise.allSettled(chains.map(fn))
    const out: T[] = []
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') out.push(...r.value)
        else console.error(`[gateway] chain ${chains[i].key} query failed:`, r.reason?.message ?? r.reason)
    })
    return out
}

export async function closePools(): Promise<void> {
    await Promise.all([...pools.values()].map(p => p.end().catch(() => undefined)))
    pools.clear()
}

/** Fail fast at boot if a configured chain is unreachable. */
export async function checkConnections(): Promise<void> {
    for (const chain of loadConfig().chains) {
        try {
            await query(chain, 'SELECT 1')
            console.log(`[gateway] connected to ${chain.key} (chainId ${chain.id}) @ ${chain.db.host}/${chain.db.database}`)
        } catch (err: any) {
            console.warn(`[gateway] WARNING: ${chain.key} unreachable — ${err.message}`)
        }
    }
}
