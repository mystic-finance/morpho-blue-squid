/**
 * AdaptiveCurveIRM curve reconstruction.
 *
 * Morpho's adaptive curve prices borrowing as a fixed multiplier on a slowly
 * moving `rateAtTarget`:
 *
 *   err(u)  = u < uTarget ? (u - uTarget) / uTarget
 *                         : (u - uTarget) / (1 - uTarget)
 *   coeff   = err < 0 ? 1 - 1/steepness : steepness - 1
 *   mult(u) = coeff * err(u) + 1
 *   rate(u) = rateAtTarget * mult(u)
 *
 * `rateAtTarget` lives in the IRM contract and is not indexed. Rather than
 * add an RPC dependency to a read-only gateway, we invert the relation: the
 * indexer already stores the market's current borrow APY at its current
 * utilization, and mult() is known, so
 *
 *   rateAtTarget = currentBorrowApy / mult(currentUtilization)
 *
 * recovers it exactly (up to the linear annualisation the indexer uses, which
 * cancels because it scales both sides identically). The curve is then sampled
 * from that. A market that has never accrued interest has a zero APY and
 * therefore a flat zero curve, which is the honest answer.
 */
import { IrmConfig } from './config'

export interface CurvePoint {
    utilization: number
    supplyApy: number
    borrowApy: number
}

/**
 * AdaptiveCurveIrm constants, from morpho-blue-irm/src/adaptive-curve-irm/
 * libraries/ConstantsLib.sol, converted to the linear annualised form the
 * indexer stores (per-second rate x seconds per year):
 *
 *   INITIAL_RATE_AT_TARGET = 4%   APR
 *   MIN_RATE_AT_TARGET     = 0.1% APR
 *   MAX_RATE_AT_TARGET     = 200% APR
 *
 * The contract clamps rateAtTarget to [MIN, MAX] on every accrual, so the
 * borrow rate is never zero: at u = 0 the multiplier bottoms out at
 * 1 - 1/steepness = 0.25, giving a floor of 0.025% APR.
 */
export const INITIAL_RATE_AT_TARGET = 0.04
export const MIN_RATE_AT_TARGET = 0.001
export const MAX_RATE_AT_TARGET = 2.0

function multiplier(u: number, target: number, steepness: number): number {
    const err = u < target
        ? (u - target) / target
        : (u - target) / (1 - target)
    const coeff = err < 0 ? 1 - 1 / steepness : steepness - 1
    return coeff * err + 1
}

/**
 * Recover rateAtTarget from an observed (rate, utilization) pair.
 *
 * `currentBorrowApy` of zero does not mean the market's rate is zero — the
 * contract cannot produce that. It means we have never observed one: the
 * indexer writes market.borrow_apy only on AccrueInterest, so a market that
 * has been created but never accrued still holds its initial zero. Such a
 * market is, by definition, still sitting at the contract's
 * INITIAL_RATE_AT_TARGET, since rateAtTarget only moves during accrual.
 *
 * The result is clamped to the contract's own bounds, which also absorbs the
 * rounding error in inverting a rate recorded at limited precision.
 */
export function rateAtTarget(
    currentBorrowApy: number,
    currentUtilization: number,
    cfg: IrmConfig,
): number {
    const initial = cfg.initialRateAtTarget ?? INITIAL_RATE_AT_TARGET
    const min = cfg.minRateAtTarget ?? MIN_RATE_AT_TARGET
    const max = cfg.maxRateAtTarget ?? MAX_RATE_AT_TARGET

    if (!(currentBorrowApy > 0)) return initial

    const m = multiplier(currentUtilization, cfg.targetUtilization, cfg.curveSteepness)
    if (!(m > 0)) return initial

    return Math.min(max, Math.max(min, currentBorrowApy / m))
}

/**
 * Sample the curve across [0, 1]. Points are denser around the target
 * utilization, which is where the curve bends and where callers plotting it
 * actually need resolution.
 */
export function buildCurve(
    currentBorrowApy: number,
    currentUtilization: number,
    feeWad: number,
    cfg: IrmConfig,
): CurvePoint[] {
    const base = rateAtTarget(currentBorrowApy, currentUtilization, cfg)
    const target = cfg.targetUtilization

    const samples = new Set<number>()
    for (let i = 0; i <= 20; i++) samples.add(i / 20)
    for (const d of [-0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.05]) {
        const u = target + d
        if (u >= 0 && u <= 1) samples.add(Number(u.toFixed(4)))
    }
    samples.add(currentUtilization)

    return [...samples]
        .filter(u => u >= 0 && u <= 1)
        .sort((a, b) => a - b)
        .map(u => {
            const borrowApy = base * multiplier(u, target, cfg.curveSteepness)
            // Lenders earn the borrow rate scaled by utilization, net of fee.
            const supplyApy = borrowApy * u * (1 - feeWad)
            return { utilization: u, supplyApy, borrowApy }
        })
}
