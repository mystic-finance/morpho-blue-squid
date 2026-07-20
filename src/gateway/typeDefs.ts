/**
 * Gateway SDL — the Morpho blue-api shape.
 *
 * Deliberately mirrors the upstream Morpho GraphQL API so existing frontend
 * documents validate and execute unchanged. Notable deviations, all of which
 * are documented on the field itself:
 *
 *   - wallet holding fields are omitted (we don't index ERC20 balances)
 *   - Apy.rewards is always empty (no distributor deployed on our chains)
 *   - totalCollateral is nullable (not tracked as a market-level aggregate)
 *   - guardianAddress is nullable (not indexed)
 */
export const typeDefs = /* GraphQL */ `
  "Numeric EVM chain id. Declared as a scalar so upstream query documents that type their variables as ChainId validate unchanged."
  scalar ChainId
  "0x-prefixed 20-byte address."
  scalar Address
  "0x-prefixed hex string (market ids are 32 bytes)."
  scalar Hex

  type Chain {
    id: Int!
    name: String!
    icon: String
  }

  type Token {
    address: String!
    symbol: String!
    decimals: Int!
    icon: String
    category: String
    name: String!
    priceUsd: Float
    chain: Chain!
  }

  type Curator {
    name: String!
    image: String
    url: String
  }

  type VaultMetadata {
    curators: [Curator!]!
  }

  "An amount, denominated three ways. formatted = raw / 10^decimals; usd = formatted x the asset's last indexed price."
  type Money {
    raw: String!
    formatted: Float!
    usd: Float
  }

  "A WAD-scaled on-chain ratio. formatted = raw / 1e18."
  type Ratio {
    raw: String!
    formatted: Float!
  }

  type RewardApr {
    asset: Token!
    apr: Float!
  }

  type Apy {
    base: Float!
    "Always empty: no reward distributor is indexed on these chains, so total == base."
    rewards: [RewardApr!]!
    total: Float!
    fee: Float!
  }

  type CurvePoint {
    utilization: Float!
    supplyApy: Float!
    borrowApy: Float!
  }

  type Irm {
    address: String!
    targetUtilization: Float
    "Reconstructed from the market's live rate and utilization; empty for markets that have never accrued."
    curve: [CurvePoint!]!
  }

  # ─────────────── history ───────────────

  type MarketHistoryBucket {
    bucketTimestamp: Int!
    supplyApy1d: Apy
    supplyApy7d: Apy
    supplyApy30d: Apy
    borrowApy1d: Apy
    borrowApy7d: Apy
    borrowApy30d: Apy
    borrowApyInstantaneous: Apy
    totalSupplied: Money!
    totalBorrowed: Money!
    "Null: collateral is tracked per-position, not aggregated per market."
    totalCollateral: Money
  }

  type MarketHistory {
    daily: [MarketHistoryBucket!]!
    hourly: [MarketHistoryBucket!]!
  }

  type VaultHistoryBucket {
    bucketTimestamp: Int!
    supplyApy1d: Apy
    supplyApy7d: Apy
    supplyApy30d: Apy
    totalSupplied: Money!
  }

  type VaultHistory {
    daily: [VaultHistoryBucket!]!
    hourly: [VaultHistoryBucket!]!
  }

  # ─────────────── positions ───────────────

  type SupplyPosition {
    supplyAmount: Money!
    supplyShares: String!
  }

  # ─────────────── market ───────────────

  type MorphoMarket {
    chain: Chain!
    name: String!
    marketId: String!
    "True when the market has no collateral asset — the vault's idle liquidity sink."
    isIdle: Boolean!

    totalSupplied: Money!
    totalBorrowed: Money!
    liquidityInMarket: Money!
    "Sum over vaults of min(remaining PublicAllocator maxOut, that vault's assets in this market). Zero when no PublicAllocator is deployed or indexed."
    publicAllocatorSharedLiquidity: Money!

    collateralAsset: Token
    loanAsset: Token!

    lltv: Ratio!
    fee: Ratio!

    supplyApy: Apy!
    borrowApy: Apy!
    supplyApy1d: Apy!
    supplyApy7d: Apy!
    supplyApy30d: Apy!
    borrowApy1d: Apy!
    borrowApy7d: Apy!
    borrowApy30d: Apy!
    borrowApyInstantaneous: Apy!

    utilization: Float!
    irm: Irm!
    liquidationPenalty: Float!
    oracleAddress: String
    "Price of one collateral unit in loan-asset terms, derived from indexed USD prices."
    collateralPriceInLoanAsset: Ratio

    vaultAllocations: [MarketVaultAllocation!]!
    historical: MarketHistory!
  }

  type MarketVaultAllocation {
    vault: MorphoVault!
    enabled: Boolean!
    position: SupplyPosition!
    supplyCap: Money!
    marketSupplyShare: Float!
  }

  # ─────────────── vault ───────────────

  type MorphoVault {
    chain: Chain!
    vaultAddress: String!
    name: String!
    symbol: String!
    decimals: Int!
    asset: Token!
    metadata: VaultMetadata!

    totalSupplied: Money!
    totalLiquidity: Money!

    supplyApy: Apy!
    supplyApy1d: Apy!
    supplyApy7d: Apy!
    supplyApy30d: Apy!

    performanceFee: Float!
    feeRecipientAddress: String
    ownerAddress: String
    curatorAddress: String
    "Null: the guardian is not indexed."
    guardianAddress: String

    marketAllocations: [VaultMarketAllocation!]!
    historical: VaultHistory!
  }

  type VaultMarketAllocation {
    market: MorphoMarket!
    vault: MorphoVault!
    enabled: Boolean!
    position: SupplyPosition!
    supplyCap: Money!
    vaultSupplyShare: Float!
  }

  type MorphoVaultPosition {
    vault: MorphoVault!
    accountAddress: String!
    supplyAmount: Money!
    supplyShares: String!
  }

  type MorphoMarketPosition {
    market: MorphoMarket!
    accountAddress: String!
    collateralAmount: Money!
    borrowAmount: Money!
    ltv: Ratio!
  }

  # ─────────────── query plumbing ───────────────

  type PageInfo {
    hasNextPage: Boolean!
  }

  type MorphoVaultPage {
    pageInfo: PageInfo!
    items: [MorphoVault!]!
  }

  type MorphoMarketPage {
    pageInfo: PageInfo!
    items: [MorphoMarket!]!
  }

  type MorphoVaultPositionPage {
    pageInfo: PageInfo!
    items: [MorphoVaultPosition!]!
  }

  type MorphoMarketPositionPage {
    pageInfo: PageInfo!
    items: [MorphoMarketPosition!]!
  }

  input MorphoVaultFilter {
    chainId_in: [ChainId!]
    vaultAddress_in: [Address!]
  }

  input MorphoMarketFilter {
    chainId_in: [ChainId!]
    marketId_in: [Hex!]
  }

  input MorphoVaultPositionFilter {
    chainId_in: [ChainId!]
    vaultAddress_in: [Address!]
    accountAddress_in: [Address!]
  }

  input MorphoMarketPositionFilter {
    chainId_in: [ChainId!]
    marketId_in: [Hex!]
    accountAddress_in: [Address!]
  }

  type Query {
    chains: [Chain!]!
    morphoVaults(where: MorphoVaultFilter, limit: Int = 100): MorphoVaultPage!
    morphoMarkets(where: MorphoMarketFilter, limit: Int = 100): MorphoMarketPage!
    morphoVaultPositions(where: MorphoVaultPositionFilter, limit: Int = 100): MorphoVaultPositionPage!
    morphoMarketPositions(where: MorphoMarketPositionFilter, limit: Int = 100): MorphoMarketPositionPage!
  }
`
