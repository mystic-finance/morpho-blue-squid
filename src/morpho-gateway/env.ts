/**
 * Side-effect module: load env before anything else imports it.
 *
 * Imported first in index.ts. Because ES module imports are hoisted and run in
 * order, this guarantees .env.gateway / .env are applied before ./server (and
 * the config/db modules it pulls in) are evaluated.
 *
 * .env.gateway wins; .env only fills gaps (dotenv never overrides an already
 * set variable).
 */
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

const envGateway = path.resolve(process.cwd(), '.env.gateway')
if (fs.existsSync(envGateway)) {
    dotenv.config({ path: envGateway })
    console.log('[morpho-gateway] loaded .env.gateway')
}
dotenv.config()
