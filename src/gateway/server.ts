/**
 * The gateway HTTP server.
 *
 * Runs as its own process on its own port and mounts at /gateway, so the
 * existing squid-graphql-server endpoints keep serving the entity API exactly
 * as before. Nothing here writes to the database.
 */
import express from 'express'
import {
    buildASTSchema, execute, GraphQLScalarType, GraphQLSchema, isObjectType, parse, specifiedRules,
    validate,
} from 'graphql'
import { typeDefs } from './typeDefs'
import { resolvers } from './resolvers'
import { makeLoaders } from './data'
import { checkConnections, closePools } from './db'
import { loadConfig } from './config'
import { apiKeyGuard } from '../auth/middleware'
import { closeKeys } from '../auth/keys'

/**
 * Attach resolvers to an SDL-built schema by hand. Avoids pulling in a schema
 * builder for what is a single pass over the type map — and it throws on a
 * resolver whose type or field doesn't exist, which catches SDL/resolver drift
 * at boot instead of at request time.
 */
export function buildSchema(sdl: string, resolverMap: Record<string, any>): GraphQLSchema {
    const schema = buildASTSchema(parse(sdl), { assumeValidSDL: true })

    for (const [typeName, fields] of Object.entries(resolverMap)) {
        const type = schema.getType(typeName)
        if (!type) throw new Error(`[gateway] resolver declared for unknown type "${typeName}"`)

        if (fields instanceof GraphQLScalarType) {
            const target = type as GraphQLScalarType
            target.serialize = fields.serialize
            target.parseValue = fields.parseValue
            target.parseLiteral = fields.parseLiteral
            continue
        }

        if (!isObjectType(type)) continue
        const typeFields = type.getFields()
        for (const [fieldName, fn] of Object.entries(fields as Record<string, unknown>)) {
            if (!typeFields[fieldName]) {
                throw new Error(`[gateway] resolver declared for unknown field "${typeName}.${fieldName}"`)
            }
            typeFields[fieldName].resolve = fn as any
        }
    }

    return schema
}

/**
 * Full GraphiQL 3 IDE: schema-aware editor, autocomplete, the Documentation
 * Explorer (browse every type and field), and the field-explorer plugin (tick
 * fields to build a query). It introspects this endpoint on load, so it always
 * reflects the live schema.
 *
 * Assets load from a CDN (unpkg). These gateways set no CSP, so that resolves
 * fine — the earlier plain-textarea fallback was a mistaken response to a CSP
 * that belonged to a different app. When the API-key guard is on, add your key
 * in GraphiQL's Headers tab (\`{"x-api-key": "..."}\`) — introspection is a POST
 * and is guarded too.
 */
export const CONSOLE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GraphQL</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
  <link rel="stylesheet" href="https://unpkg.com/@graphiql/plugin-explorer@3/dist/style.css" />
  <style>
    html, body, #graphiql { height: 100%; margin: 0; }
    #graphiql { min-height: 100vh; }
    .loading { display: flex; height: 100vh; align-items: center; justify-content: center;
               font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #888; }
  </style>
</head>
<body>
  <div id="graphiql"><div class="loading">Loading GraphiQL…</div></div>

  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script src="https://unpkg.com/@graphiql/plugin-explorer@3/dist/index.umd.js"></script>
  <script>
    var endpoint = window.location.pathname;
    try { document.title = 'GraphQL · ' + window.location.host + endpoint; } catch (e) {}

    var fetcher = GraphiQL.createFetcher({ url: endpoint });
    var explorer = GraphiQLPluginExplorer.explorerPlugin();

    var DEFAULT_QUERY = [
      '# Browse the schema in the Docs (top-right) or the Explorer (left).',
      '# Tick fields in the Explorer to build a query, then press ▶ or Ctrl/Cmd+Enter.',
      '',
      'query {',
      '  chains { id }',
      '}',
      ''
    ].join('\\n');

    ReactDOM.createRoot(document.getElementById('graphiql')).render(
      React.createElement(GraphiQL, {
        fetcher: fetcher,
        plugins: [explorer],
        defaultEditorToolsVisibility: true,
        defaultQuery: DEFAULT_QUERY
      })
    );
  </script>
</body>
</html>`

export function createApp() {
    const schema = buildSchema(typeDefs, resolvers as Record<string, any>)
    const basePath = process.env.GATEWAY_PATH ?? '/alt-graphql'

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
        res.json({ ok: true, chains: loadConfig().chains.map(c => ({ id: c.id, key: c.key })) })
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
            // Loaders are per-request: no cross-request caching, so a reader
            // never sees a mix of pre- and post-batch indexer state.
            const result = await execute({
                schema,
                document,
                variableValues: variables,
                operationName,
                contextValue: { loaders: makeLoaders() },
            })
            res.json(result)
        } catch (err: any) {
            console.error('[gateway] execution error:', err)
            res.status(500).json({ errors: [{ message: err.message ?? 'Internal error' }] })
        }
    })

    return app
}

export async function start(): Promise<void> {
    const port = Number(process.env.GATEWAY_PORT ?? 4360)
    const basePath = process.env.GATEWAY_PATH ?? '/alt-graphql'

    await checkConnections()

    const server = createApp().listen(port, () => {
        console.log(`[gateway] listening on http://0.0.0.0:${port}${basePath}`)
    })

    const shutdown = async () => {
        console.log('[gateway] shutting down')
        server.close()
        await closePools()
        await closeKeys()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}
