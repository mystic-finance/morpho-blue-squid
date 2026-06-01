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

interface TokenResponse {
  access_token: string
  expires_in: number      // seconds
  token_type: string
}

const REFRESH_BUFFER_MS = 10 * 60 * 1000  // refresh if token expires within 10 min

export interface FiveNorthAuthConfig {
  /** OIDC token endpoint. Defaults to FiveNorth devnet's. */
  authUrl?: string
  clientId: string
  clientSecret: string
  /** Defaults to `clientId` if not provided — matches backend behaviour. */
  audience?: string
}

export class FiveNorthAuth {
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

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}
