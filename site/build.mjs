// Builds the landing page into dist-site/. No packages needed: Render runs `node site/build.mjs`.
//
// It asks the Hoolam server for what the console has set (fees, deal limit, WhatsApp number, logo and pictures)
// and copies all of it into the site, so the page loads complete and instantly from Render's CDN, even while the
// server sleeps. If the server can't be reached, the site still builds with the page's own numbers and drawings,
// and picks up the console's settings live once the server answers.
//
// Environment (all optional):
//   HOOLAM_APP_URL          the Hoolam server (default https://hoolam.onrender.com)
//   WHATSAPP_PUBLIC_NUMBER  used only if the server can't be reached
//   SITE_URL                this site's own address, for link previews on WhatsApp
//   SITE_OFFLINE=1          don't contact the server (tests)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist-site');
const env = process.env;
const strip = (u) => (u ?? '').trim().replace(/\/+$/, '');

const app = strip(env.HOOLAM_APP_URL) || 'https://hoolam.onrender.com';
const site = strip(env.SITE_URL) || strip(env.RENDER_EXTERNAL_URL) || '';
const fallbackWa = (env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '');
const EXT = { 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg' };

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(t); }
}

/** The server may be asleep (free plan): give it up to ~2 minutes to wake. */
async function serverSettings() {
  if (env.SITE_OFFLINE === '1') return null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetchWithTimeout(`${app}/site.json`, 35_000);
      if (r.ok) return await r.json();
      console.log(`  server answered ${r.status} (try ${attempt})`);
    } catch (e) { console.log(`  server not reachable yet (try ${attempt}): ${e.message}`); }
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return null;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'media'), { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

const live = await serverSettings();
const baked = {};
if (live && live.currency === 'NGN') {
  baked.fees = live.fees;
  baked.maxDeal = live.maxDeal;
  if (live.whatsapp) baked.whatsapp = String(live.whatsapp).replace(/\D/g, '');
  baked.images = {};
  for (const [slot, img] of Object.entries(live.images ?? {})) {
    try {
      const r = await fetchWithTimeout(img.url, 30_000);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const type = (r.headers.get('content-type') ?? '').split(';')[0];
      const file = `media/${slot}-${img.v}.${EXT[type] ?? 'img'}`;
      writeFileSync(join(out, file), Buffer.from(await r.arrayBuffer()));
      baked.images[slot] = { src: file, v: img.v };
    } catch (e) { console.log(`  couldn't copy image ${slot}: ${e.message} (the page loads it live instead)`); }
  }
}

let html = readFileSync(join(here, 'index.html'), 'utf8')
  .replaceAll('{{APP_URL}}', app)
  .replaceAll('{{WHATSAPP_NUMBER}}', baked.whatsapp ?? fallbackWa)
  .replaceAll('{{SITE_URL}}/', site ? `${site}/` : '')
  .replace('/*{{BAKED}}*/{}', JSON.stringify(baked).replace(/</g, '\\u003c'));
const mark = baked.images?.mark?.src;
if (mark) {
  html = html.replace('<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">', `<link rel="icon" href="${mark}">`)
    .replace('<link rel="apple-touch-icon" href="assets/icon-180.png">', `<link rel="apple-touch-icon" href="${mark}">`);
}
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');

const n = Object.keys(baked.images ?? {}).length;
console.log(`Landing page built → dist-site/  (server: ${app}${live ? `, settings copied, ${n} image${n === 1 ? '' : 's'}` : ', server not reached: using the page\'s own numbers'}${site ? `, site: ${site}` : ''})`);
