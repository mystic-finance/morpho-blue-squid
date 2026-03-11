import { DataHandlerContext, BlockHeader } from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import * as chainlinkAbi from '../abi/ChainlinkAggregator'
import { Token } from '../model'
import * as fs from 'fs'
import * as path from 'path'

// ─── Network Detection ──────────────────────────────────────────────
const NETWORK = (process.env.NETWORK ?? 'UNKNOWN').toUpperCase()

// ─── Dynamic Oracle Config ──────────────────────────────────────────
// Reads oracle-feeds.json from the project root. The file is re-read
// every RELOAD_INTERVAL_BLOCKS blocks, so you can add new token→feed
// mappings while the indexer is running — no restart required.
//
// File format:
// {
//   "stablecoins": { "FLARE": ["0xusdc...", "0xusdt..."], "PLUME": [...] },
//   "feeds":       { "FLARE": { "0xtoken": "0xfeed", ... }, "PLUME": { ... } }
// }

interface OracleConfig {
    stablecoins: Record<string, string[]>
    feeds: Record<string, Record<string, string>>
}

const CONFIG_PATH = process.env.ORACLE_FEEDS_PATH
    ?? path.resolve(process.cwd(), 'oracle-feeds.json')

const RELOAD_INTERVAL_BLOCKS = 100
let lastConfigLoadBlock = -Infinity
let stablecoins = new Set<string>()
let feeds: Record<string, string> = {}

function loadConfig(currentBlock: number): void {
    if (currentBlock - lastConfigLoadBlock < RELOAD_INTERVAL_BLOCKS) return
    lastConfigLoadBlock = currentBlock

    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
        const config: OracleConfig = JSON.parse(raw)

        // Stablecoins for this network
        const stableList = config.stablecoins?.[NETWORK] ?? []
        stablecoins = new Set(stableList.map(a => a.toLowerCase()))

        // Oracle feeds for this network
        const feedMap = config.feeds?.[NETWORK] ?? {}
        feeds = {}
        for (const [token, feed] of Object.entries(feedMap)) {
            feeds[token.toLowerCase()] = feed.toLowerCase()
        }
    } catch (err: any) {
        // File might not exist yet, or be malformed — log once and continue
        if (lastConfigLoadBlock === currentBlock) {
            console.warn(`[prices] Could not load ${CONFIG_PATH}: ${err.message ?? err}`)
        }
    }
}

// ─── Price Cache ─────────────────────────────────────────────────────
interface CachedPrice {
    price: number
    blockHeight: number
}
const priceCache = new Map<string, CachedPrice>()
const CACHE_BLOCK_TTL = 100

// ─── Oracle decimals cache (never changes per feed) ──────────────────
const oracleDecimalsCache = new Map<string, number>()

/**
 * Get the USD price for a token via on-chain oracle.
 *
 * Resolution order:
 *  1. In-memory cache (if within CACHE_BLOCK_TTL blocks)
 *  2. Stablecoin check → $1.00
 *  3. Chainlink AggregatorV3 `latestRoundData()` via the feed in oracle-feeds.json
 *  4. Fallback to Token.lastPriceUSD from the database
 *  5. Returns 1 if truly unknown (conservative default)
 *
 * Failed oracle reads are cached with the fallback price to avoid
 * repeated slow RPC timeouts that stall the indexer.
 */
export async function getTokenPriceInUsd(
    ctx: DataHandlerContext<Store>,
    tokenAddress: string,
    blockHeader: BlockHeader,
): Promise<number> {
    const addr = tokenAddress.toLowerCase()
    const height = blockHeader.height

    // Hot-reload config from disk if stale
    loadConfig(height)

    // 1. Check cache (covers both successful AND failed lookups)
    const cached = priceCache.get(addr)
    if (cached && Math.abs(height - cached.blockHeight) < CACHE_BLOCK_TTL) {
        return cached.price
    }

    // 2. Stablecoins
    if (stablecoins.has(addr)) {
        cacheAndPersist(ctx, addr, 1.0, height)
        return 1.0
    }

    // 3. On-chain oracle feed
    const feedAddr = feeds[addr]
    if (feedAddr) {
        try {
            const price = await fetchChainlinkPrice(ctx, feedAddr, blockHeader)
            if (price > 0) {
                cacheAndPersist(ctx, addr, price, height)
                return price
            }
        } catch (err: any) {
            ctx.log.warn(`Oracle read failed for ${addr} (feed ${feedAddr}): ${err.message ?? err}`)
            // Cache the failure so we don't retry every event for CACHE_BLOCK_TTL blocks
            priceCache.set(addr, { price: 1, blockHeight: height })
        }
    }

    // 4. Fallback to DB
    const token = await ctx.store.get(Token, addr)
    if (token?.lastPriceUSD) {
        const dbPrice = Number(token.lastPriceUSD)
        if (dbPrice > 0) {
            priceCache.set(addr, { price: dbPrice, blockHeight: height })
            return dbPrice
        }
    }

    // 5. Unknown — default to 1, cache to avoid repeated DB lookups
    priceCache.set(addr, { price: 1, blockHeight: height })
    return 1
}

/**
 * Read USD price from a Chainlink AggregatorV3-compatible feed.
 */
async function fetchChainlinkPrice(
    ctx: DataHandlerContext<Store>,
    feedAddress: string,
    blockHeader: BlockHeader,
): Promise<number> {
    const contract = new chainlinkAbi.Contract(ctx, blockHeader, feedAddress)

    // Get decimals (cached forever — the feed decimals never change)
    let feedDecimals = oracleDecimalsCache.get(feedAddress)
    if (feedDecimals === undefined) {
        try {
            feedDecimals = Number(await contract.decimals())
        } catch {
            // Some oracles (e.g. Flare FTSO) don't expose decimals() — default to 8
            feedDecimals = 18
        }
        oracleDecimalsCache.set(feedAddress, feedDecimals)
    }

    const { answer } = await contract.latestRoundData()
    if (answer <= 0n) return 0

    return Number(answer) / (10 ** feedDecimals)
}

/**
 * Cache the price in memory and persist to the Token entity.
 */
function cacheAndPersist(
    ctx: DataHandlerContext<Store>,
    tokenAddress: string,
    price: number,
    blockHeight: number,
): void {
    priceCache.set(tokenAddress, { price, blockHeight })

    // Fire-and-forget DB update (non-blocking)
    ctx.store.get(Token, tokenAddress).then(token => {
        if (token) {
            token.lastPriceUSD = price as any
            token.lastPriceBlockNumber = BigInt(blockHeight)
            ctx.store.upsert(token).catch(() => { /* swallow */ })
        }
    }).catch(() => { /* swallow */ })
}

/**
 * Compute USD value: amount / 10^decimals * price.
 */
export function calcUSD(amount: bigint, decimals: number, price: number): number {
    return (Number(amount) / (10 ** decimals)) * price
}
