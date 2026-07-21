/**
 * Backfill market.maximum_ltv / liquidation_threshold / liquidation_penalty.
 *
 * These three columns were written as 0 at CreateMarket and never updated, so
 * every market indexed before this migration holds zeros. All three are pure
 * functions of LLTV, so they can be recomputed in place — no re-index needed.
 *
 * Mirrors liquidationPenaltyFromLltv() in src/utils/morphoMath.ts:
 *   LIF = min(1.15, 1 / (1 - 0.3 * (1 - lltv)))  and penalty = LIF - 1.
 *
 * Markets with an out-of-range LLTV (0, or >= 100%) keep a zero penalty,
 * matching the helper's guard.
 */
module.exports = class BackfillLiquidationParams1784512500000 {
    name = 'BackfillLiquidationParams1784512500000'

    async up(db) {
        await db.query(`
            UPDATE "market"
            SET "maximum_ltv"           = "lltv" / 1000000000000000000::numeric,
                "liquidation_threshold" = "lltv" / 1000000000000000000::numeric,
                "liquidation_penalty"   = LEAST(
                    1.15::numeric,
                    1 / (1 - 0.3 * (1 - "lltv" / 1000000000000000000::numeric))
                ) - 1
            WHERE "lltv" > 0 AND "lltv" < 1000000000000000000::numeric
        `)
    }

    async down(db) {
        await db.query(`
            UPDATE "market"
            SET "maximum_ltv" = 0, "liquidation_threshold" = 0, "liquidation_penalty" = 0
        `)
    }
}
