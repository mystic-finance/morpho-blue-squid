/**
 * Guarded squid-graphql-server: the API-key guard in front of a per-chain
 * indexer GraphQL API.
 *
 * squid-graphql-server is a packaged binary with no middleware hook, so this
 * wrapper spawns it on an internal port and reverse-proxies the public port
 * through the same API-key check the gateways use. Any extra CLI args (e.g.
 * `--dumb-cache ...`) are forwarded to the child unchanged.
 *
 * Same flag as everywhere else: MORPHO_API_KEY_GUARD unset/≠"true" → pure
 * passthrough (no key required, no Mongo connection). "true" → POST requests
 * must carry a valid key.
 *
 * Env:
 *   GUARD_PUBLIC_PORT     port clients hit (default GQL_PORT, else 4350)
 *   GUARD_INTERNAL_PORT   port the child squid server listens on (default public + 10000)
 */
import * as http from 'http'
import { spawn } from 'child_process'
import { verifyKey, touchKey, guardEnabled, closeKeys } from './keys'
import { keyFromHeaders } from './middleware'

const publicPort = Number(process.env.GUARD_PUBLIC_PORT ?? process.env.GQL_PORT ?? 4350)
const internalPort = Number(process.env.GUARD_INTERNAL_PORT ?? publicPort + 10000)
const extraArgs = process.argv.slice(2)

// Spawn the real GraphQL server on the internal port. --port overrides any
// GQL_PORT in the environment, so the child never contends for the public port.
const child = spawn(
    'npx',
    ['squid-graphql-server', '--port', String(internalPort), ...extraArgs],
    { stdio: 'inherit', env: process.env },
)
child.on('exit', code => {
    console.error(`[auth] squid-graphql-server exited (${code}) — shutting down proxy`)
    process.exit(code ?? 1)
})

async function authorized(req: http.IncomingMessage): Promise<boolean> {
    const key = keyFromHeaders(req.headers)
    if (!key) return false
    const match = await verifyKey(key)
    if (!match) return false
    touchKey(match.keyHash)
    return true
}

const server = http.createServer(async (req, res) => {
    // Enforce on POST only (the GraphQL data path); GET playground/health pass.
    if (guardEnabled() && req.method === 'POST') {
        let ok = false
        try {
            ok = await authorized(req)
        } catch (err: any) {
            console.error('[auth] key verification error:', err?.message)
            res.writeHead(503, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ errors: [{ message: 'API key verification unavailable.' }] }))
        }
        if (!ok) {
            res.writeHead(401, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ errors: [{ message: 'Invalid, inactive, or expired API key.' }] }))
        }
    }

    // Stream the request through to the child, unparsed, and pipe the reply back.
    const upstream = http.request(
        { hostname: '127.0.0.1', port: internalPort, path: req.url, method: req.method, headers: req.headers },
        up => {
            res.writeHead(up.statusCode ?? 502, up.headers)
            up.pipe(res)
        },
    )
    upstream.on('error', err => {
        console.error('[auth] upstream error:', err.message)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ errors: [{ message: 'Upstream GraphQL server unavailable.' }] }))
    })
    req.pipe(upstream)
})

// Subscriptions (ws) are not enabled on these servers (no --subscriptions), so
// upgrade requests are refused rather than proxied unguarded.
server.on('upgrade', (_req, socket) => socket.destroy())

server.listen(publicPort, () => {
    console.log(
        `[auth] guarded graphql on :${publicPort} → squid :${internalPort} ` +
        `(guard ${guardEnabled() ? 'ON' : 'OFF — allowing all'})`,
    )
})

const shutdown = async () => {
    server.close()
    child.kill('SIGTERM')
    await closeKeys()
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
