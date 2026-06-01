#!/usr/bin/env node
/**
 * Confirm: does package id `a7d1385f…` (the one currently hosting the
 * active Market contracts) actually have the package NAME
 * `mystic-lending-base`?
 *
 * If yes, the spike's templateId form `#mystic-lending-base:MysticMarket:Market`
 * is targeting the right code. If no, we picked the wrong package name from
 * daml.yaml.
 */
import fs from 'node:fs';

const env = (() => {
  const out = {};
  for (const line of fs.readFileSync('/Users/0xsammy/backend/.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
})();

const apiBase = env.CANTON_API_URL.replace(/\/v2\/?$/, '');

async function jwt() {
  const r = await fetch('https://auth.sandbox.fivenorth.io/application/o/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.FIVENORTH_CLIENT_ID,
      client_secret: env.FIVENORTH_CLIENT_SECRET,
      audience: env.FIVENORTH_AUDIENCE || env.FIVENORTH_CLIENT_ID,
      scope: 'daml_ledger_api',
    }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// Active-markets package id (observed via ACS): a7d1385f…
const ACTIVE_PKG_ID = 'a7d1385fbe37104c0a46622294220eed35caeecfc7952c39e50282f6c3d720df';

async function main() {
  const token = await jwt();
  const auth = { Authorization: `Bearer ${token}` };

  // Try a few possible endpoints — Canton API spelling has varied across versions.
  const probes = [
    { name: 'GET /v2/packages',                  url: `${apiBase}/v2/packages`,                            method: 'GET' },
    { name: `GET /v2/packages/${ACTIVE_PKG_ID}`, url: `${apiBase}/v2/packages/${ACTIVE_PKG_ID}`,            method: 'GET' },
    { name: `GET /v2/packages/${ACTIVE_PKG_ID}/status`, url: `${apiBase}/v2/packages/${ACTIVE_PKG_ID}/status`, method: 'GET' },
    { name: 'GET /v2/admin/packages',            url: `${apiBase}/v2/admin/packages`,                       method: 'GET' },
    { name: 'GET /v2/admin/object-meta/packages',url: `${apiBase}/v2/admin/object-meta/packages`,           method: 'GET' },
  ];

  for (const p of probes) {
    const r = await fetch(p.url, { method: p.method, headers: auth });
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    console.log(`\n— ${p.name}`);
    console.log(`  HTTP ${r.status}  ${ct}`);
    if (r.status === 200) {
      // Show only the first 400 chars to keep output sane
      console.log(`  body: ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
      // If the response is a list, look for our pkg id
      try {
        const j = JSON.parse(text);
        const list = Array.isArray(j) ? j : (j.packages || j.packageDetails || []);
        if (list.length > 0) {
          if (typeof list[0] === 'string') {
            const idx = list.indexOf(ACTIVE_PKG_ID);
            console.log(`  ACTIVE_PKG_ID present in list: ${idx >= 0 ? 'YES (idx ' + idx + ')' : 'no'}`);
            console.log(`  total packages in list: ${list.length}`);
          } else {
            const match = list.find(p => (p.packageId || p.id) === ACTIVE_PKG_ID);
            console.log(`  ACTIVE_PKG_ID match: ${match ? JSON.stringify(match) : 'not found'}`);
          }
        }
      } catch { /* not JSON */ }
    } else if (text) {
      console.log(`  body: ${text.slice(0, 200)}`);
    }
  }

  // Also try: do BOTH `mystic-lending-base` and `mystic-lending-curator`
  // accept on the updates endpoint? If so, the # form may be tolerant in a
  // way that's not actually "this exact package". We need to see what the
  // accepted form returns vs the others.
  console.log('\n— Cross-check: which "#<name>" prefixes does /v2/updates/flats accept?');
  const endR = await fetch(`${apiBase}/v2/state/ledger-end`, { headers: auth });
  const endOffset = (await endR.json()).offset;
  for (const name of ['mystic-lending-base', 'mystic-lending-curator', 'mystic-lending-oracle', 'made-up-package-name']) {
    const r = await fetch(`${apiBase}/v2/updates/flats`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beginExclusive: '0',
        endInclusive: endOffset,
        filter: { filtersByParty: { [env.CANTON_PUBLIC_PARTY]: {
          cumulative: [{ identifierFilter: { TemplateFilter: { value: {
            templateId: `#${name}:MysticMarket:Market`, includeCreatedEventBlob: false,
          } } } }],
        } } },
        verbose: false,
      }),
    });
    const txt = await r.text();
    const evts = r.status === 200 ? (() => { try { return JSON.parse(txt).length; } catch { return '?'; } })() : null;
    console.log(`  #${name} → HTTP ${r.status}` + (evts !== null ? `, events=${evts}` : ''));
    if (r.status >= 400) console.log(`     ${txt.slice(0, 200)}`);
  }
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
