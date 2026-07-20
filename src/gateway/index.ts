/**
 * Gateway entry point: `node lib/gateway/index.js`.
 *
 * Separate from src/main.ts on purpose — the gateway is a reader and must be
 * able to start, restart, and fail independently of the indexer processes.
 */
import 'dotenv/config'
import { start } from './server'

start().catch(err => {
    console.error('[gateway] fatal', err)
    process.exit(1)
})
