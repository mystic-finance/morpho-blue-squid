/**
 * Resolvers mapping indexed rows onto the Morpho blue-api shape.
 *
 * Source objects always carry their `chain` alongside the row, because the
 * gateway serves several chains from separate databases and an id is only
 * meaningful next to the chain it came from.
 */
import { GraphQLScalarType } from 'graphql'
import {
    ChainConfig, curatorMetadata, irmConfig, loadConfig, resolveChains, tokenMetadata,
} from './config'
import { queryChains } from './db'
import {
    AllocationRow, Loaders, MarketRow, MarketPositionRow, VaultRow, VaultPositionRow,
    VaultV2Row, VaultV2AllocationRow, VaultV2PositionRow,
    marketHistory, pageMarketPositions, pageMarkets, pageVaultPositions, pageVaults, vaultHistory,
    pageVaultV2, pageVaultV2Positions, vaultV2History,
} from './data'
import { buildCurve } from './irm'
import {
    apy, big, curatorsView, liquidationPenalty, money, num, toSeconds, tokenView, utilization,
    wadRatio, WAD,
} from './format'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface GatewayContext {
    loaders: Loaders
}

interface MarketSource { chain: ChainConfig; row: MarketRow }
interface VaultSource { chain: ChainConfig; row: VaultRow }
interface AllocationSource { chain: ChainConfig; alloc: AllocationRow }
interface VaultV2Source { chain: ChainConfig; row: VaultV2Row }
interface VaultV2PositionSource { chain: ChainConfig; row: VaultV2PositionRow }

const lowerAll = (v?: string[] | null): string[] | null =>
    v && v.length > 0 ? v.map(s => s.toLowerCase()) : null

const chainView = (c: ChainConfig) => ({ id: c.id, name: c.name, icon: c.icon ?? null })

/** Fetch one extra row so hasNextPage is real rather than guessed. */
function paginate<T>(items: T[], limit: number) {
    const hasNextPage = items.length > limit
    return { pageInfo: { hasNextPage }, items: hasNextPage ? items.slice(0, limit) : items }
}

function loanMoney(src: MarketSource, raw: bigint | string) {
    const t = src.row.loan
    return money(raw, t?.decimals ?? 18, t?.last_price_usd == null ? null : Number(t.last_price_usd))
}

// ─────────────── scalars ───────────────

/**
 * Pass-through scalars. They exist so that upstream Morpho query documents —
 * which declare variables as ChainId/Address/Hex — validate against this
 * schema without being rewritten.
 */
const passthrough = (name: string, parse: (v: unknown) => unknown = v => v) =>
    new GraphQLScalarType({
        name,
        serialize: v => v,
        parseValue: parse,
        parseLiteral: ast => parse((ast as any).value),
    })

export const scalarResolvers = {
    ChainId: passthrough('ChainId', v => Number(v)),
    Address: passthrough('Address', v => String(v)),
    Hex: passthrough('Hex', v => String(v)),
}

// ─────────────── Query ───────────────

export const resolvers = {
    ...scalarResolvers,

    Query: {
        chains: () => loadConfig().chains.map(chainView),

        async morphoMarkets(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const ids = lowerAll(args.where?.marketId_in)
            const limit = args.limit ?? 100
            const rows = await queryChains(chains, async chain =>
                (await pageMarkets(chain, ids, limit + 1)).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },

        async morphoVaults(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const ids = lowerAll(args.where?.vaultAddress_in)
            const limit = args.limit ?? 100
            const rows = await queryChains(chains, async chain =>
                (await pageVaults(chain, ids, limit + 1)).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },

        async morphoVaultPositions(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const limit = args.limit ?? 100
            const rows = await queryChains(chains, async chain =>
                (await pageVaultPositions(
                    chain,
                    lowerAll(args.where?.vaultAddress_in),
                    lowerAll(args.where?.accountAddress_in),
                    limit + 1,
                )).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },

        async morphoMarketPositions(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const limit = args.limit ?? 100
            const rows = await queryChains(chains, async chain =>
                (await pageMarketPositions(
                    chain,
                    lowerAll(args.where?.marketId_in),
                    lowerAll(args.where?.accountAddress_in),
                    limit + 1,
                )).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },

        async morphoVaultsV2(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const limit = args.limit ?? 100
            const filters = { addresses: lowerAll(args.where?.vaultAddress_in) }
            const rows = await queryChains(chains, async chain =>
                (await pageVaultV2(chain, filters, limit + 1)).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },

        async morphoVaultV2Positions(_: unknown, args: any) {
            const chains = resolveChains(args.where?.chainId_in)
            const limit = args.limit ?? 100
            const rows = await queryChains(chains, async chain =>
                (await pageVaultV2Positions(
                    chain,
                    lowerAll(args.where?.vaultAddress_in),
                    lowerAll(args.where?.accountAddress_in),
                    limit + 1,
                )).map(row => ({ chain, row })))
            return paginate(rows, limit)
        },
    },

    // ─────────────── MorphoMarket ───────────────

    MorphoMarket: {
        chain: (s: MarketSource) => chainView(s.chain),
        name: (s: MarketSource) => s.row.name,
        marketId: (s: MarketSource) => s.row.id,
        isIdle: (s: MarketSource) =>
            !s.row.input_token_id || s.row.input_token_id.toLowerCase() === ZERO_ADDRESS,

        loanAsset: (s: MarketSource) => s.row.loan
            ? tokenView(s.row.loan, s.chain.id, tokenMetadata(s.chain.id, s.row.loan.id))
            : null,
        collateralAsset: (s: MarketSource) => s.row.collateral
            ? tokenView(s.row.collateral, s.chain.id, tokenMetadata(s.chain.id, s.row.collateral.id))
            : null,

        totalSupplied: (s: MarketSource) => loanMoney(s, s.row.total_supply_assets),
        totalBorrowed: (s: MarketSource) => loanMoney(s, s.row.total_borrow_assets),
        liquidityInMarket: (s: MarketSource) => {
            const liquidity = big(s.row.total_supply_assets) - big(s.row.total_borrow_assets)
            return loanMoney(s, liquidity > 0n ? liquidity : 0n)
        },

        async publicAllocatorSharedLiquidity(s: MarketSource, _: unknown, ctx: GatewayContext) {
            const shared = await ctx.loaders.sharedLiquidity(s.chain, s.row.id)
            return loanMoney(s, shared ?? '0')
        },

        lltv: (s: MarketSource) => wadRatio(s.row.lltv),
        fee: (s: MarketSource) => wadRatio(s.row.fee),

        // supply_apy is stored net of the market fee; borrow_apy is gross.
        supplyApy: (s: MarketSource) => apy(num(s.row.supply_apy), num(s.row.fee) / WAD),
        borrowApy: (s: MarketSource) => apy(num(s.row.borrow_apy)),
        borrowApyInstantaneous: (s: MarketSource) => apy(num(s.row.borrow_apy)),

        supplyApy1d: windowApy('supplyApy1d', 'supply_apy'),
        supplyApy7d: windowApy('supplyApy7d', 'supply_apy'),
        supplyApy30d: windowApy('supplyApy30d', 'supply_apy'),
        borrowApy1d: windowApy('borrowApy1d', 'borrow_apy'),
        borrowApy7d: windowApy('borrowApy7d', 'borrow_apy'),
        borrowApy30d: windowApy('borrowApy30d', 'borrow_apy'),

        utilization: (s: MarketSource) =>
            utilization(big(s.row.total_borrow_assets), big(s.row.total_supply_assets)),

        liquidationPenalty: (s: MarketSource) => liquidationPenalty(s.row.lltv),
        oracleAddress: (s: MarketSource) => s.row.oracle,

        irm: (s: MarketSource) => {
            const cfg = irmConfig(s.chain.id, s.row.irm)
            const u = utilization(big(s.row.total_borrow_assets), big(s.row.total_supply_assets))
            return {
                address: s.row.irm,
                targetUtilization: cfg.targetUtilization,
                curve: cfg.type === 'adaptive-curve'
                    ? buildCurve(num(s.row.borrow_apy), u, num(s.row.fee) / WAD, cfg)
                    : [],
            }
        },

        /**
         * The market oracle's own reading, as indexed. `raw` is the value the
         * contract returns, carrying 36 + loanDecimals - collateralDecimals
         * decimals; `formatted` is that normalised to a plain
         * collateral-per-loan-unit ratio.
         *
         * This reads the oracle rather than dividing the two USD display
         * prices: the oracle is what the protocol actually liquidates against,
         * so a ratio derived from it matches on-chain behaviour, whereas one
         * derived from two independent feeds does not. Falls back to the USD
         * ratio only for markets indexed before oracle reading existed.
         */
        collateralPriceInLoanAsset: (s: MarketSource) => {
            const collDecimals = s.row.collateral?.decimals ?? 18
            const loanDecimals = s.row.loan?.decimals ?? 18
            const scale = 36 + loanDecimals - collDecimals

            const indexed = s.row.oracle_price
            if (indexed != null && big(indexed) > 0n) {
                return { raw: big(indexed).toString(), formatted: Number(indexed) / 10 ** scale }
            }

            const collPrice = s.row.collateral?.last_price_usd
            const loanPrice = s.row.loan?.last_price_usd
            if (collPrice == null || loanPrice == null || Number(loanPrice) === 0) return null
            const formatted = Number(collPrice) / Number(loanPrice)
            return { raw: BigInt(Math.round(formatted * 10 ** scale)).toString(), formatted }
        },

        async vaultAllocations(s: MarketSource, _: unknown, ctx: GatewayContext) {
            const allocs = await ctx.loaders.allocationsByMarket(s.chain, s.row.id) ?? []
            return allocs.map(alloc => ({ chain: s.chain, alloc }))
        },

        historical: (s: MarketSource) => s,
    },

    MarketHistory: {
        daily: async (s: MarketSource) => (await marketHistory(s.chain, s.row.id, 'daily')).map(r => ({ src: s, r })),
        hourly: async (s: MarketSource) => (await marketHistory(s.chain, s.row.id, 'hourly')).map(r => ({ src: s, r })),
    },

    MarketHistoryBucket: {
        bucketTimestamp: ({ r }: any) => toSeconds(r.timestamp),
        supplyApy1d: ({ r }: any) => apy(num(r.supply_apy_1d)),
        supplyApy7d: ({ r }: any) => apy(num(r.supply_apy_7d)),
        supplyApy30d: ({ r }: any) => apy(num(r.supply_apy_30d)),
        borrowApy1d: ({ r }: any) => apy(num(r.borrow_apy_1d)),
        borrowApy7d: ({ r }: any) => apy(num(r.borrow_apy_7d)),
        borrowApy30d: ({ r }: any) => apy(num(r.borrow_apy_30d)),
        borrowApyInstantaneous: ({ r }: any) => apy(num(r.borrow_apy)),
        totalSupplied: ({ src, r }: any) => loanMoney(src, r.total_supply_assets),
        totalBorrowed: ({ src, r }: any) => loanMoney(src, r.total_borrow_assets),
        totalCollateral: () => null,
    },

    MarketVaultAllocation: {
        vault: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vault(s.chain, s.alloc.vault_id).then(row => row && { chain: s.chain, row }),
        enabled: (s: AllocationSource) => s.alloc.enabled,
        position: (s: AllocationSource) => s,
        supplyCap: (s: AllocationSource, _: unknown, ctx: GatewayContext) => allocationMoney(s, ctx, s.alloc.cap),
        async marketSupplyShare(s: AllocationSource, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.alloc.market_id)
            const total = big(market?.total_supply_assets)
            return total === 0n ? 0 : Number(big(s.alloc.assets)) / Number(total)
        },
    },

    VaultMarketAllocation: {
        market: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.market(s.chain, s.alloc.market_id).then(row => row && { chain: s.chain, row }),
        vault: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vault(s.chain, s.alloc.vault_id).then(row => row && { chain: s.chain, row }),
        enabled: (s: AllocationSource) => s.alloc.enabled,
        position: (s: AllocationSource) => s,
        supplyCap: (s: AllocationSource, _: unknown, ctx: GatewayContext) => allocationMoney(s, ctx, s.alloc.cap),
        async vaultSupplyShare(s: AllocationSource, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vault(s.chain, s.alloc.vault_id)
            const total = big(vault?.total_assets)
            return total === 0n ? 0 : Number(big(s.alloc.assets)) / Number(total)
        },
    },

    /** Shared by both allocation directions — the vault's stake in the market. */
    SupplyPosition: {
        supplyAmount: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            allocationMoney(s, ctx, s.alloc.assets),
        supplyShares: (s: AllocationSource) => big(s.alloc.shares).toString(),
    },

    // ─────────────── MorphoVault ───────────────

    MorphoVault: {
        chain: (s: VaultSource) => chainView(s.chain),
        vaultAddress: (s: VaultSource) => s.row.id,
        name: (s: VaultSource) => s.row.name,
        symbol: (s: VaultSource) => s.row.symbol,
        /** ERC4626 share decimals aren't indexed; the asset's are the useful proxy. */
        decimals: (s: VaultSource) => s.row.asset?.decimals ?? 18,
        asset: (s: VaultSource) => s.row.asset
            ? tokenView(s.row.asset, s.chain.id, tokenMetadata(s.chain.id, s.row.asset.id))
            : null,
        metadata: (s: VaultSource) => ({
            curators: curatorsView(curatorMetadata(s.chain.id, s.row.curator_id, s.row.owner_id)),
        }),

        totalSupplied: (s: VaultSource) => vaultMoney(s, s.row.total_assets),

        /**
         * What a withdrawal could actually draw today: the vault's assets in
         * each allocated market, capped by that market's free liquidity.
         */
        async totalLiquidity(s: VaultSource, _: unknown, ctx: GatewayContext) {
            const allocs = await ctx.loaders.allocationsByVault(s.chain, s.row.id) ?? []
            let total = 0n
            for (const alloc of allocs) {
                const market = await ctx.loaders.market(s.chain, alloc.market_id)
                if (!market) continue
                const free = big(market.total_supply_assets) - big(market.total_borrow_assets)
                const held = big(alloc.assets)
                total += held < free ? held : (free > 0n ? free : 0n)
            }
            return vaultMoney(s, total)
        },

        supplyApy: (s: VaultSource) => apy(num(s.row.apy), num(s.row.fee) / WAD),
        supplyApy1d: vaultWindowApy('supplyApy1d'),
        supplyApy7d: vaultWindowApy('supplyApy7d'),
        supplyApy30d: vaultWindowApy('supplyApy30d'),

        performanceFee: (s: VaultSource) => num(s.row.fee) / WAD,
        feeRecipientAddress: (s: VaultSource) => s.row.fee_recipient,
        ownerAddress: (s: VaultSource) => s.row.owner_id,
        curatorAddress: (s: VaultSource) => s.row.curator_id,
        guardianAddress: (s: VaultSource) => s.row.guardian ?? null,

        async marketAllocations(s: VaultSource, _: unknown, ctx: GatewayContext) {
            const allocs = await ctx.loaders.allocationsByVault(s.chain, s.row.id) ?? []
            return allocs.map(alloc => ({ chain: s.chain, alloc }))
        },

        historical: (s: VaultSource) => s,
    },

    VaultHistory: {
        daily: async (s: VaultSource) => (await vaultHistory(s.chain, s.row.id, 'daily')).map(r => ({ src: s, r })),
        hourly: async (s: VaultSource) => (await vaultHistory(s.chain, s.row.id, 'hourly')).map(r => ({ src: s, r })),
    },

    VaultHistoryBucket: {
        bucketTimestamp: ({ r }: any) => toSeconds(r.timestamp),
        supplyApy1d: ({ r }: any) => apy(num(r.apy_1d)),
        supplyApy7d: ({ r }: any) => apy(num(r.apy_7d)),
        supplyApy30d: ({ r }: any) => apy(num(r.apy_30d)),
        totalSupplied: ({ src, r }: any) => vaultMoney(src, r.total_assets),
    },

    // ─────────────── positions ───────────────

    MorphoVaultPosition: {
        vault: (s: { chain: ChainConfig; row: VaultPositionRow }, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vault(s.chain, s.row.vault_id).then(row => row && { chain: s.chain, row }),
        accountAddress: (s: any) => s.row.account_id,
        async supplyAmount(s: any, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vault(s.chain, s.row.vault_id)
            return vault ? vaultMoney({ chain: s.chain, row: vault }, s.row.assets) : money(s.row.assets, 18)
        },
        supplyShares: (s: any) => big(s.row.shares).toString(),
        async walletUnderlyingAssetHolding(s: any, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vault(s.chain, s.row.vault_id)
            return walletHolding(ctx, s.chain, vault?.asset, s.row.account_id)
        },
    },

    MorphoMarketPosition: {
        market: (s: { chain: ChainConfig; row: MarketPositionRow }, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.market(s.chain, s.row.market_id).then(row => row && { chain: s.chain, row }),
        accountAddress: (s: any) => s.row.account_id,

        async collateralAmount(s: any, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            const t = market?.collateral
            return money(s.row.collateral, t?.decimals ?? 18, t?.last_price_usd == null ? null : Number(t.last_price_usd))
        },

        // Position.balance is denominated in assets on every side, so no
        // share conversion is applied here.
        async borrowAmount(s: any, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            if (!market) return money(0n, 18)
            return loanMoney({ chain: s.chain, row: market }, big(s.row.borrow_assets))
        },

        /** Loan value over collateral value, both in USD. */
        async ltv(s: any, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            if (!market) return { raw: '0', formatted: 0 }
            const collPrice = market.collateral?.last_price_usd
            const loanPrice = market.loan?.last_price_usd
            if (collPrice == null || loanPrice == null) return { raw: '0', formatted: 0 }

            const collUsd = (Number(big(s.row.collateral)) / 10 ** (market.collateral?.decimals ?? 18)) * Number(collPrice)
            const borrowAssets = big(s.row.borrow_assets)
            const borrowUsd = (Number(borrowAssets) / 10 ** (market.loan?.decimals ?? 18)) * Number(loanPrice)

            const formatted = collUsd === 0 ? 0 : borrowUsd / collUsd
            return { raw: BigInt(Math.round(formatted * WAD)).toString(), formatted }
        },

        async walletLoanAssetHolding(s: any, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            return walletHolding(ctx, s.chain, market?.loan, s.row.account_id)
        },
        async walletCollateralAssetHolding(s: any, _: unknown, ctx: GatewayContext) {
            const market = await ctx.loaders.market(s.chain, s.row.market_id)
            return walletHolding(ctx, s.chain, market?.collateral, s.row.account_id)
        },
    },

    // ─────────────── MorphoVaultV2 (structural twin of MorphoVault) ───────────────

    MorphoVaultV2: {
        chain: (s: VaultV2Source) => chainView(s.chain),
        vaultAddress: (s: VaultV2Source) => s.row.id,
        name: (s: VaultV2Source) => s.row.name,
        symbol: (s: VaultV2Source) => s.row.symbol,
        decimals: (s: VaultV2Source) => s.row.asset?.decimals ?? 18,
        asset: (s: VaultV2Source) => s.row.asset
            ? tokenView(s.row.asset, s.chain.id, tokenMetadata(s.chain.id, s.row.asset.id))
            : null,
        metadata: (s: VaultV2Source) => ({
            curators: curatorsView(curatorMetadata(s.chain.id, s.row.curator_id, s.row.owner_id)),
        }),

        totalSupplied: (s: VaultV2Source) => vaultMoney(s, s.row.total_assets),
        // Per-market free liquidity isn't derivable for V2 (adapter positions
        // aren't indexed); the full supply is the best available proxy.
        totalLiquidity: (s: VaultV2Source) => vaultMoney(s, s.row.total_assets),

        supplyApy: (s: VaultV2Source) => apy(num(s.row.apy)),
        supplyApy1d: vaultV2WindowApy('supplyApy1d'),
        supplyApy7d: vaultV2WindowApy('supplyApy7d'),
        supplyApy30d: vaultV2WindowApy('supplyApy30d'),

        performanceFee: (s: VaultV2Source) => num(s.row.performance_fee) / WAD,
        feeRecipientAddress: () => null,
        ownerAddress: (s: VaultV2Source) => s.row.owner_id,
        curatorAddress: (s: VaultV2Source) => s.row.curator_id,
        // V2 has no guardian — guardian() reverts on the contract.
        guardianAddress: () => null,

        async marketAllocations(s: VaultV2Source, _: unknown, ctx: GatewayContext) {
            const allocs = await ctx.loaders.allocationsV2ByVault(s.chain, s.row.id) ?? []
            // Adapt each V2 cap row into the shared AllocationRow shape so the
            // VaultV2MarketAllocation / SupplyPosition resolvers below reuse the
            // V1 machinery. Per-market assets/shares aren't indexed → 0.
            return allocs.map((a: VaultV2AllocationRow) => ({
                chain: s.chain,
                alloc: {
                    vault_id: a.vault_id,
                    market_id: a.market_id,
                    cap: a.absolute_cap,
                    enabled: true,
                    assets: '0',
                    shares: '0',
                } as AllocationRow,
            }))
        },

        historical: (s: VaultV2Source) => s,
    },

    VaultV2MarketAllocation: {
        market: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.market(s.chain, s.alloc.market_id).then(row => row && { chain: s.chain, row }),
        vault: (s: AllocationSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vaultV2(s.chain, s.alloc.vault_id).then(row => row && { chain: s.chain, row }),
        enabled: (s: AllocationSource) => s.alloc.enabled,
        position: (s: AllocationSource) => s,
        supplyCap: (s: AllocationSource, _: unknown, ctx: GatewayContext) => allocationMoney(s, ctx, s.alloc.cap),
        vaultSupplyShare: () => 0,
    },

    VaultV2History: {
        daily: async (s: VaultV2Source) =>
            (await vaultV2History(s.chain, s.row.id, 'daily')).map(r => ({ src: s, r })),
        hourly: async (s: VaultV2Source) =>
            (await vaultV2History(s.chain, s.row.id, 'hourly')).map(r => ({ src: s, r })),
    },

    MorphoVaultV2Position: {
        vault: (s: VaultV2PositionSource, _: unknown, ctx: GatewayContext) =>
            ctx.loaders.vaultV2(s.chain, s.row.vault_id).then(row => row && { chain: s.chain, row }),
        accountAddress: (s: VaultV2PositionSource) => s.row.account_id,
        async supplyAmount(s: VaultV2PositionSource, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vaultV2(s.chain, s.row.vault_id)
            return vault ? vaultMoney({ chain: s.chain, row: vault }, s.row.assets) : money(s.row.assets, 18)
        },
        supplyShares: (s: VaultV2PositionSource) => big(s.row.shares).toString(),
        async walletUnderlyingAssetHolding(s: VaultV2PositionSource, _: unknown, ctx: GatewayContext) {
            const vault = await ctx.loaders.vaultV2(s.chain, s.row.vault_id)
            return walletHolding(ctx, s.chain, vault?.asset, s.row.account_id)
        },
    },
}

// ─────────────── helpers used above ───────────────

/** Money denominated in a vault's underlying asset. Serves both V1 and V2 sources. */
function vaultMoney(s: VaultSource | VaultV2Source, raw: bigint | string) {
    const t = s.row.asset
    return money(raw, t?.decimals ?? 18, t?.last_price_usd == null ? null : Number(t.last_price_usd))
}

/**
 * A wallet's live balance of `token`, read from the chain RPC and denominated
 * with the token's own decimals/price. Returns null — a WalletAssetHolding is
 * nullable — when there is no token (e.g. a market with no collateral) or the
 * RPC has nothing for this pair (unconfigured endpoint, failed call).
 */
async function walletHolding(
    ctx: GatewayContext,
    chain: ChainConfig,
    token: { id: string; decimals: number; last_price_usd: string | null } | null | undefined,
    account: string,
) {
    if (!token) return null
    const raw = await ctx.loaders.walletBalance(chain, token.id, account)
    if (raw == null) return null
    const price = token.last_price_usd == null ? null : Number(token.last_price_usd)
    return { balance: money(raw, token.decimals, price) }
}

/** Money denominated in an allocation's market loan asset. */
async function allocationMoney(s: AllocationSource, ctx: GatewayContext, raw: bigint | string) {
    const market = await ctx.loaders.market(s.chain, s.alloc.market_id)
    if (!market) return money(raw, 18)
    return loanMoney({ chain: s.chain, row: market }, raw)
}

/**
 * Trailing-window APY on a market. Falls back to the market's current rate
 * when there aren't enough snapshots to average — a fresh market reporting
 * its live rate is more useful than one reporting zero.
 */
function windowApy(field: keyof import('./data').ApyWindows, current: 'supply_apy' | 'borrow_apy') {
    return async (s: MarketSource, _: unknown, ctx: GatewayContext) => {
        const windows = await ctx.loaders.marketApy(s.chain, s.row.id)
        const value = windows?.[field]
        const fee = current === 'supply_apy' ? num(s.row.fee) / WAD : 0
        return apy(value ?? num(s.row[current]), fee)
    }
}

function vaultWindowApy(field: keyof import('./data').ApyWindows) {
    return async (s: VaultSource, _: unknown, ctx: GatewayContext) => {
        const windows = await ctx.loaders.vaultApy(s.chain, s.row.id)
        return apy(windows?.[field] ?? num(s.row.apy), num(s.row.fee) / WAD)
    }
}

/** V2 has no indexed fee stream, so the trailing window is reported gross. */
function vaultV2WindowApy(field: keyof import('./data').ApyWindows) {
    return async (s: VaultV2Source, _: unknown, ctx: GatewayContext) => {
        const windows = await ctx.loaders.vaultV2Apy(s.chain, s.row.id)
        return apy(windows?.[field] ?? num(s.row.apy))
    }
}
