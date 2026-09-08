/**
 * FiveNorth client_credentials auth, ported from
 * /Users/0xsammy/backend/src/modules/canton/services/fivenorth-auth.service.ts
 *
 * Same grant body (client_credentials with `scope: 'daml_ledger_api'`) and
 * same 10-min refresh-buffer policy as the backend uses. Standalone here
 * because the squid runs out-of-process from the backend.
 *
 * Concurrent callers share a single in-flight refresh promise so we never
 * fire two token requests at once.
 */

import { createHmac } from 'crypto'

interface TokenResponse {
  access_token: string
  expires_in: number      // seconds
  token_type: string
}

const REFRESH_BUFFER_MS = 10 * 60 * 1000  // refresh if token expires within 10 min

/**
 * Common surface the processor consumes. Both the FiveNorth OAuth provider
 * (devnet) and the unsafe HS256 provider (testnet) implement it, so the
 * processor is auth-mode agnostic — it only ever calls these two methods.
 */
export interface CantonAuth {
  getAccessToken(): Promise<string>
  forceRefresh(): Promise<string>
}

export interface FiveNorthAuthConfig {
  /** OIDC token endpoint. Defaults to FiveNorth devnet's. */
  authUrl?: string
  clientId: string
  clientSecret: string
  /** Defaults to `clientId` if not provided — matches backend behaviour. */
  audience?: string
}

export class FiveNorthAuth implements CantonAuth {
  private readonly authUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly audience: string

  private accessToken: string | null = null
  private tokenExpiry: Date | null = null
  private refreshPromise: Promise<string> | null = null

  constructor(cfg: FiveNorthAuthConfig) {
    this.authUrl = cfg.authUrl ?? 'https://auth.sandbox.fivenorth.io/application/o/token/'
    this.clientId = cfg.clientId
    this.clientSecret = cfg.clientSecret
    this.audience = cfg.audience ?? cfg.clientId
  }

  static fromEnv(): FiveNorthAuth {
    const clientId     = required('FIVENORTH_CLIENT_ID')
    const clientSecret = required('FIVENORTH_CLIENT_SECRET')
    const audience     = process.env.FIVENORTH_AUDIENCE || clientId
    const authUrl      = process.env.FIVENORTH_AUTH_URL
    return new FiveNorthAuth({ clientId, clientSecret, audience, authUrl })
  }

  /**
   * Returns a valid access token. Cached until 10 min before expiry. If
   * another call is currently refreshing, awaits its result.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry) {
      const bufferAhead = new Date(Date.now() + REFRESH_BUFFER_MS)
      if (this.tokenExpiry > bufferAhead) return this.accessToken
    }
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = this.fetchNewToken().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /**
   * Drop the cached token and fetch a fresh one. Call this when the ledger
   * returns 401 / 403 mid-poll — caller is expected to retry the failed
   * request once after this resolves.
   */
  async forceRefresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise
    this.accessToken = null
    this.tokenExpiry = null
    return this.getAccessToken()
  }

  private async fetchNewToken(): Promise<string> {
    const r = await fetch(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        audience:      this.audience,
        scope:         'daml_ledger_api',
      }),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`FiveNorth auth ${r.status}: ${body.slice(0, 200)}`)
    }
    const j = (await r.json()) as TokenResponse
    this.accessToken = j.access_token
    this.tokenExpiry = new Date(Date.now() + j.expires_in * 1000)
    return this.accessToken
  }
}

/**
 * Unsafe HS256 token provider for Mystic's own testnet validator, which
 * accepts symmetric-key JWTs instead of OAuth. Mints `HS256({ iat, aud, sub },
 * secret)` with NO `exp` — the validator's unsafe auth does not enforce
 * expiry — and no network round-trip. `forceRefresh` re-mints with a fresh
 * `iat` so a 401 path behaves the same as the OAuth provider.
 *
 * NEVER point this at a real network: the shared secret grants read access to
 * any party the token names. It exists only for the local/unsafe testnet.
 */
export interface UnsafeTokenAuthConfig {
  /** JWT `aud`. Defaults to the validator's unsafe placeholder audience. */
  audience?: string
  /** JWT `sub` — the ledger read user (party prefix before `::`). */
  subject: string
  /** HMAC secret. Defaults to `unsafe`. */
  secret?: string
}

export class UnsafeTokenAuth implements CantonAuth {
  private readonly audience: string
  private readonly subject: string
  private readonly secret: string
  private token: string | null = null

  constructor(cfg: UnsafeTokenAuthConfig) {
    this.audience = cfg.audience ?? 'https://ledger_api.example.com'
    this.subject = cfg.subject
    this.secret = cfg.secret ?? 'unsafe'
  }

  static fromEnv(): UnsafeTokenAuth {
    // sub = the read user name: the party's prefix before `::` (MysticProvider),
    // unless overridden. The party itself comes from CANTON_PUBLIC_PARTY.
    const party = required('CANTON_PUBLIC_PARTY')
    const subject = process.env.CANTON_TESTNET_AUTH_SUBJECT || party.split('::')[0]
    const audience = process.env.CANTON_TESTNET_AUTH_AUDIENCE || 'https://ledger_api.example.com'
    const secret = process.env.CANTON_TESTNET_AUTH_SECRET || 'unsafe'
    return new UnsafeTokenAuth({ audience, subject, secret })
  }

  async getAccessToken(): Promise<string> {
    if (!this.token) this.token = this.mint()
    return this.token
  }

  async forceRefresh(): Promise<string> {
    this.token = this.mint()
    return this.token
  }

  private mint(): string {
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = { iat: Math.floor(Date.now() / 1000), aud: this.audience, sub: this.subject }
    const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
    const sig = createHmac('sha256', this.secret).update(signingInput).digest()
    return `${signingInput}.${b64url(sig)}`
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}
