module.exports = class CantonCreatedEventBlob1787784721062 {
    name = 'CantonCreatedEventBlob1787784721062'

    // Adds the raw disclosed-contract blob column to the Canton borrower
    // Position (and Market) tables, so the squid can be the disclosure source
    // for the off-ledger liquidator. Nullable + IF NOT EXISTS so it is
    // additive and idempotent — devnet rows simply carry a null until their
    // next churn re-observes the create with includeCreatedEventBlob set.
    async up(db) {
        await db.query(`ALTER TABLE "canton_position" ADD COLUMN IF NOT EXISTS "created_event_blob" text`)
        await db.query(`ALTER TABLE "canton_market" ADD COLUMN IF NOT EXISTS "created_event_blob" text`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "canton_market" DROP COLUMN "created_event_blob"`)
        await db.query(`ALTER TABLE "canton_position" DROP COLUMN "created_event_blob"`)
    }
}
