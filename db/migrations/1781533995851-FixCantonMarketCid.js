module.exports = class FixCantonMarketCid1781533995851 {
    name = 'FixCantonMarketCid1781533995851'

    // The base migration (Data1781533995850) created canton_market with a
    // "current_contract_id" column, but the CantonMarket entity field was
    // later renamed to `marketCid` (column "market_cid"). The model/handlers
    // write/read "market_cid", so inserts fail with
    //   column CantonMarket.market_cid does not exist
    // This incremental rename brings the table in line with the entity. It is
    // safe on a fresh DB (the base creates current_contract_id first, then this
    // renames it) and on an already-created DB (renames in place, no data loss).
    //
    // Guarded so it is a no-op when the column has already been renamed. A
    // database whose `migrations` ledger has drifted (schema present, rows
    // missing) replays every migration from the start; without the guard this
    // one aborts the whole batch, and since squid runs all pending migrations
    // in a single transaction, that rolls back everything.
    async up(db) {
        await db.query(`
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'canton_market' AND column_name = 'current_contract_id'
                ) THEN
                    ALTER TABLE "canton_market" RENAME COLUMN "current_contract_id" TO "market_cid";
                END IF;
            END $$
        `)
    }

    async down(db) {
        await db.query(`ALTER TABLE "canton_market" RENAME COLUMN "market_cid" TO "current_contract_id"`)
    }
}
