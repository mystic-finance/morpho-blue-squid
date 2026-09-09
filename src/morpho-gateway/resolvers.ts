/**
 * Resolvers mapping indexed rows onto the Morpho blue-api shape.
 *
 * Every source object carries its ChainConfig alongside the row — the same
 * pattern as src/gateway — because an id is only meaningful next to the chain
 * whose database it came from, and this endpoint serves several.
 *
 * USD amounts and share-price ratios are derived here from the token's decimals
 * and last indexed price; they are never stored. Fields the indexer has no
 * source for are returned as documented neutrals (see typeDefs).
 */
import { GraphQLScalarType } from 'graphql'
import { ChainConfig, loadConfig, resolveChains, getChain, tokenMetadata } from '../gateway/config'
import { queryChains } from '../gateway/db'
import {
    Loaders, MarketRow, VaultRow, VaultV2Row, TokenRow, AllocationRow,
    MarketPositionRow, VaultPositionRow, VaultV2PositionRow,
} from '../gateway/data'
import { num, big, WAD, utilization } from '../gateway/format'
import {
    pageVaults, pageMarkets, pageAssets, pageVaultPositions, pageMarketPositions,
    marketById, vaultByAddress, assetByAddress,
    pageVaultV2s, vaultV2ByAddress, vaultV2Position,
} from './data'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface GatewayContext {
    loaders: Loaders
}

interface MarketSource { chain: ChainConfig; row: MarketRow }
interface VaultSource { chain: ChainConfig; row: VaultRow }
interface AssetSource { chain: ChainConfig; token: TokenRow }
interface AllocationSource { chain: ChainConfig; alloc: AllocationRow }
interface MarketPositionSource { chain: ChainConfig; row: MarketPositionRow }
interface VaultPositionSource { chain: ChainConfig; row: VaultPositionRow }
interface VaultV2Source { chain: ChainConfig; row: VaultV2Row }
interface VaultV2PositionSource { chain: ChainConfig; row: VaultV2PositionRow }

// ─────────────── scalars ───────────────

const passthrough = (name: string, parse: (v: unknown) => unknown = v => v) =>
    new GraphQLScalarType({
        name,
        serialize: v => (typeof v === 'bigint' ? v.toString() : v),
        parseValue: parse,
        parseLiteral: ast => parse((ast as any).value),
    })

export const scalarResolvers = {
    BigInt: passthrough('BigInt', v => String(v)),
    Address: passthrough('Address', v => String(v)),
    MarketId: passthrough('MarketId', v => String(v)),
}

// ─────────────── views / helpers ───────────────

const chainView = (c: ChainConfig) => ({
    id: c.id,
    network: (c.key ?? '').toLowerCase(),
    currency: '',
    blockTimeMs: null,
    headBlock: null,
})

const assetView = (chain: ChainConfig, token: TokenRow): AssetSource => ({ chain, token })

/** USD value of a raw token amount. Null when the token has no indexed price. */
function usd(raw: bigint | string | null | undefined, token: TokenRow | null | undefined): number | null {
    if (!token || token.last_price_usd == null) return null
    return (Number(big(raw)) / 10 ** token.decimals) * Number(token.last_price_usd)
}

function paginate<T>(items: T[], countTotal: number, first: number | null, skip: number | null) {
    return {
        items,
        pageInfo: {
            countTotal,
            count: items.length,
            limit: first ?? 100,
            skip: skip ?? 0,
        },
    }
}

/**
 * Run a per-chain page query across the requested chains and merge. first/skip
 * are applied per chain in SQL; for a single-chain request (the common Morpho
 * call, scoped by chainId_in) this is exact. Across several chains the items
 * concatenate and countTotal sums — global ordering across chains is not
 * re-applied.
 */
async function pageAcross<R>(
    chainIds: number[] | null | undefined,
    run: (chain: ChainConfig) => Promise<{ rows: R[]; countTotal: number }>,
) {
    const chains = resolveChains(chainIds)
    let countTotal = 0
    const items = await queryChains(chains, async chain => {
        const { rows, countTotal: c } = await run(chain)
        countTotal += c
        return rows.map(row => ({ chain, row }))
    })
    return { items, countTotal }
}

// ─────────────── resolvers ───────────────

export const resolvers = {
    ...scalarResolvers,

    Query: {
        chains: () => loadConfig().chains.map(chainView),

        async vaults(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageVaults(chain, args.where, args.orderBy, args.orderDirection, args.first, args.skip))
            return paginate(items, countTotal, args.first, args.skip)
        },

        async vaultByAddress(_: unknown, args: any) {
            const chain = args.chainId != null ? getChain(args.chainId) : undefined
            const chains = chain ? [chain] : loadConfig().chains
            for (const c of chains) {
                const row = await vaultByAddress(c, String(args.address))
                if (row) return { chain: c, row }
            }
            throw new Error(`Vault ${args.address} not found${args.chainId != null ? ` on chain ${args.chainId}` : ''}`)
        },

        async markets(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageMarkets(chain, args.where, args.orderBy, args.orderDirection, args.first, args.skip))
            return paginate(items, countTotal, args.first, args.skip)
        },

        async marketById(_: unknown, args: any) {
            const chain = getChain(args.chainId)
            if (!chain) throw new Error(`Unknown chainId ${args.chainId}`)
            const row = await marketById(chain, String(args.marketId))
            if (!row) throw new Error(`Market ${args.marketId} not found on chain ${args.chainId}`)
            return { chain, row }
        },

        async vaultV2s(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageVaultV2s(chain, args.where, args.orderBy, args.orderDirection, args.first, args.skip))
            return paginate(items, countTotal, args.first, args.skip)
        },

        async vaultV2ByAddress(_: unknown, args: any) {
            const chain = getChain(args.chainId)
            if (!chain) throw new Error(`Unknown chainId ${args.chainId}`)
            const row = await vaultV2ByAddress(chain, String(args.address))
            if (!row) throw new Error(`VaultV2 ${args.address} not found on chain ${args.chainId}`)
            return { chain, row }
        },

        async vaultV2PositionByAddress(_: unknown, args: any) {
            const chain = getChain(args.chainId)
            if (!chain) throw new Error(`Unknown chainId ${args.chainId}`)
            const row = await vaultV2Position(chain, String(args.vaultAddress), String(args.userAddress))
            if (!row) {
                throw new Error(
                    `No VaultV2 position for ${args.userAddress} in ${args.vaultAddress} on chain ${args.chainId}`,
                )
            }
            return { chain, row }
        },

        async assets(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageAssets(chain, args.where, args.first, args.skip))
            return paginate(
                items.map((it: any) => assetView(it.chain, it.row)),
                countTotal, args.first, args.skip,
            )
        },

        async assetByAddress(_: unknown, args: any) {
            const chain = args.chainId != null ? getChain(args.chainId) : undefined
            const chains = chain ? [chain] : loadConfig().chains
            for (const c of chains) {
                const token = await assetByAddress(c, String(args.address))
                if (token) return assetView(c, token)
            }
            throw new Error(`Asset ${args.address} not found${args.chainId != null ? ` on chain ${args.chainId}` : ''}`)
        },

        async vaultPositions(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageVaultPositions(chain, args.where, args.orderDirection, args.first, args.skip))
            return paginate(items, countTotal, args.first, args.skip)
        },

        async marketPositions(_: unknown, args: any) {
            const { items, countTotal } = await pageAcross(args.where?.chainId_in, chain =>
                pageMarketPositions(chain, args.where, args.orderBy, args.orderDirection, args.first, args.skip))
            return paginate(items, countTotal, args.first, args.skip)
        },
    },

    // ─────────────── Chain / Block ───────────────

    Chain: {
        headBlock: () => null,
    },

    // ─────────────── Asset ───────────────

    Asset: {
        chain: (s: AssetSource) => chainView(s.chain),
        id: (s: AssetSource) => s.token.id,
        address: (s: AssetSource) => s.token.id,
        decimals: (s: AssetSource) => s.token.decimals,
        name: (s: AssetSource) => tokenMetadata(s.chain.id, s.token.id).name ?? s.token.name,
        symbol: (s: AssetSource) => s.token.symbol,
        tags: () => null,
        logoURI: (s: AssetSource) => tokenMetadata(s.chain.id, s.token.id).icon ?? null,
        isListed: () => true,
        price: (s: AssetSource) =>
            s.token.last_price_usd == null ? null : { usd: Number(s.token.last_price_usd), timestamp: '0' },
    },

    // ─────────────── Vault ───────────────

    Vault: {
        chain: (s: VaultSource) => chainView(s.chain),
        address: (s: VaultSource) => s.row.id,
        symbol: (s: VaultSource) => s.row.symbol,
        name: (s: VaultSource) => s.row.name,
        creationBlockNumber: () => 0,
        creationTimestamp: () => '0',
        creatorAddress: () => null,
        listed: () => true,
        asset: (s: VaultSource) => s.row.asset ? assetView(s.chain, s.row.asset) : null,
        state: (s: VaultSource) => s,
    },

    VaultState: {
        blockNumber: () => '0',
        totalAssets: (s: VaultSource) => big(s.row.total_assets).toString(),
        totalAssetsUsd: (s: VaultSource) => num(s.row.total_assets_usd),
        totalSupply: (s: VaultSource) => big(s.row.total_supply).toString(),
        apy: (s: VaultSource) => num(s.row.apy),
        netApy: (s: VaultSource) => num(s.row.apy) * (1 - num(s.row.fee) / WAD),
        netApyExcludingRewards: (s: VaultSource) => num(s.row.apy) * (1 - num(s.row.fee) / WAD),
        timestamp: () => '0',
        sharePriceNumber: (s: VaultSource) => {
            const supply = big(s.row.total_supply)
            return supply === 0n ? null : Number(big(s.row.total_assets)) / Number(supply)
        },
        sharePriceUsd: () => null,
        fee: (s: VaultSource) => num(s.row.fee) / WAD,
        curator: (s: VaultSource) => s.row.curator_id ?? ZERO_ADDRESS,
        feeRecipient: (s: VaultSource) => s.row.fee_recipient ?? ZERO_ADDRESS,
        guardian: (s: VaultSource) => s.row.guardian ?? ZERO_ADDRESS,
        owner: (s: VaultSource) => s.row.owner_id ?? ZERO_ADDRESS,
        skimRecipient: () => ZERO_ADDRESS,
        timelock: () => '0',
        pendingOwner: () => null,

        async allocation(s: VaultSource, _: unknown, ctx: GatewayContext) {
            const allocs = await ctx.loaders.allocationsByVault(s.chain, s.row.id) ?? []
            return allocs.map(alloc => ({ chain: s.chain, alloc }))
        },
        async avgNetApy(s: VaultSource, _: unknown, ctx: GatewayContext) {
            const w = await ctx.loaders.vaultApy(s.chain, s.row.id)
            return (w?.supplyApy30d ?? num(s.row.apy)) * (1 - num(s.row.fee) / WAD)
        },
        async avgNetApyExcludingRewards(s: VaultSource, _: unknown, ctx: GatewayContext) {
            const w = await ctx.loaders.vaultApy(s.chain, s.row.id)
            return (w?.supplyApy30d ?? num(s.row.apy)) * (1 - num(s.row.fee) / WAD)
        },
    },

    VaultAllocation: {
        blockNumber: () => '0',
        supplyAssets: (s: AllocationSource) => big(s.alloc.assets).toString(),
        supplyShares: (s: AllocationSource) => big(s.alloc.shares).toString(),
        supplyCap: (s: AllocationSource) => big(s.alloc.cap).toString(),
        supplyQueueIndex: () => null,
        withdrawQueueIndex: () => null,
        id: (s: AllocationSource) => `${s.alloc.vault_id}-${s.alloc.market_id}`,
        pendingSupplyCap: () => null,
        pendingSupplyCapValidAt: () => null,
        pendingSupplyCapUsd: () => null,
        removableAt: () => null,
        block: () => null,
        market: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.market(s.chain, s.alloc.market_id).then(row => row && { chain: s.chain, row }),
        async supplyAssetsUsd(s: AllocationSource, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.alloc.market_id)
            return usd(s.alloc.assets, market?.loan)
        },
        async supplyCapUsd(s: AllocationSource, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.alloc.market_id)
            return usd(s.alloc.cap, market?.loan)
        },
    },

    // ─────────────── VaultV2 ───────────────

    VaultV2: {
        chain: (s: VaultV2Source) => chainView(s.chain),
        id: (s: VaultV2Source) => s.row.id,
        address: (s: VaultV2Source) => s.row.id,
        name: (s: VaultV2Source) => s.row.name,
        symbol: (s: VaultV2Source) => s.row.symbol,
        asset: (s: VaultV2Source) => s.row.asset ? assetView(s.chain, s.row.asset) : null,
        owner: (s: VaultV2Source) => s.row.owner_id ?? ZERO_ADDRESS,
        curator: (s: VaultV2Source) => s.row.curator_id,
        creationBlockNumber: () => '0',
        creationTimestamp: () => '0',

        totalAssets: (s: VaultV2Source) => big(s.row.total_assets).toString(),
        totalSupply: (s: VaultV2Source) => big(s.row.total_supply).toString(),
        totalAssetsUsd: (s: VaultV2Source) => num(s.row.total_assets_usd),
        sharePrice: (s: VaultV2Source) => {
            const supply = big(s.row.total_supply)
            return supply === 0n ? 0 : Number(big(s.row.total_assets)) / Number(supply)
        },

        apy: (s: VaultV2Source) => num(s.row.apy),
        netApy: (s: VaultV2Source) => num(s.row.apy),
        performanceFee: (s: VaultV2Source) => num(s.row.performance_fee) / WAD,
        // V2 exposes managementFee() on-chain but it isn't indexed yet.
        managementFee: () => 0,
        type: () => 'MorphoVault',
    },

    VaultV2Position: {
        chain: (s: VaultV2PositionSource) => chainView(s.chain),
        id: (s: VaultV2PositionSource) => `${s.row.vault_id}-${s.row.account_id}`,
        user: (s: VaultV2PositionSource) => ({ chain: s.chain, address: s.row.account_id }),
        vault: (s: VaultV2PositionSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vaultV2(s.chain, s.row.vault_id).then(row => row && { chain: s.chain, row }),
        shares: (s: VaultV2PositionSource) => big(s.row.shares).toString(),
        assets: (s: VaultV2PositionSource) => big(s.row.assets).toString(),
        async assetsUsd(s: VaultV2PositionSource, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vaultV2(s.chain, s.row.vault_id)
            return usd(s.row.assets, vault?.asset)
        },
    },

    // ─────────────── Market ───────────────

    Market: {
        chain: (s: MarketSource) => chainView(s.chain),
        marketId: (s: MarketSource) => s.row.id,
        uniqueKey: (s: MarketSource) => s.row.id,
        irmAddress: (s: MarketSource) => s.row.irm,
        lltv: (s: MarketSource) => big(s.row.lltv).toString(),
        creationBlockNumber: () => 0,
        creationTimestamp: () => '0',
        listed: () => true,
        collateralAsset: (s: MarketSource) => s.row.collateral ? assetView(s.chain, s.row.collateral) : null,
        loanAsset: (s: MarketSource) => s.row.loan ? assetView(s.chain, s.row.loan) : null,
        state: (s: MarketSource) => s,
    },

    MarketState: {
        blockNumber: () => '0',
        borrowAssets: (s: MarketSource) => big(s.row.total_borrow_assets).toString(),
        supplyAssets: (s: MarketSource) => big(s.row.total_supply_assets).toString(),
        borrowAssetsUsd: (s: MarketSource) => usd(s.row.total_borrow_assets, s.row.loan),
        supplyAssetsUsd: (s: MarketSource) => usd(s.row.total_supply_assets, s.row.loan),
        borrowShares: (s: MarketSource) => big(s.row.total_borrow_shares).toString(),
        supplyShares: (s: MarketSource) => big(s.row.total_supply_shares).toString(),
        collateralAssets: () => null,
        collateralAssetsUsd: () => null,
        utilization: (s: MarketSource) =>
            utilization(big(s.row.total_borrow_assets), big(s.row.total_supply_assets)),
        apyAtTarget: () => 0,
        rateAtTarget: () => null,
        supplyApy: (s: MarketSource) => num(s.row.supply_apy),
        borrowApy: (s: MarketSource) => num(s.row.borrow_apy),
        netSupplyApy: (s: MarketSource) => num(s.row.supply_apy),
        netBorrowApy: () => null,
        timestamp: () => '0',
        id: (s: MarketSource) => s.row.id,
        price: (s: MarketSource) => s.row.oracle_price == null ? null : big(s.row.oracle_price).toString(),
        rewards: () => [],
        dailyPriceVariation: () => null,
        fee: (s: MarketSource) => num(s.row.fee) / WAD,
        liquidityAssets: (s: MarketSource) => liquidity(s.row).toString(),
        liquidityAssetsUsd: (s: MarketSource) => usd(liquidity(s.row), s.row.loan),
        size: (s: MarketSource) => big(s.row.total_supply_assets).toString(),
        sizeUsd: (s: MarketSource) => usd(s.row.total_supply_assets, s.row.loan),
        totalLiquidity: (s: MarketSource) => liquidity(s.row).toString(),
        totalLiquidityUsd: (s: MarketSource) => usd(liquidity(s.row), s.row.loan),

        async avgSupplyApy(s: MarketSource, _: unknown, ctx: GatewayContext) {
            return (await ctx.loaders.marketApy(s.chain, s.row.id))?.supplyApy30d ?? num(s.row.supply_apy)
        },
        async avgBorrowApy(s: MarketSource, _: unknown, ctx: GatewayContext) {
            return (await ctx.loaders.marketApy(s.chain, s.row.id))?.borrowApy30d ?? num(s.row.borrow_apy)
        },
        async dailySupplyApy(s: MarketSource, _: unknown, ctx: GatewayContext) {
            return (await ctx.loaders.marketApy(s.chain, s.row.id))?.supplyApy1d ?? num(s.row.supply_apy)
        },
        async dailyBorrowApy(s: MarketSource, _: unknown, ctx: GatewayContext) {
            return (await ctx.loaders.marketApy(s.chain, s.row.id))?.borrowApy1d ?? num(s.row.borrow_apy)
        },

        // Not indexed on these chains — null across every longer window.
        weeklySupplyApy: () => null,
        weeklyBorrowApy: () => null,
        monthlySupplyApy: () => null,
        monthlyBorrowApy: () => null,
        quarterlySupplyApy: () => null,
        quarterlyBorrowApy: () => null,
        yearlySupplyApy: () => null,
        yearlyBorrowApy: () => null,
    },

    // ─────────────── User / positions ───────────────

    User: {
        chain: (s: { chain: ChainConfig }) => chainView(s.chain),
        address: (s: { address: string }) => s.address,
    },

    VaultPosition: {
        id: (s: VaultPositionSource) => `${s.row.vault_id}-${s.row.account_id}`,
        listed: () => true,
        vault: (s: VaultPositionSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vault(s.chain, s.row.vault_id).then(row => row && { chain: s.chain, row }),
        user: (s: VaultPositionSource) => ({ chain: s.chain, address: s.row.account_id }),
        state: (s: VaultPositionSource) => s,
    },

    VaultPositionState: {
        id: (s: VaultPositionSource) => `${s.row.vault_id}-${s.row.account_id}`,
        timestamp: () => '0',
        assets: (s: VaultPositionSource) => big(s.row.assets).toString(),
        shares: (s: VaultPositionSource) => big(s.row.shares).toString(),
        pnl: () => null,
        pnlUsd: () => null,
        roe: () => null,
        async assetsUsd(s: VaultPositionSource, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vault(s.chain, s.row.vault_id)
            return usd(s.row.assets, vault?.asset)
        },
    },

    MarketPosition: {
        id: (s: MarketPositionSource) => `${s.row.market_id}-${s.row.account_id}`,
        healthFactor: () => null,
        listed: () => true,
        priceVariationToLiquidationPrice: () => null,
        market: (s: MarketPositionSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.market(s.chain, s.row.market_id).then(row => row && { chain: s.chain, row }),
        user: (s: MarketPositionSource) => ({ chain: s.chain, address: s.row.account_id }),
        state: (s: MarketPositionSource) => s,
    },

    MarketPositionState: {
        id: (s: MarketPositionSource) => `${s.row.market_id}-${s.row.account_id}`,
        timestamp: () => '0',
        collateral: (s: MarketPositionSource) => big(s.row.collateral).toString(),
        supplyAssets: () => null,
        supplyAssetsUsd: () => null,
        supplyShares: () => '0',
        borrowAssets: (s: MarketPositionSource) => big(s.row.borrow_assets).toString(),
        borrowShares: () => '0',
        collateralValue: () => null,
        collateralUsdValue: () => null,
        async collateralUsd(s: MarketPositionSource, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            return usd(s.row.collateral, market?.collateral)
        },
        async borrowAssetsUsd(s: MarketPositionSource, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            return usd(s.row.borrow_assets, market?.loan)
        },
    },
}

/** Free liquidity in a market, floored at zero. */
function liquidity(row: MarketRow): bigint {
    const free = big(row.total_supply_assets) - big(row.total_borrow_assets)
    return free > 0n ? free : 0n
}
