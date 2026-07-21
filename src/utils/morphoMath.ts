/**
 * Pure Morpho Blue protocol math, shared by the indexer and the gateway so
 * there is exactly one definition of each formula.
 */

export const WAD = 1e18

/**
 * Morpho Blue's liquidation incentive factor is a pure function of LLTV —
 * there is no per-market parameter and no event carrying it:
 *
 *   LIF = min(MAX_LIF, 1 / (1 - CURSOR * (1 - lltv)))
 *
 * with CURSOR = 0.3 and MAX_LIF = 1.15, matching
 * morpho-blue/src/libraries/ConstantsLib.sol. The penalty is the part above
 * par, i.e. LIF - 1, expressed as a fraction (0.0438 = 4.38%) to match how
 * this schema stores every other rate.
 */
export const LIQUIDATION_CURSOR = 0.3
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15

export function liquidationPenaltyFromLltv(lltvWad: bigint | string | number): number {
    const lltv = lltvToFraction(lltvWad)
    if (lltv <= 0 || lltv >= 1) return 0
    const lif = Math.min(
        MAX_LIQUIDATION_INCENTIVE_FACTOR,
        1 / (1 - LIQUIDATION_CURSOR * (1 - lltv)),
    )
    return lif - 1
}

/** WAD-scaled LLTV to a 0..1 fraction. */
export function lltvToFraction(lltvWad: bigint | string | number): number {
    return Number(BigInt(lltvWad as any)) / WAD
}
