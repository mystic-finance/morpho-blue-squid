/**
 * morpho-gateway SDL — the Morpho blue-api schema, verbatim in shape.
 *
 * Unlike src/gateway (which reshapes the data into Money/Apy value objects for
 * one specific frontend), this endpoint mirrors https://blue-api.morpho.org
 * exactly: the same type names, the same scalar shape (BigInt/Float, `state {}`
 * nesting, `Asset`/`Chain`/`User`), and the same first/skip/orderBy pagination.
 * A query written against the real Morpho API validates and runs here.
 *
 * Scope is the backable core — chains, assets, vaults, markets, positions.
 * Fields the per-chain databases cannot produce are handled one of two ways:
 *
 *   - Optional (nullable) upstream fields we don't index are returned as null
 *     (e.g. every weekly/monthly/quarterly/yearly APY on MarketState, rewards,
 *     pnl/roe on positions, historical price series).
 *   - Deep upstream sub-graphs that have no backing at all are OMITTED from the
 *     SDL entirely, so a query selecting them fails validation with a clear
 *     message rather than erroring at execution: Vault.factory / historicalState
 *     / warnings / liquidity / allocators / adminEvents / metadata,
 *     Market.oracle / morphoBlue / badDebt / currentIrmCurve / warnings /
 *     supplyingVaults / preLiquidations, and the *Metadata / *PendingConfig /
 *     Curator sub-objects on VaultState.
 *
 * Required (non-null) upstream fields we don't index are filled with an honest
 * neutral value, documented on the resolver: zero addresses for un-indexed
 * roles (guardian, skimRecipient), 0 for apyAtTarget, "0" for creation blocks.
 */
export const typeDefs = /* GraphQL */ `
  "Arbitrary-precision integer, serialised as a decimal string."
  scalar BigInt
  "0x-prefixed 20-byte address."
  scalar Address
  "0x-prefixed 32-byte market id (Morpho's unique key)."
  scalar MarketId

  # ─────────────── chain / block ───────────────

  type Block {
    id: ID!
    number: BigInt!
    timestamp: BigInt!
  }

  type Chain {
    id: Int!
    network: String!
    currency: String!
    blockTimeMs: Int
    headBlock: Block
  }

  # ─────────────── asset ───────────────

  type AssetPrice {
    usd: Float!
    timestamp: BigInt!
  }

  type Asset {
    chain: Chain!
    id: ID!
    address: Address!
    decimals: Float!
    name: String!
    symbol: String!
    tags: [String!]
    logoURI: String
    isListed: Boolean!
    price: AssetPrice
  }

  # ─────────────── vault ───────────────

  type VaultAllocation {
    blockNumber: BigInt!
    supplyAssets: BigInt!
    supplyAssetsUsd: Float
    supplyShares: BigInt!
    supplyCap: BigInt!
    supplyCapUsd: Float
    supplyQueueIndex: Int
    withdrawQueueIndex: Int
    id: ID!
    pendingSupplyCap: BigInt
    pendingSupplyCapValidAt: BigInt
    pendingSupplyCapUsd: Float
    removableAt: BigInt
    block: Block
    market: Market!
  }

  type VaultState {
    blockNumber: BigInt!
    totalAssets: BigInt!
    totalAssetsUsd: Float
    totalSupply: BigInt!
    apy: Float!
    netApy: Float!
    netApyExcludingRewards: Float!
    timestamp: BigInt!
    allocation: [VaultAllocation!]!
    sharePriceNumber: Float
    sharePriceUsd: Float
    fee: Float!
    curator: Address!
    feeRecipient: Address!
    guardian: Address!
    owner: Address!
    skimRecipient: Address!
    timelock: BigInt!
    pendingOwner: Address
    avgNetApy(lookback: Int): Float
    avgNetApyExcludingRewards(lookback: Int): Float
  }

  type Vault {
    asset: Asset!
    chain: Chain!
    address: Address!
    symbol: String!
    name: String!
    creationBlockNumber: Int!
    creationTimestamp: BigInt!
    creatorAddress: Address
    listed: Boolean!
    state: VaultState
  }

  # ─────────────── market ───────────────

  type MarketStateReward {
    asset: Asset!
    supplyApr: Float
    borrowApr: Float
    id: ID!
  }

  type MarketState {
    blockNumber: BigInt!
    borrowAssets: BigInt!
    supplyAssets: BigInt!
    borrowAssetsUsd: Float
    supplyAssetsUsd: Float
    borrowShares: BigInt!
    supplyShares: BigInt!
    collateralAssets: BigInt
    collateralAssetsUsd: Float
    utilization: Float!
    apyAtTarget: Float!
    rateAtTarget: BigInt
    supplyApy: Float!
    borrowApy: Float!
    netSupplyApy: Float
    netBorrowApy: Float
    timestamp: BigInt!
    avgSupplyApy: Float
    avgBorrowApy: Float
    dailySupplyApy: Float
    dailyBorrowApy: Float
    id: ID!
    price: BigInt
    rewards: [MarketStateReward!]!
    dailyPriceVariation: Float
    fee: Float!
    liquidityAssets: BigInt!
    liquidityAssetsUsd: Float
    size: BigInt!
    sizeUsd: Float
    totalLiquidity: BigInt!
    totalLiquidityUsd: Float
    weeklySupplyApy: Float
    weeklyBorrowApy: Float
    monthlySupplyApy: Float
    monthlyBorrowApy: Float
    quarterlySupplyApy: Float
    quarterlyBorrowApy: Float
    yearlySupplyApy: Float
    yearlyBorrowApy: Float
  }

  type Market {
    chain: Chain!
    marketId: MarketId!
    uniqueKey: MarketId!
    irmAddress: Address!
    lltv: BigInt!
    creationBlockNumber: Int!
    creationTimestamp: BigInt!
    listed: Boolean!
    collateralAsset: Asset
    loanAsset: Asset!
    state: MarketState
  }

  # ─────────────── user / positions ───────────────

  type User {
    chain: Chain!
    address: Address!
  }

  type VaultPositionState {
    id: ID!
    timestamp: BigInt!
    assets: BigInt
    assetsUsd: Float
    shares: BigInt!
    pnl: BigInt
    pnlUsd: Float
    roe: Float
  }

  type VaultPosition {
    id: ID!
    listed: Boolean!
    vault: Vault!
    user: User!
    state: VaultPositionState
  }

  type MarketPositionState {
    id: ID!
    timestamp: BigInt!
    collateral: BigInt!
    collateralUsd: Float
    supplyAssets: BigInt
    supplyAssetsUsd: Float
    supplyShares: BigInt!
    borrowAssets: BigInt
    borrowAssetsUsd: Float
    borrowShares: BigInt!
    collateralValue: BigInt
    collateralUsdValue: Float
  }

  type MarketPosition {
    id: ID!
    healthFactor: Float
    listed: Boolean!
    priceVariationToLiquidationPrice: Float
    market: Market!
    user: User!
    state: MarketPositionState
  }

  # ─────────────── pagination ───────────────

  type PageInfo {
    countTotal: Int!
    count: Int!
    limit: Int!
    skip: Int!
  }

  type PaginatedMetaMorphos {
    items: [Vault!]
    pageInfo: PageInfo
  }

  type PaginatedMarkets {
    items: [Market!]
    pageInfo: PageInfo
  }

  type PaginatedAssets {
    items: [Asset!]
    pageInfo: PageInfo
  }

  type PaginatedMetaMorphoPositions {
    items: [VaultPosition!]
    pageInfo: PageInfo
  }

  type PaginatedMarketPositions {
    items: [MarketPosition!]
    pageInfo: PageInfo
  }

  # ─────────────── ordering ───────────────

  enum OrderDirection {
    Asc
    Desc
  }

  enum VaultOrderBy {
    Address
    TotalAssets
    TotalAssetsUsd
    TotalSupply
    Fee
    Apy
    NetApy
    Name
  }

  enum MarketOrderBy {
    UniqueKey
    Lltv
    BorrowAssets
    BorrowAssetsUsd
    SupplyAssets
    SupplyAssetsUsd
    BorrowShares
    SupplyShares
    Utilization
    SupplyApy
    BorrowApy
    Fee
    TotalLiquidityUsd
    SizeUsd
  }

  enum VaultPositionOrderBy {
    Shares
  }

  enum MarketPositionOrderBy {
    SupplyShares
    BorrowShares
    Collateral
  }

  enum AssetOrderBy {
    Address
  }

  # ─────────────── filters ───────────────

  input VaultFilters {
    search: String
    listed: Boolean
    featured: Boolean
    address_in: [String!]
    address_not_in: [String!]
    ownerAddress_in: [String!]
    curatorAddress_in: [String!]
    symbol_in: [String!]
    chainId_in: [Int!]
    assetAddress_in: [String!]
    apy_gte: Float
    apy_lte: Float
    fee_gte: Float
    fee_lte: Float
    totalAssets_gte: BigInt
    totalAssets_lte: BigInt
    totalAssetsUsd_gte: Float
    totalAssetsUsd_lte: Float
    totalSupply_gte: BigInt
    totalSupply_lte: BigInt
  }

  input MarketFilters {
    search: String
    listed: Boolean
    uniqueKey_in: [String!]
    chainId_in: [Int!]
    isIdle: Boolean
    collateralAssetAddress_in: [String!]
    loanAssetAddress_in: [String!]
    irmAddress_in: [String!]
    lltv_gte: BigInt
    lltv_lte: BigInt
    borrowAssets_gte: BigInt
    borrowAssets_lte: BigInt
    supplyAssets_gte: BigInt
    supplyAssets_lte: BigInt
    utilization_gte: Float
    utilization_lte: Float
    supplyApy_gte: Float
    supplyApy_lte: Float
    borrowApy_gte: Float
    borrowApy_lte: Float
    fee_gte: Float
    fee_lte: Float
  }

  input AssetsFilters {
    symbol_in: [String!]
    address_in: [String!]
    chainId_in: [Int!]
  }

  input VaultPositionFilters {
    vaultAddress_in: [String!]
    userAddress_in: [String!]
    chainId_in: [Int!]
    shares_gte: BigInt
    shares_lte: BigInt
  }

  input MarketPositionFilters {
    marketUniqueKey_in: [String!]
    userAddress_in: [String!]
    chainId_in: [Int!]
    supplyShares_gte: BigInt
    supplyShares_lte: BigInt
    borrowShares_gte: BigInt
    borrowShares_lte: BigInt
    collateral_gte: BigInt
    collateral_lte: BigInt
  }

  # ─────────────── queries ───────────────

  type Query {
    chains: [Chain!]!

    assets(first: Int, skip: Int, where: AssetsFilters, orderBy: AssetOrderBy, orderDirection: OrderDirection): PaginatedAssets!
    assetByAddress(address: String!, chainId: Int): Asset!

    vaults(first: Int, skip: Int, orderBy: VaultOrderBy, orderDirection: OrderDirection, where: VaultFilters): PaginatedMetaMorphos!
    vaultByAddress(address: String!, chainId: Int): Vault!

    markets(first: Int, skip: Int, orderBy: MarketOrderBy, orderDirection: OrderDirection, where: MarketFilters): PaginatedMarkets!
    marketById(marketId: String!, chainId: Int!): Market!

    vaultPositions(first: Int, skip: Int, orderBy: VaultPositionOrderBy, orderDirection: OrderDirection, where: VaultPositionFilters): PaginatedMetaMorphoPositions!
    marketPositions(first: Int, skip: Int, orderBy: MarketPositionOrderBy, orderDirection: OrderDirection, where: MarketPositionFilters): PaginatedMarketPositions!
  }
`
