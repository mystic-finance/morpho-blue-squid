/**
 * The morpho-gateway HTTP server.
 *
 * A second read-only endpoint alongside src/gateway, on its own port and path
 * (default /graphql), speaking the Morpho blue-api schema verbatim. It shares
 * everything underneath — the same gateway-config.json chains, the same pg
 * pools, the same per-request loaders — and owns none of it: no writes, no
 * migrations, independent start/stop.
 */
import express from 'express'
import { execute, parse, specifiedRules, validate } from 'graphql'
import { buildSchema, CONSOLE_HTML } from '../gateway/server'
import { checkConnections, closePools } from '../gateway/db'
import { makeLoaders } from '../gateway/data'
import { loadConfig } from '../gateway/config'
import { apiKeyGuard } from '../auth/middleware'
import { closeKeys } from '../auth/keys'
import { typeDefs } from './typeDefs'
import { resolvers } from './resolvers'

export function createApp() {
    const schema = buildSchema(typeDefs, resolvers as Record<string, any>)
    const basePath = process.env.MORPHO_GATEWAY_PATH ?? '/graphql'

    const app = express()
    app.use(express.json({ limit: process.env.GATEWAY_BODY_LIMIT ?? '1mb' }))

    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', process.env.GATEWAY_CORS_ORIGIN ?? '*')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        if (req.method === 'OPTIONS') return res.sendStatus(204)
        next()
    })

    // API-key guard: no-op unless MORPHO_API_KEY_GUARD=true. Health stays open.
    app.use(apiKeyGuard({ exemptPaths: [`${basePath}/health`] }))

    app.get(`${basePath}/health`, (_req, res) => {
        res.json({ ok: true, schema: 'morpho-blue-api', chains: loadConfig().chains.map(c => ({ id: c.id, key: c.key })) })
    })

    app.get(basePath, (_req, res) => {
        res.type('html').send(CONSOLE_HTML)
    })

    app.post(basePath, async (req, res) => {
        const { query, variables, operationName } = req.body ?? {}
        if (typeof query !== 'string') {
            return res.status(400).json({ errors: [{ message: 'Missing "query" in request body' }] })
        }

        let document
        try {
            document = parse(query)
        } catch (err: any) {
            return res.status(400).json({ errors: [{ message: err.message }] })
        }

        const validationErrors = validate(schema, document, specifiedRules)
        if (validationErrors.length > 0) {
            return res.status(400).json({ errors: validationErrors.map(e => ({ message: e.message, locations: e.locations })) })
        }

        try {
            const result = await execute({
                schema,
                document,
                variableValues: variables,
                operationName,
                contextValue: { loaders: makeLoaders() },
            })
            res.json(result)
        } catch (err: any) {
            console.error('[morpho-gateway] execution error:', err)
            res.status(500).json({ errors: [{ message: err.message ?? 'Internal error' }] })
        }
    })

    return app
}

export async function start(): Promise<void> {
    const port = Number(process.env.MORPHO_GATEWAY_PORT ?? 4370)
    const basePath = process.env.MORPHO_GATEWAY_PATH ?? '/graphql'

    await checkConnections()

    const server = createApp().listen(port, () => {
        console.log(`[morpho-gateway] listening on http://0.0.0.0:${port}${basePath}`)
    })

    const shutdown = async () => {
        console.log('[morpho-gateway] shutting down')
        server.close()
        await closePools()
        await closeKeys()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}
