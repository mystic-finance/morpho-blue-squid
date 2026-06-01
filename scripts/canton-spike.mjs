#!/usr/bin/env node
/**
 * Phase 0 spike — validate we can read Canton Market events from Node.
 *
 * Run from the morpho-blue-squid root:
 *   node scripts/canton-spike.mjs
 *
 * What it does, in order:
 *   1. Loads CANTON_API_URL, FIVENORTH_CLIENT_ID/SECRET, CANTON_PUBLIC_PARTY
 *      from /Users/0xsammy/backend/.env (so we don't duplicate config).
 *   2. Fetches a JWT from FiveNorth (same grant the backend uses).
 *   3. Hits GET /v2/state/ledger-end to confirm auth + connection.
 *   4. Lists ACTIVE Market contracts via POST /v2/state/active-contracts
 *      (sanity check — this is the same call the backend's queryACSRest makes).
 *   5. Attempts POST /v2/updates/flats with a bounded offset range to see
 *      what historical update events look like. THIS is the real validation —
 *      if this returns Market create/archive events with payloads, the full
 *      indexer plan (Path B) is viable as designed.
 *
 * Outputs JSON-ish blocks with [STEP n] headers so failure points are obvious.
 */

import fs from 'node:fs';
import path from 'node:path';

const BACKEND_ENV = '/Users/0xsammy/backend/.env';

// ---------- env load (minimal, no deps) ----------
function loadEnv(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = loadEnv(BACKEND_ENV);

const CFG = {
  apiUrl:        env.CANTON_API_URL || process.env.CANTON_API_URL,
  authUrl:       'https://auth.sandbox.fivenorth.io/application/o/token/',
  clientId:      env.FIVENORTH_CLIENT_ID || process.env.FIVENORTH_CLIENT_ID,
  clientSecret:  env.FIVENORTH_CLIENT_SECRET || process.env.FIVENORTH_CLIENT_SECRET,
  audience:      env.FIVENORTH_AUDIENCE || env.FIVENORTH_CLIENT_ID,
  publicParty:   env.CANTON_PUBLIC_PARTY || process.env.CANTON_PUBLIC_PARTY,
  // The Mystic Market template id — package id followed by module:entity.
  // We'll query active markets first to derive the exact templateId at runtime
  // (in case the package id has churned), but provide a starter pattern:
  marketTemplatePattern: 'MysticMarket:Market',
};

// ---------- helpers ----------
const HR = '─'.repeat(72);
function step(n, label) {
  console.log(`\n${HR}\n[STEP ${n}] ${label}\n${HR}`);
}
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function bad(msg)  { console.log(`  ✗ ${msg}`); }

// ---------- 1. auth ----------
async function fetchJwt() {
  const r = await fetch(CFG.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CFG.clientId,
      client_secret: CFG.clientSecret,
      audience:      CFG.audience,
      scope:         'daml_ledger_api',
    }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.access_token;
}

// ---------- 2. ledger end ----------
async function getLedgerEnd(jwt) {
  const base = CFG.apiUrl.replace(/\/v2\/?$/, '');
  const r = await fetch(`${base}/v2/state/ledger-end`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`ledger-end ${r.status}: ${await r.text()}`);
  return r.json();  // shape: { offset: string }
}

// ---------- 3. ACS query (sanity check — same shape backend uses) ----------
async function queryActiveMarkets(jwt, activeAtOffset) {
  const base = CFG.apiUrl.replace(/\/v2\/?$/, '');
  // Wildcard template filter: server returns active contracts matching the
  // party. We then filter client-side for Market-template payloads to find
  // the precise template id (package id changes per deploy).
  const body = {
    activeAtOffset,
    filter: {
      filtersByParty: {
        [CFG.publicParty]: {
          cumulative: [
            { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
          ],
        },
      },
    },
  };
  const r = await fetch(`${base}/v2/state/active-contracts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`active-contracts ${r.status}: ${await r.text()}`);
  // FiveNorth returns NDJSON (one JSON-encoded contract per line) or an array
  // depending on Accept header — handle both.
  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- 3b. discover package NAME for the updates endpoint ----------
// The updates endpoint rejects package IDs and wants a package NAME (the
// short human alias DAML packages register with on upload). Query the
// admin/packages endpoint and look for the package matching the Market
// template's package id.
async function discoverPackageName(jwt, marketTemplateId) {
  const base = CFG.apiUrl.replace(/\/v2\/?$/, '');
  const targetPkgId = marketTemplateId.split(':')[0];
  // List packages
  const r = await fetch(`${base}/v2/packages`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) {
    info(`/v2/packages returned ${r.status} — falling back to GET /v2/admin/packages`);
    const r2 = await fetch(`${base}/v2/admin/packages`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r2.ok) return { error: `packages list: ${r2.status} ${await r2.text()}`.slice(0, 200) };
    const j = await r2.json();
    return tryMatchPackage(j, targetPkgId);
  }
  const j = await r.json();
  return tryMatchPackage(j, targetPkgId);
}

function tryMatchPackage(listResponse, targetPkgId) {
  // Response shape varies by Canton version. Try a few:
  //   { packageIds: [...] } — no names
  //   { packages: [{ packageId, packageName, packageVersion }] }
  //   [{ packageId, name, version }]
  const list = Array.isArray(listResponse)
    ? listResponse
    : listResponse.packages || listResponse.packageDetails || listResponse.packageIds || [];
  if (list.length === 0) return { error: 'empty package list', listSample: listResponse };
  // If we got bare package ID strings, we'd need a per-package details call.
  if (typeof list[0] === 'string') {
    return { error: 'package list returns IDs only — need per-package metadata call', sampleIds: list.slice(0, 3) };
  }
  const match = list.find((p) => (p.packageId || p.package_id || p.id) === targetPkgId);
  if (match) {
    return {
      packageName:    match.packageName || match.package_name || match.name,
      packageVersion: match.packageVersion || match.package_version || match.version,
      pkg: match,
    };
  }
  return { error: 'no package matched targetPkgId', candidates: list.slice(0, 3) };
}

// ---------- 4. updates/flats — THE actual spike target ----------
async function fetchUpdates(jwt, beginExclusiveOffset, endInclusiveOffset, templateId) {
  const base = CFG.apiUrl.replace(/\/v2\/?$/, '');
  const body = {
    beginExclusive: beginExclusiveOffset,
    endInclusive:   endInclusiveOffset,
    filter: {
      filtersByParty: {
        [CFG.publicParty]: {
          cumulative: [
            { identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } },
          ],
        },
      },
    },
    verbose: false,
  };
  const r = await fetch(`${base}/v2/updates/flats`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Don't throw on non-2xx — we want to inspect the error body to know
  // whether the endpoint exists / what shape it expects.
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type') || '', body: text };
}

// ---------- main ----------
async function main() {
  console.log('Canton Update-Stream Spike — Phase 0');
  console.log(`API:   ${CFG.apiUrl}`);
  console.log(`Party: ${CFG.publicParty}`);

  if (!CFG.apiUrl || !CFG.clientId || !CFG.clientSecret || !CFG.publicParty) {
    bad('Missing env. Need CANTON_API_URL, FIVENORTH_CLIENT_ID/SECRET, CANTON_PUBLIC_PARTY in /Users/0xsammy/backend/.env');
    process.exit(1);
  }

  // STEP 1
  step(1, 'Auth: fetching JWT from FiveNorth');
  const jwt = await fetchJwt();
  ok(`JWT acquired (${jwt.length} chars)`);

  // STEP 2
  step(2, 'GET /v2/state/ledger-end — confirm connection');
  const end = await getLedgerEnd(jwt);
  ok(`ledger-end: ${JSON.stringify(end)}`);
  const endOffset = end.offset;

  // STEP 3
  step(3, 'POST /v2/state/active-contracts — list ACTIVE contracts (sanity)');
  const active = await queryActiveMarkets(jwt, endOffset);
  ok(`got ${active.length} active contract events`);
  // Filter client-side for Market-template entries
  const marketEntries = active.filter((e) => {
    const tid = (e.JsContractEntry?.created?.templateId
      || e.created?.templateId
      || e.contractEntry?.JsActiveContract?.createdEvent?.templateId
      || '').toString();
    return /MysticMarket:Market\b/.test(tid);
  });
  info(`of which Market-template: ${marketEntries.length}`);
  if (marketEntries.length > 0) {
    const sample = marketEntries[0];
    const sampleTemplateId = sample.JsContractEntry?.created?.templateId
      || sample.created?.templateId
      || sample.contractEntry?.JsActiveContract?.createdEvent?.templateId;
    info(`sample templateId: ${sampleTemplateId}`);
    const samplePayload = sample.JsContractEntry?.created?.createArgument
      || sample.created?.createArgument
      || sample.contractEntry?.JsActiveContract?.createdEvent?.createArgument;
    if (samplePayload) {
      info(`sample params.oracle: ${samplePayload?.params?.oracle?.slice?.(0, 30) ?? '(unknown)'}…`);
      info(`sample totalSupplyAssets: ${samplePayload?.totalSupplyAssets}`);
    } else {
      info('payload not present — re-run with includeCreatedEventBlob:true to inspect');
    }
    CFG.exactMarketTemplateId = sampleTemplateId;
  } else {
    info('no active Market contracts found — this party may not see them, OR there are none');
  }

  // STEP 3b — use known package name from daml.yaml. The Market template
  // lives in `mystic-lending-base` (see /Users/0xsammy/DAML-curated-lending/
  // base/daml.yaml). The updates endpoint rejects package-ID-form template
  // identifiers, but accepts package-NAME form. Try both with and without
  // the '#' prefix some Canton versions require.
  step('3b', 'Build package-name template id for updates endpoint');
  const KNOWN_PKG_NAME = 'mystic-lending-base';
  CFG.resolvedPackageName = KNOWN_PKG_NAME;
  ok(`using known package name: ${KNOWN_PKG_NAME} (from daml.yaml)`);
  const templateIdCandidates = [
    `${KNOWN_PKG_NAME}:MysticMarket:Market`,
    `#${KNOWN_PKG_NAME}:MysticMarket:Market`,
  ];

  // STEP 4
  step(4, 'POST /v2/updates/flats — THE actual update-stream probe');
  let updates;
  let templateId;
  for (const tid of templateIdCandidates) {
    info(`trying templateId: ${tid}`);
    const r = await fetchUpdates(jwt, '0', endOffset, tid);
    info(`  HTTP ${r.status}`);
    if (r.status >= 200 && r.status < 300) {
      ok(`accepted templateId: ${tid}`);
      updates = r;
      templateId = tid;
      break;
    } else if (r.status === 400) {
      info(`  rejected: ${r.body.slice(0, 200)}`);
    }
  }
  if (!updates) {
    bad('No templateId form accepted by /v2/updates/flats');
    updates = { status: 400, body: 'all candidates rejected', contentType: '' };
    templateId = templateIdCandidates[0];
  }
  info(`final templateId: ${templateId}`);
  info(`HTTP ${updates.status}  content-type: ${updates.contentType}`);
  if (updates.status >= 400) {
    bad(`error body (first 500 chars):\n    ${updates.body.slice(0, 500)}`);
  } else {
    // Response is NDJSON (one update per line) on success
    const lines = updates.body.split('\n').filter(Boolean);
    ok(`received ${lines.length} update lines`);
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]);
        info(`first update keys: ${Object.keys(first).join(', ')}`);
        info(`first update raw (first 400 chars):\n    ${JSON.stringify(first).slice(0, 400)}`);
      } catch (e) {
        bad(`failed to parse first line as JSON: ${e.message}`);
        info(`first line raw (first 400 chars):\n    ${lines[0].slice(0, 400)}`);
      }
    }
  }

  // STEP 5 — summary
  step(5, 'Verdict');
  const checks = [
    ['Auth works',                              !!jwt],
    ['Ledger-end queryable',                    !!endOffset],
    ['Active Market contracts visible',         marketEntries.length > 0],
    ['Market templateId discovered',            !!CFG.exactMarketTemplateId],
    ['Package name resolved',                   !!CFG.resolvedPackageName],
    ['Updates endpoint returns 2xx',            updates.status >= 200 && updates.status < 300],
    ['Updates endpoint returns events',         updates.status < 400 && updates.body.split('\n').filter(Boolean).length > 0],
  ];
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  }
  const allGreen = checks.every(([, p]) => p);
  console.log();
  if (allGreen) {
    console.log('  ⇒ Path B is viable. Phase 1+ can proceed against this API surface.');
  } else {
    console.log('  ⇒ Path B blocked on the failing checks above. Investigate before Phase 1.');
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
