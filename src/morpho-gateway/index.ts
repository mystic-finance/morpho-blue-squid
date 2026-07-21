/**
 * morpho-gateway entry point: `node lib/morpho-gateway/index.js`.
 *
 * Speaks the Morpho blue-api schema verbatim (see ./typeDefs). Reuses the same
 * gateway-config.json chains and pg pools as src/gateway, and reads its config
 * from .env.gateway (falling back to .env) — see ./env, imported first so the
 * variables are set before ./server and its config/db modules load.
 */
import './env'
import { start } from './server'

start().catch(err => {
    console.error('[morpho-gateway] fatal', err)
    process.exit(1)
})
