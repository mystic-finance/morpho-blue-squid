module.exports = class Data1784537191856 {
    name = 'Data1784537191856'

    // IF NOT EXISTS so a database whose `migrations` ledger has drifted can
    // replay the full set without aborting the batch (all pending migrations
    // share one transaction, so any single failure rolls back everything).
    async up(db) {
        await db.query(`ALTER TABLE "market" ADD COLUMN IF NOT EXISTS "oracle_price" numeric`)
        await db.query(`ALTER TABLE "market" ADD COLUMN IF NOT EXISTS "oracle_price_updated_at" numeric`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "market" DROP COLUMN "oracle_price"`)
        await db.query(`ALTER TABLE "market" DROP COLUMN "oracle_price_updated_at"`)
    }
}
