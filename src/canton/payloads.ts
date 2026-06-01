/**
 * Typed shapes for the DAML payloads we read out of Canton create events.
 *
 * Hand-typed from the DAML source rather than auto-generated to keep the
 * indexer free of a `daml codegen js` build step. Re-derive when the
 * MysticMarket DAML changes — source of truth:
 *
 *   /Users/0xsammy/DAML-curated-lending/base/daml/MysticMarket.daml
 *   /Users/0xsammy/DAML-curated-lending/base/daml/MysticTypes.daml
 *
 * Canton's JSON Ledger API v2 serializes:
 *   - `Numeric 10`              → decimal string ("1234.5678900000")
 *   - `Party` / `ContractId T`  → string
 *   - `Time`                    → ISO-8601 UTC string
 *   - record                    → JSON object
 *   - list                      → JSON array
 *
 * All numeric fields below are STRINGS (preserves precision). Convert with
 * `BigInt(string.split('.')[0])` for whole-unit ints, or with a fixed-point
 * helper for Numeric 10 → bigint (multiply by 1e10 then trunc).
 */

// ─── Common ─────────────────────────────────────────────────────────────

/** Splice Token Standard instrument id (from Splice.Api.Token.HoldingV1). */
export interface InstrumentId {
  admin: string   // registrar party
  id: string      // human-readable symbol ("Amulet", "testUSDCx", "CBTC", …)
}

// ─── MysticMarket.MarketParams ──────────────────────────────────────────

export interface MarketParams {
  loanInstrument: InstrumentId
  collateralInstrument: InstrumentId
  loanToken: string                   // text alias of loanInstrument.id
  collateralToken: string             // text alias of collateralInstrument.id
  oracle: string                      // ContractId PriceOracle — THIS is the churn-stable identity
  irmProvider: string                 // party
  lltv: string                        // Numeric 10
  liquidationThreshold: string        // Numeric 10
  fee: string                         // Numeric 10
  liquidationBonus: string            // Numeric 10
  irmConfigCid: string                // ContractId IRMConfig
}

// ─── MysticTypes.IRMState ───────────────────────────────────────────────

export interface IRMState {
  currentRate: string                 // Numeric 10 — annualised borrow rate
  rateAtTarget: string
  initialRateAtTarget: string
  targetUtilization: string
  adjustmentSpeed: string
  curveSteepness: string
  minRateAtTarget: string
  maxRateAtTarget: string
  lastTimestamp: string               // ISO timestamp
}

// ─── MysticMarket.Market (template payload) ─────────────────────────────

export interface MarketPayload {
  public: string                      // party
  params: MarketParams
  provider: string                    // party
  poolCustodian: string               // party
  observers: string[]
  feeRecipient: string                // party
  fee: string                         // Numeric 10
  liquidationBonus: string            // Numeric 10
  totalBorrowAssets: string           // Numeric 10
  totalBorrowShares: string
  totalSupplyAssets: string
  totalSupplyShares: string
  irm: IRMState
}

// ─── MysticMarket.Position (template payload) ───────────────────────────

export interface PositionPayload {
  provider: string
  owner: string                       // borrower party
  observers: string[]
  marketCid: string                   // ContractId Market — churns; resolve via lineage
  loanSymbol: string
  collateralSymbol: string
  collateralInstrument: InstrumentId
  collateralAmount: string            // Numeric 10
  borrowShares: string                // Numeric 10
}

// ─── MysticMarket.LendingPosition (template payload) ────────────────────

export interface LendingPositionPayload {
  provider: string
  depositor: string                   // party
  shares: string                      // Numeric 10
  loanSymbol: string
  marketCid: string                   // ContractId Market — churns
  loanInstrument: InstrumentId
}

// ─── Canton Update-Stream event shape (REST /v2/updates/flats) ──────────
//
// The endpoint returns an array of update wrappers. The spike confirmed:
//   [{ update: { Transaction: { value: {
//       updateId, commandId, workflowId, effectiveAt,
//       events: [{ CreatedEvent: { offset, nodeId, contractId, ... } }, ...]
//   }}}}, ...]
//
// We normalise this into a flat list at the processor boundary so handlers
// don't have to know the variant tags. The CantonEvent type is what reaches
// the handler.

export type CantonEventKind = 'created' | 'archived'

export interface CantonEvent<TPayload = unknown> {
  /** Per-event offset on the ledger; monotonically increasing. */
  offset: string
  /** Record time of the enclosing transaction (effectiveAt). */
  recordTime: bigint
  /** Transaction id this event belongs to (multiple events may share). */
  transactionId: string
  /** Stable template id in package-name form (`#pkgName:Module:Entity`). */
  templateId: string
  /** Contract id of the contract created or archived. */
  contractId: string
  /** Variant tag — created or archived. */
  kind: CantonEventKind
  /** Raw payload from the ledger. Only populated for `created` events. */
  payload: TPayload | null
}

// Type guards for narrowing CantonEvent.payload at the handler boundary.

export function isMarketEvent(evt: CantonEvent): evt is CantonEvent<MarketPayload> {
  return /:MysticMarket:Market$/.test(evt.templateId)
}

export function isPositionEvent(evt: CantonEvent): evt is CantonEvent<PositionPayload> {
  return /:MysticMarket:Position$/.test(evt.templateId)
}

export function isLendingPositionEvent(evt: CantonEvent): evt is CantonEvent<LendingPositionPayload> {
  return /:MysticMarket:LendingPosition$/.test(evt.templateId)
}
