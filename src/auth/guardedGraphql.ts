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
 * Ports: the proxy listens on GQL_PORT — the same port the plain squid server
 * would have used, so nothing about how it's published changes. The child
 * squid is moved to an internal port (GQL_PORT + 10000) that never leaves the
 * container. There is no separate port to configure.
 */
import * as http from 'http'
import { spawn } from 'child_process'
import { verifyKey, touchKey, guardEnabled, closeKeys } from './keys'
import { keyFromHeaders } from './middleware'

// squid-graphql-server's own default port is 4000; match it when GQL_PORT is unset.
const publicPort = Number(process.env.GQL_PORT ?? 4000)
const internalPort = publicPort + 10000
const extraArgs = process.argv.slice(2)

// Spawn the real GraphQL server on the internal port. squid-graphql-server
// takes its port from GQL_PORT (it has no --port flag), so we override that in
// the child's env — the child never contends for the public port the proxy owns.
const child = spawn(
    'npx',
    ['squid-graphql-server', ...extraArgs],
    { stdio: 'inherit', env: { ...process.env, GQL_PORT: String(internalPort) } },
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
