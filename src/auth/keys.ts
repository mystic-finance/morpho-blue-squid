/**
 * API-key verification against the shared `morpho_api_keys` Mongo collection.
 *
 * This is the read side of the backend's MorphoApiKeyService: keys are minted,
 * renewed and revoked there; here we only verify. The scheme is identical so a
 * key issued by the backend works unchanged — sha256(plaintext) is matched
 * against `keyHash`, and a doc counts only when `isActive` and unexpired.
 *
 * Config (env):
 *   MORPHO_API_KEY_GUARD          "true" to enforce; anything else = disabled (no-op)
 *   MORPHO_MONGO_URI / MONGO_URI  connection string (required when enabled)
 *   MORPHO_MONGO_DB               database name (optional; else the URI's default db)
 *   MORPHO_API_KEYS_COLLECTION    collection name (default "morpho_api_keys")
 */
import { createHash } from 'crypto'
import { MongoClient, Collection } from 'mongodb'

/** Minimum plaintext length accepted before hitting the DB — matches the backend. */
export const MIN_KEY_LENGTH = 32

/** How often a key's lastUsedAt is written, per key. */
const TOUCH_INTERVAL_MS = 60_000

export type Role = 'admin' | 'consumer'

export interface KeyDoc {
    keyHash: string
    isActive: boolean
    role: Role
    expiresAt?: Date | string | null
    label?: string
    owner?: string
}

/** True when the guard should enforce. Read live so it can be toggled per process. */
export function guardEnabled(): boolean {
    return process.env.MORPHO_API_KEY_GUARD === 'true'
}

export function hashKey(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex')
}

function mongoUri(): string {
    const uri = process.env.MORPHO_MONGO_URI || process.env.MONGO_URI
    if (!uri) {
        throw new Error('MORPHO_MONGO_URI (or MONGO_URI) is required when MORPHO_API_KEY_GUARD=true')
    }
    return uri
}

let clientPromise: Promise<MongoClient> | null = null
let coll: Collection<KeyDoc> | null = null

async function collection(): Promise<Collection<KeyDoc>> {
    if (coll) return coll
    if (!clientPromise) {
        clientPromise = new MongoClient(mongoUri()).connect()
    }
    const client = await clientPromise
    const db = client.db(process.env.MORPHO_MONGO_DB || undefined)
    coll = db.collection<KeyDoc>(process.env.MORPHO_API_KEYS_COLLECTION || 'morpho_api_keys')
    return coll
}

/**
 * Return the key doc when the plaintext maps to an active, unexpired key
 * (optionally of `role`); null otherwise. Same logic as the backend's verify().
 */
export async function verifyKey(plaintext: string, role?: Role): Promise<KeyDoc | null> {
    if (!plaintext || plaintext.length < MIN_KEY_LENGTH) return null

    const filter: Record<string, unknown> = { keyHash: hashKey(plaintext), isActive: true }
    if (role) filter.role = role

    const match = await (await collection()).findOne(filter)
    if (!match) return null
    if (match.expiresAt && new Date(match.expiresAt).getTime() <= Date.now()) return null
    return match
}

const lastTouched = new Map<string, number>()

/**
 * Record usage (lastUsedAt), throttled per key. Fire-and-forget — never
 * awaited on the request path, never throws.
 */
export function touchKey(keyHash: string): void {
    const now = Date.now()
    if (now - (lastTouched.get(keyHash) ?? 0) < TOUCH_INTERVAL_MS) return
    lastTouched.set(keyHash, now)
    collection()
        .then(c => c.updateOne({ keyHash }, { $set: { lastUsedAt: new Date() } }))
        .catch(err => console.warn('[auth] failed to record key usage:', err?.message))
}

export async function closeKeys(): Promise<void> {
    if (!clientPromise) return
    const client = await clientPromise.catch(() => null)
    clientPromise = null
    coll = null
    await client?.close().catch(() => undefined)
}
