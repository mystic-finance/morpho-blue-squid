import { DataHandlerContext, BlockHeader } from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import * as chainlinkAbi from '../abi/ChainlinkAggregator'
import * as morphoOracleAbi from '../abi/MorphoOracle'
import { Token } from '../model'
import { withRpcRetry } from './rpc'
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
    /**
     * Per-feed decimals override, for aggregators that don't expose
     * `decimals()` (Flare FTSO among them). Without this we cannot know the
     * scale of the answer, and guessing wrong is off by orders of magnitude.
     */
    feedDecimals?: Record<string, Record<string, number>>
    /** Fallback when a feed exposes no decimals() and has no override. */
    defaultFeedDecimals?: Record<string, number>
}

const CONFIG_PATH = process.env.ORACLE_FEEDS_PATH
    ?? path.resolve(process.cwd(), 'oracle-feeds.json')

const RELOAD_INTERVAL_BLOCKS = 100
let lastConfigLoadBlock = -Infinity
let stablecoins = new Set<string>()
let feeds: Record<string, string> = {}
let feedDecimalOverrides: Record<string, number> = {}
let defaultFeedDecimals: number | undefined

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

        const decMap = config.feedDecimals?.[NETWORK] ?? {}
        feedDecimalOverrides = {}
        for (const [feed, dec] of Object.entries(decMap)) {
            feedDecimalOverrides[feed.toLowerCase()] = Number(dec)
        }
        defaultFeedDecimals = config.defaultFeedDecimals?.[NETWORK]
    } catch (err: any) {
        // File might not exist yet, or be malformed — log once and continue
        if (lastConfigLoadBlock === currentBlock) {
            console.warn(`[prices] Could not load ${CONFIG_PATH}: ${err.message ?? err}`)
        }
    }
}

// ─── Price Cache ─────────────────────────────────────────────────────
// `price: null` is a cached *negative* result — "we looked and could not
// determine a price" — and is deliberately distinct from "not looked up yet".
// Caching the negative keeps a token with no feed from re-hitting RPC on
// every event.
/**
 * Where a resolved price came from. This matters because the `$1` fallback is
 * numerically indistinguishable from a genuine stablecoin price, and anything
 * that multiplies by a price needs to know which one it got.
 */
export type PriceSource = 'stablecoin' | 'feed' | 'db' | 'derived' | 'fallback'

interface CachedPrice {
    price: number
    source: PriceSource
    blockHeight: number
}

// Tokens we've already warned about, so an unpriced token logs once per
// process rather than once per event.
const warnedUnpriced = new Set<string>()
const priceCache = new Map<string, CachedPrice>()
const CACHE_BLOCK_TTL = 100

// ─── Oracle decimals cache (never changes per feed) ──────────────────
const oracleDecimalsCache = new Map<string, number>()

// Last-resort feed scale, used only when a feed exposes no decimals() and
// oracle-feeds.json supplies no override or network default. Kept at 18 to
// preserve the behaviour this file already had; Chainlink USD aggregators are
// conventionally 8, so verify per feed and pin it in config rather than
// relying on this.
const FALLBACK_FEED_DECIMALS = 18

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
        cacheAndPersist(ctx, addr, 1.0, 'stablecoin', height)
        return 1.0
    }

    // 3. On-chain oracle feed
    const feedAddr = feeds[addr]
    if (feedAddr) {
        try {
            const price = await fetchChainlinkPrice(ctx, feedAddr, blockHeader)
            if (price > 0) {
                cacheAndPersist(ctx, addr, price, 'feed', height)
                return price
            }
        } catch (err: any) {
            ctx.log.warn(`Oracle read failed for ${addr} (feed ${feedAddr}): ${err.message ?? err}`)
            // Cache the failure so we don't retry every event for CACHE_BLOCK_TTL
            // blocks. Marked 'fallback': a configured-but-unreadable feed is not
            // a USD price, and must not be used as a denominator.
            priceCache.set(addr, { price: 1, source: 'fallback', blockHeight: height })
        }
    }

    // 4. Fallback to DB
    const token = await ctx.store.get(Token, addr)
    if (token?.lastPriceUSD) {
        const dbPrice = Number(token.lastPriceUSD)
        if (dbPrice > 0) {
            priceCache.set(addr, { price: dbPrice, source: 'db', blockHeight: height })
            return dbPrice
        }
    }

    // 5. Unknown — default to 1, cache to avoid repeated DB lookups.
    //
    // Note this placeholder is NOT persisted to Token.lastPriceUSD: that
    // column stays null, so the gateway reports `usd: null` rather than a
    // fabricated figure. The 1 only keeps the indexer's non-nullable USD
    // columns populated. Warn once per token so a missing feed is visible in
    // the logs instead of silently valuing the asset at one dollar.
    if (!warnedUnpriced.has(addr)) {
        warnedUnpriced.add(addr)
        ctx.log.warn(
            `No USD price for token ${addr} on ${NETWORK} — no stablecoin entry and no ` +
            `feed in oracle-feeds.json. Falling back to $1, so USD figures involving ` +
            `this token are placeholders. Add a feed to fix.`,
        )
    }
    priceCache.set(addr, { price: 1, source: 'fallback', blockHeight: height })
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

    // Get decimals (cached forever — the feed decimals never change).
    //
    // Resolution: explicit override → on-chain decimals() → network default.
    // The scale matters enormously: reading an 8-decimal Chainlink answer as
    // 18 makes the price 1e10x too small. This code previously hardcoded 18
    // in the catch while its comment claimed 8, so the two disagreed and
    // neither was verifiable. The default is now configured per network in
    // oracle-feeds.json and logged when used.
    let feedDecimals = oracleDecimalsCache.get(feedAddress)
    if (feedDecimals === undefined) {
        const override = feedDecimalOverrides[feedAddress.toLowerCase()]
        if (override !== undefined) {
            feedDecimals = override
        } else {
            try {
                feedDecimals = Number(await withRpcRetry(() => contract.decimals()))
            } catch {
                // Some aggregators (Flare FTSO among them) don't expose decimals().
                feedDecimals = defaultFeedDecimals ?? FALLBACK_FEED_DECIMALS
                ctx.log.warn(
                    `Feed ${feedAddress} does not expose decimals(); assuming ${feedDecimals}. ` +
                    `Set feedDecimals["${NETWORK}"]["${feedAddress}"] in oracle-feeds.json to ` +
                    `pin it — the wrong scale skews this token's price by orders of magnitude.`,
                )
            }
        }
        oracleDecimalsCache.set(feedAddress, feedDecimals)
    }

    const { answer } = await withRpcRetry(() => contract.latestRoundData())
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
    source: PriceSource,
    blockHeight: number,
): void {
    priceCache.set(tokenAddress, { price, source, blockHeight })

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

// ─── Market oracle (protocol truth) ──────────────────────────────────
//
// Distinct from the USD feeds above. Every Morpho market carries its own
// oracle returning the price of one collateral unit in loan-asset terms,
// scaled by ORACLE_PRICE_SCALE = 1e36 times 10^(loanDecimals -
// collateralDecimals). That is the number the protocol itself uses for LTV
// and liquidation, so it is exact by definition rather than a display value.
//
// It is also leverage against the manual feed list: given a loan asset's USD
// price (usually a stablecoin, i.e. free), every collateral token in that
// market prices itself with no config entry at all.

const oraclePriceCache = new Map<string, { price: bigint | null; blockHeight: number }>()
const ORACLE_CACHE_BLOCK_TTL = 50

/**
 * Read a market's oracle. Returns null if the oracle reverts — some oracles
 * revert on stale or unset feeds, and that must not stall the batch.
 */
export async function getMarketOraclePrice(
    ctx: DataHandlerContext<Store>,
    oracleAddress: string,
    blockHeader: BlockHeader,
): Promise<bigint | null> {
    const addr = oracleAddress.toLowerCase()
    if (!addr || addr === '0x0000000000000000000000000000000000000000') return null

    const cached = oraclePriceCache.get(addr)
    if (cached && Math.abs(blockHeader.height - cached.blockHeight) < ORACLE_CACHE_BLOCK_TTL) {
        return cached.price
    }

    try {
        const contract = new morphoOracleAbi.Contract(ctx, blockHeader, addr)
        const price = await withRpcRetry(() => contract.price())
        oraclePriceCache.set(addr, { price, blockHeight: blockHeader.height })
        return price
    } catch (err: any) {
        ctx.log.warn(`Market oracle read failed for ${addr}: ${err.message ?? err}`)
        oraclePriceCache.set(addr, { price: null, blockHeight: blockHeader.height })
        return null
    }
}

/**
 * Convert a raw oracle reading into "collateral units per loan unit".
 *
 * The raw value carries 36 + loanDecimals - collateralDecimals decimals, so
 * dividing by that scale yields a plain ratio.
 */
export function normaliseOraclePrice(
    oraclePrice: bigint,
    collateralDecimals: number,
    loanDecimals: number,
): number {
    const scale = 36 + loanDecimals - collateralDecimals
    return Number(oraclePrice) / 10 ** scale
}

/**
 * Derive a collateral token's USD price from the market oracle plus the loan
 * asset's USD price. This is how a market whose collateral has no configured
 * feed still gets a correct valuation — and it agrees with the protocol's own
 * view, so LTVs computed from it match what the contract would compute.
 */
export function collateralPriceFromOracle(
    oraclePrice: bigint,
    collateralDecimals: number,
    loanDecimals: number,
    loanPriceUsd: number,
): number | null {
    if (oraclePrice <= 0n || !(loanPriceUsd > 0)) return null
    const ratio = normaliseOraclePrice(oraclePrice, collateralDecimals, loanDecimals)
    if (!Number.isFinite(ratio) || ratio <= 0) return null
    return ratio * loanPriceUsd
}

/** Persist a derived price onto the Token entity (same path as feed prices). */
export async function persistTokenPrice(
    ctx: DataHandlerContext<Store>,
    tokenAddress: string,
    price: number,
    blockHeight: number,
): Promise<void> {
    const addr = tokenAddress.toLowerCase()
    priceCache.set(addr, { price, source: 'derived', blockHeight })
    const token = await ctx.store.get(Token, addr)
    if (token) {
        token.lastPriceUSD = price as any
        token.lastPriceBlockNumber = BigInt(blockHeight)
        await ctx.store.upsert(token)
    }
}

/** True when the token has an explicit stablecoin entry or configured feed. */
export function hasDirectPriceSource(tokenAddress: string): boolean {
    const addr = tokenAddress.toLowerCase()
    return stablecoins.has(addr) || feeds[addr] !== undefined
}

/**
 * True only when the token's most recently resolved price is genuinely
 * denominated in USD.
 *
 * This is the guard on the oracle derivation. A market oracle gives a ratio in
 * *loan-asset* terms, so `ratio x loanPrice` is a USD price only if loanPrice
 * really is USD. On a market like WFLR/FXRP, FXRP has no feed and resolves to
 * the $1 fallback, which would silently produce "WFLR priced in FXRP" labelled
 * as dollars — a number that looks plausible and is meaningless.
 *
 * Requires both that a real source is configured and that this run actually
 * resolved through it: a configured feed that reverts is not a USD price
 * either. Derived prices are deliberately excluded, so we never chain one
 * derivation off another.
 */
export function isUsdDenominated(tokenAddress: string): boolean {
    const addr = tokenAddress.toLowerCase()
    if (!hasDirectPriceSource(addr)) return false
    const source = priceCache.get(addr)?.source
    return source === 'stablecoin' || source === 'feed' || source === 'db'
}
