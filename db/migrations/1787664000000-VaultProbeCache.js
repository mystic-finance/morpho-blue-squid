/**
 * Persist identifyVault()'s probe verdicts.
 *
 * MetaMorpho/VaultV2 logs are subscribed by topic with no address filter, and
 * two of those topics are the ERC-4626 Deposit/Withdraw that every vault on the
 * chain emits. On Base and Ethereum that means every ERC-4626 address in
 * existence reaches identifyVault(), costing up to 3 eth_calls the first time
 * it is seen.
 *
 * Until now that verdict was cached only in an in-memory Map, so every process
 * restart re-probed the whole chain from cold. On a processor that was
 * crash-looping against a rate-limited RPC endpoint, this was the single
 * largest source of RPC traffic — and on a metered provider it is what burns
 * the monthly quota.
 *
 * The table is deliberately allowed to grow large: one row per distinct
 * ERC-4626 address ever seen is the point. A row is a permanent replacement for
 * 3 RPC calls.
 *
 * Only deterministic verdicts are written by the processor (a contract that
 * answered). Transient RPC failures are never persisted, so a rate-limited
 * probe re-runs later instead of permanently blacklisting a real vault.
 */
module.exports = class VaultProbeCache1787664000000 {
    name = 'VaultProbeCache1787664000000'

    async up(db) {
        await db.query(`
            CREATE TABLE IF NOT EXISTS "vault_probe" (
                "id" character varying NOT NULL,
                "verdict" text NOT NULL,
                "probed_at_block" numeric NOT NULL,
                "updated_at" numeric NOT NULL,
                CONSTRAINT "PK_vault_probe" PRIMARY KEY ("id")
            )
        `)
        // Seed from what the indexer already knows: any vault already modelled
        // is a settled verdict, so it never needs an RPC probe again.
        await db.query(`
            INSERT INTO "vault_probe" ("id", "verdict", "probed_at_block", "updated_at")
            SELECT "id", 'MetaMorpho', 0, 0 FROM "meta_morpho"
            ON CONFLICT ("id") DO NOTHING
        `)
        await db.query(`
            INSERT INTO "vault_probe" ("id", "verdict", "probed_at_block", "updated_at")
            SELECT "id", 'VaultV2', 0, 0 FROM "vault_v2"
            ON CONFLICT ("id") DO NOTHING
        `)
    }

    async down(db) {
        await db.query(`DROP TABLE IF EXISTS "vault_probe"`)
    }
}
