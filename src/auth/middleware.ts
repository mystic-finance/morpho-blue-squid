/**
 * Express API-key guard, shared by src/gateway and src/morpho-gateway.
 *
 * On/off is a single flag, MORPHO_API_KEY_GUARD:
 *   - unset / not "true"  → OFF (the default for now): every request is allowed
 *     through, no key needed, no Mongo connection opened.
 *   - "true"              → ON: every data request must carry a valid key.
 *
 * When ON it enforces on data requests only (POST/PUT/PATCH/DELETE) so the GET
 * console page, GET /health, and CORS preflight stay reachable.
 */
import type { IncomingHttpHeaders } from 'http'
import type { Request, Response, NextFunction } from 'express'
import { verifyKey, touchKey, guardEnabled, Role } from './keys'

const ENFORCE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Pull the key from `x-api-key` / `x-morpho-api-key` or `Authorization: Bearer`. */
export function keyFromHeaders(headers: IncomingHttpHeaders): string | null {
    const x = headers['x-api-key'] ?? headers['x-morpho-api-key']
    if (typeof x === 'string' && x.trim()) return x.trim()
    const auth = headers['authorization']
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
    return null
}

const UNAUTHORIZED = {
    missing: 'Missing API key. Send it as the "x-api-key" header or "Authorization: Bearer <key>".',
    invalid: 'Invalid, inactive, or expired API key.',
}

export interface GuardOptions {
    /** Require a specific role (e.g. "admin"). Omit to accept any active key. */
    role?: Role
    /** Paths that skip the guard even on enforced methods (e.g. a health route). */
    exemptPaths?: string[]
}

export function apiKeyGuard(opts: GuardOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Flag OFF → allow everything. This is the default until an operator
        // sets MORPHO_API_KEY_GUARD=true.
        if (!guardEnabled()) return next()

        if (!ENFORCE_METHODS.has(req.method)) return next()
        if (opts.exemptPaths?.some(p => req.path === p)) return next()

        const key = keyFromHeaders(req.headers)
        if (!key) return res.status(401).json({ errors: [{ message: UNAUTHORIZED.missing }] })

        try {
            const match = await verifyKey(key, opts.role)
            if (!match) return res.status(401).json({ errors: [{ message: UNAUTHORIZED.invalid }] })
            touchKey(match.keyHash)
            ;(req as any).apiKey = match
            return next()
        } catch (err: any) {
            console.error('[auth] key verification error:', err?.message)
            return res.status(503).json({ errors: [{ message: 'API key verification unavailable.' }] })
        }
    }
}
