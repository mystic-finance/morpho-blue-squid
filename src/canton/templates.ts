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

export const PKG_NAME = 'mystic-lending-base'

export const TEMPLATE_MARKET           = `#${PKG_NAME}:MysticMarket:Market`
export const TEMPLATE_POSITION         = `#${PKG_NAME}:MysticMarket:Position`
export const TEMPLATE_LENDING_POSITION = `#${PKG_NAME}:MysticMarket:LendingPosition`

// Templates we'll need for Mode B (full read-path migration). Kept here for
// reference; the indexer doesn't subscribe to them in Mode A.
export const TEMPLATE_PRICE_PROPOSAL       = `#${PKG_NAME}:MysticMarket:PriceProposal`
export const TEMPLATE_WITHDRAWAL_PROPOSAL  = `#${PKG_NAME}:MysticMarket:WithdrawalProposal`
export const TEMPLATE_LIQUIDATION_PROPOSAL = `#${PKG_NAME}:MysticMarket:LiquidationProposal`

/** Templates the Mode A indexer subscribes to. */
export const MODE_A_TEMPLATES = [
  TEMPLATE_MARKET,
] as const

/** Templates Mode B will add (positions for portfolio queries). */
export const MODE_B_TEMPLATES = [
  TEMPLATE_POSITION,
  TEMPLATE_LENDING_POSITION,
] as const
