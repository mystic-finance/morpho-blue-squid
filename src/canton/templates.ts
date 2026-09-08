/**
 * Canton DAML template ids in the package-name form `/v2/updates/flats`
 * accepts.
 *
 * The `#` prefix is mandatory: it tells Canton's ledger API to resolve by
 * upgrade-aware package NAME rather than by raw package ID. This means
 * future DAR upgrades (e.g. mystic-lending-base v1.0.2) transparently route
 * to the new version without indexer redeployment — confirmed via spike,
 * see /Users/0xsammy/morpho-blue-squid/scripts/canton-pkg-check.mjs.
 *
 * Without the `#`, the endpoint parses the value as a package ID and
 * rejects it with INVALID_FIELD.
 */

export const PKG_NAME = 'mystic-lending-base-v3'
export const PKG_NAME_ORACLE = 'mystic-lending-oracle-v3'

export const TEMPLATE_MARKET           = `#${PKG_NAME}:MysticMarket:Market`
export const TEMPLATE_POSITION         = `#${PKG_NAME}:MysticMarket:Position`
export const TEMPLATE_LENDING_POSITION = `#${PKG_NAME}:MysticMarket:LendingPosition`

// Oracle price source for liquidation health (Mode B). Both implement the
// PriceOracle interface; the price is read off the concrete template payload.
export const TEMPLATE_MOCK_ORACLE      = `#${PKG_NAME_ORACLE}:MockOracle:MockOracle`
export const TEMPLATE_CHAINLINK_ORACLE = `#${PKG_NAME_ORACLE}:ChainlinkPriceOracle:ChainlinkPriceOracle`

export const TEMPLATE_LIQUIDATION_PROPOSAL = `#${PKG_NAME}:MysticMarket:LiquidationProposal`

/** Templates the Mode A indexer subscribes to (markets only). */
export const MODE_A_TEMPLATES = [
  TEMPLATE_MARKET,
] as const

/** Mode B: markets + borrower positions + oracle price, for liquidation detection.
 *  (LendingPosition is a lender entity, not needed for liquidation — omitted.) */
export const MODE_B_TEMPLATES = [
  TEMPLATE_MARKET,
  TEMPLATE_POSITION,
  TEMPLATE_MOCK_ORACLE,
  TEMPLATE_CHAINLINK_ORACLE,
] as const

// ────────────────────────────────────────────────────────────────────────
// Testnet (-v5) template set
//
// Mystic's own validator runs the `-v5` DARs. The package NAMES differ from
// devnet's `-v3`, so a testnet processor must subscribe to these ids. The
// module/entity paths and the `#`-name resolution rule are identical; only
// the package name changes. Selected by network via `templatesForNetwork`.
// ────────────────────────────────────────────────────────────────────────

export const PKG_NAME_V5             = 'mystic-lending-base-v5'
export const PKG_NAME_ORACLE_V5      = 'mystic-lending-oracle-v5'
// MockOracle lives in its OWN package (`-oracle-mock-v5`); only ChainlinkPriceOracle
// is in `-oracle-v5`. A `#name` that can't resolve rejects the whole updates stream.
export const PKG_NAME_ORACLE_MOCK_V5 = 'mystic-lending-oracle-mock-v5'

export const TEMPLATE_MARKET_V5           = `#${PKG_NAME_V5}:MysticMarket:Market`
export const TEMPLATE_POSITION_V5         = `#${PKG_NAME_V5}:MysticMarket:Position`
export const TEMPLATE_LENDING_POSITION_V5 = `#${PKG_NAME_V5}:MysticMarket:LendingPosition`
export const TEMPLATE_MOCK_ORACLE_V5      = `#${PKG_NAME_ORACLE_MOCK_V5}:MockOracle:MockOracle`
export const TEMPLATE_CHAINLINK_ORACLE_V5 = `#${PKG_NAME_ORACLE_V5}:ChainlinkPriceOracle:ChainlinkPriceOracle`
export const TEMPLATE_LIQUIDATION_PROPOSAL_V5 = `#${PKG_NAME_V5}:MysticMarket:LiquidationProposal`

/** Mode B, -v5. Testnet oracle is ChainlinkPriceOracle; the mock-oracle package
 *  isn't uploaded there, so subscribing to it 404s the whole update stream. */
export const MODE_B_TEMPLATES_V5 = [
  TEMPLATE_MARKET_V5,
  TEMPLATE_POSITION_V5,
  TEMPLATE_CHAINLINK_ORACLE_V5,
] as const

export type CantonNetwork = 'devnet' | 'testnet'

/** Normalise the `CANTON_NETWORK` env value; anything but `testnet` is devnet. */
export function resolveCantonNetwork(raw?: string | null): CantonNetwork {
  return String(raw ?? 'devnet').toLowerCase() === 'testnet' ? 'testnet' : 'devnet'
}

/** The Mode B template set for a network: `-v5` on testnet, `-v3` on devnet. */
export function templatesForNetwork(network: CantonNetwork): readonly string[] {
  return network === 'testnet' ? MODE_B_TEMPLATES_V5 : MODE_B_TEMPLATES
}
