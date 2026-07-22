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
