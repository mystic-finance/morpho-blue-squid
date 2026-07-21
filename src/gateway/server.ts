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
 * A self-contained query console — no external scripts, so it renders even
 * under a strict CSP or offline (the CDN-hosted GraphiQL it replaced showed a
 * blank/read-only page in those environments). Everything is inline: a query
 * pane, a variables pane, Run, and a results pane that POSTs to this path.
 */
export const CONSOLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Gateway</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         height: 100vh; display: flex; flex-direction: column; background: #1e1e1e; color: #d4d4d4; }
  header { padding: 8px 12px; background: #252526; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; }
  header b { color: #4ec9b0; } header .hint { color: #808080; font-size: 12px; }
  button { background: #0e639c; color: #fff; border: 0; border-radius: 4px; padding: 7px 16px; cursor: pointer; font-size: 14px; }
  button:hover { background: #1177bb; } button:disabled { opacity: .5; cursor: default; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #333; min-height: 0; }
  .col { display: flex; flex-direction: column; min-height: 0; background: #1e1e1e; }
  .col > label { padding: 6px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #808080; background: #252526; }
  textarea, pre { flex: 1; margin: 0; border: 0; padding: 12px; background: #1e1e1e; color: #d4d4d4;
                  font: 13px/1.5 "SF Mono", Menlo, Consolas, monospace; resize: none; overflow: auto; white-space: pre; tab-size: 2; }
  textarea:focus { outline: none; }
  .left { display: grid; grid-template-rows: 1fr auto; min-height: 0; }
  .vars { max-height: 30vh; }
  pre.err { color: #f48771; }
</style></head>
<body>
<header>
  <b>Gateway</b>
  <button id="run">Run ▶</button>
  <span class="hint">⌘/Ctrl + Enter to run · POSTs to this endpoint</span>
</header>
<main>
  <div class="col left">
    <div class="col" style="min-height:0">
      <label>Query</label>
      <textarea id="query" spellcheck="false" placeholder="query { chains { id name } }"></textarea>
    </div>
    <div class="col vars">
      <label>Variables (JSON)</label>
      <textarea id="vars" spellcheck="false" placeholder="{}"></textarea>
    </div>
  </div>
  <div class="col">
    <label>Response</label>
    <pre id="out"></pre>
  </div>
</main>
<script>
  var q = document.getElementById('query'), v = document.getElementById('vars'),
      out = document.getElementById('out'), btn = document.getElementById('run');
  q.value = 'query {\\n  chains { id name }\\n}';
  try { var s = localStorage.getItem('gw.query'); if (s) q.value = s;
        var sv = localStorage.getItem('gw.vars'); if (sv) v.value = sv; } catch (e) {}
  async function run() {
    localStorage.setItem('gw.query', q.value); localStorage.setItem('gw.vars', v.value);
    var variables = undefined;
    if (v.value.trim()) {
      try { variables = JSON.parse(v.value); }
      catch (e) { out.className = 'err'; out.textContent = 'Variables are not valid JSON: ' + e.message; return; }
    }
    btn.disabled = true; out.className = ''; out.textContent = 'Running…';
    try {
      var res = await fetch(window.location.pathname, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.value, variables: variables }),
      });
      var json = await res.json();
      out.className = json.errors ? 'err' : '';
      out.textContent = JSON.stringify(json, null, 2);
    } catch (e) { out.className = 'err'; out.textContent = 'Request failed: ' + e.message; }
    finally { btn.disabled = false; }
  }
  btn.addEventListener('click', run);
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
  // Allow tab to indent inside the query editor.
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') { e.preventDefault();
      var s = this.selectionStart, en = this.selectionEnd;
      this.value = this.value.slice(0, s) + '  ' + this.value.slice(en);
      this.selectionStart = this.selectionEnd = s + 2; }
  });
</script>
</body></html>`

export function createApp() {
    const schema = buildSchema(typeDefs, resolvers as Record<string, any>)
    const basePath = process.env.GATEWAY_PATH ?? '/gateway'

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
    const basePath = process.env.GATEWAY_PATH ?? '/gateway'

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
