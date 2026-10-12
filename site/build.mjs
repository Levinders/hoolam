// Builds the landing page and the legal pages into dist-site/. No packages needed: Render runs `node site/build.mjs`.
//
// It asks the Hoolam server for what the console has set (fees, deal limit, timings, WhatsApp number, contact
// details, logo and pictures) and copies all of it into the site, so the pages load complete and instantly from
// Render's CDN, even while the server sleeps. If the server can't be reached, the site still builds with the
// numbers below, and the home page picks up the console's settings live once the server answers.
//
// Pages:
//   /                      the live home page version (Console → Settings → Website content), from site/versions/<v>.html
//   /v/<version>/          every version, for previews; /v/draft/ is site/index.html (the working draft).
//                          Previews are never indexed: a noindex tag here and an X-Robots-Tag header (render.yaml).
//   /legal/                the list of legal pages
//   /legal/<page>/         site/legal/<page>.html, wrapped in site/legal/_layout.html
// The footer (site/partials/footer.*) is shared by all of them.
//
// Environment (all optional):
//   HOOLAM_APP_URL          the Hoolam server (default https://hoolam.onrender.com)
//   WHATSAPP_PUBLIC_NUMBER  used only if the server can't be reached
//   SITE_URL                this site's own address, for link previews and canonical links
//   SITE_OFFLINE=1          don't contact the server (tests)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist-site');
const env = process.env;
const strip = (u) => (u ?? '').trim().replace(/\/+$/, '');
const read = (p) => readFileSync(join(here, p), 'utf8');

const app = strip(env.HOOLAM_APP_URL) || 'https://hoolam.onrender.com';
const site = strip(env.SITE_URL) || strip(env.RENDER_EXTERNAL_URL) || '';
const fallbackWa = (env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '');
const EXT = { 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg' };

// The company, exactly as registered with the Corporate Affairs Commission. Meta checks the website against these.
const COMPANY = {
  legalName: 'HOOLAM DIGITAL PLATFORM LTD',
  rc: '9919417',
  address: '8, Delta Bakery Road, Woji, Rivers State, Nigeria',
  incorporated: '8 October 2026',
  bankPartner: 'Moniepoint Microfinance Bank',
  payService: 'Monnify',
};
// The date the legal pages took effect. Change it (and say what changed) whenever their wording changes.
const LEGAL_EFFECTIVE = '12 October 2026'; // ID checks (BVN or NIN) above the limit without ID and for sellers' payouts

// What the console has, or these if the server can't be reached. Keep in step with src/pricing.ts and src/config.ts.
const DEFAULTS = {
  fees: { rate: 2.5, min: 300, max: 5000, roundTo: 100 }, maxDeal: 50000, maxDealVerified: 2000000,
  txn: { seller: [{ upTo: 100000, fee: 500 }, { upTo: 200000, fee: 1000 }, { upTo: 300000, fee: 1500 }, { upTo: 400000, fee: 2000 }, { upTo: null, fee: 2500 }],
         buyer: [{ upTo: 100000, fee: 500 }, { upTo: 200000, fee: 1000 }, { upTo: 300000, fee: 1500 }, { upTo: 400000, fee: 2000 }, { upTo: null, fee: 2500 }] },
  timing: { acceptHours: 48, nudgeHours: 24, flagHours: 72, unpaidHours: 72, autoReleaseMinutes: 1440 },
  contact: { email: 'hello@hoolam.com', phone: '', socials: [] },
};

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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const naira = (n) => `₦${num(n)}`;
/** Nigerian numbers the way people write them: 07034577787. Others: +1 555 138 0045. */
function phoneText(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (/^234\d{10}$/.test(d)) return '0' + d.slice(3);
  if (/^0\d{10}$/.test(d)) return d;
  const cc = /^[17]/.test(d) ? d.slice(0, 1) : /^(2[1-9]\d|3[578]\d|42\d|5[09]\d|6[7-9]\d|8[5-9]\d|9[6-9]\d)/.test(d) ? d.slice(0, 3) : d.slice(0, 2);
  const rest = d.slice(cc.length);
  return `+${cc} ${rest.length === 10 ? rest.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3') : rest.replace(/(\d{2})(?=\d)/g, '$1 ')}`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'media'), { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

const live = await serverSettings();
const baked = {};
// home page versions (site/versions/versions.json) and the one that's live
const manifest = JSON.parse(read('versions/versions.json'));
const VERSIONS = manifest.versions.map((v) => v.version);
const newest = [...VERSIONS].sort((a, b) => { const p = (x) => x.split('.').map(Number); const [x, y] = [p(a), p(b)]; return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; })[0];
const liveVersion = live && VERSIONS.includes(live.homeVersion) ? live.homeVersion : (manifest.live ?? VERSIONS[0]);
/** Copies an image into the site once (same picture, same file) and returns its address. */
const copied = new Map();
async function copyImage(slot, img) {
  const id = `${slot}-${img.v}`;
  if (copied.has(id)) return copied.get(id);
  const r = await fetchWithTimeout(img.url, 30_000);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const type = (r.headers.get('content-type') ?? '').split(';')[0];
  const file = `/media/${id}.${EXT[type] ?? 'img'}`;
  writeFileSync(join(out, file), Buffer.from(await r.arrayBuffer()));
  copied.set(id, file);
  return file;
}
/** One version's pictures (brand included): slot → { src, v }. */
async function imagesFor(set) {
  const res = {};
  for (const [slot, img] of Object.entries(set ?? {})) {
    try { res[slot] = { src: await copyImage(slot, img), v: img.v }; }
    catch (e) { console.log(`  couldn't copy image ${slot}: ${e.message} (the page loads it live instead)`); }
  }
  return res;
}
const versionImages = {};
if (live && live.currency === 'NGN') {
  baked.fees = live.fees;
  baked.maxDeal = live.maxDeal;
  if (live.txn) baked.txn = live.txn;
  if (live.whatsapp) baked.whatsapp = String(live.whatsapp).replace(/\D/g, '');
  baked.images = await imagesFor(live.images);
  for (const v of VERSIONS) versionImages[v] = v === liveVersion ? baked.images : await imagesFor(live.versions?.[v]?.images ?? live.images);
}
const ok = live && live.currency === 'NGN';
const fees = (ok && live.fees) || DEFAULTS.fees;
const maxDeal = (ok && live.maxDeal) || DEFAULTS.maxDeal;
const maxDealVerified = (ok && live.maxDealVerified) || DEFAULTS.maxDealVerified;
const txn = (ok && live.txn) || DEFAULTS.txn;
/** "₦500 for orders up to ₦100,000, ₦1,000 up to ₦200,000, … and ₦2,500 above ₦400,000" */
const bandsText = (b) => b.map((x, i) => x.upTo == null ? `${i ? 'and ' : ''}${naira(x.fee)} above ${naira(b[i - 1]?.upTo ?? 0)}` : `${naira(x.fee)} ${i ? '' : 'for orders '}up to ${naira(x.upTo)}`).join(', ');
const timing = { ...DEFAULTS.timing, ...((ok && live.timing) || {}) };
const contact = { ...DEFAULTS.contact, ...((ok && live.contact) || {}) };
const wa = baked.whatsapp ?? fallbackWa;
const waLink = wa ? `https://wa.me/${wa}?text=${encodeURIComponent('Hi Hoolam')}` : `${app}/chat`;
const hours = (h) => `${h} hour${+h === 1 ? '' : 's'}`;

// ---------- the footer ----------
const contactItems = [
  // the same number for calls and WhatsApp shows once
  contact.phone && contact.phone !== wa && `<li><a class="sf-row" href="tel:+${esc(contact.phone)}"><svg class="ic" aria-hidden="true"><use href="#sf-phone"/></svg><span>${esc(phoneText(contact.phone))}<small>Phone</small></span></a></li>`,
  wa && `<li><a class="sf-row" data-wa href="${esc(waLink)}" target="_blank" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#sf-whatsapp"/></svg><span>${esc(phoneText(wa))}<small>${contact.phone === wa ? 'Phone and WhatsApp' : 'WhatsApp, for orders and help'}</small></span></a></li>`,
  contact.email && `<li><a class="sf-row" href="mailto:${esc(contact.email)}"><svg class="ic" aria-hidden="true"><use href="#sf-mail"/></svg><span>${esc(contact.email)}<small>Email</small></span></a></li>`,
  (contact.socials ?? []).length && `<li class="sf-socials" aria-label="Hoolam on social media">${contact.socials.filter((s) => /^https:\/\//.test(s.url)).map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="Hoolam on ${esc(s.name)}: ${esc(s.label)}"><svg class="ic" aria-hidden="true"><use href="#sf-${esc(s.kind)}"/></svg>${esc(s.label)}</a>`).join('')}</li>`,
].filter(Boolean).join('');

const minutesText = (n) => n < 60 ? `${n} minutes` : n % 1440 === 0 && n >= 2880 ? `${n / 1440} days` : `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? '' : 's'}`;
const fill = (s, vars) => s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const shared = {
  LEGAL_NAME: COMPANY.legalName, RC: COMPANY.rc, ADDRESS: esc(COMPANY.address), BANK_PARTNER: COMPANY.bankPartner, PAY_SERVICE: COMPANY.payService,
  INCORPORATED: COMPANY.incorporated, YEAR: String(new Date().getFullYear()), EFFECTIVE: LEGAL_EFFECTIVE,
  EMAIL: esc(contact.email), EMAIL_LINK: `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`,
  WHATSAPP: esc(phoneText(wa)), WA_LINK: `<a data-wa href="${esc(waLink)}" target="_blank" rel="noopener">${wa ? `WhatsApp on ${esc(phoneText(wa))}` : 'WhatsApp'}</a>`,
  TXN_SELLER: bandsText(txn.seller), TXN_BUYER: bandsText(txn.buyer),
  FEE_RATE: `${String(fees.rate).replace(/\.0+$/, '')}%`, FEE_MIN: naira(fees.min), FEE_MAX: naira(fees.max), FEE_ROUND: naira(fees.roundTo || 1), MAX_DEAL: naira(maxDeal), MAX_DEAL_VERIFIED: naira(maxDealVerified),
  ACCEPT_HOURS: hours(timing.acceptHours), NUDGE_HOURS: hours(timing.nudgeHours), FLAG_HOURS: hours(timing.flagHours), UNPAID_HOURS: hours(timing.unpaidHours), AUTO_RELEASE: minutesText(timing.autoReleaseMinutes ?? 1440),
};
const footer = fill(read('partials/footer.html'), { ...shared, CONTACT_ITEMS: contactItems });
const footerCss = read('partials/footer.css');

// ---------- the home page: the live version at /, every version (and the draft) as a hidden preview ----------
const indexSrc = read('index.html');
const iconTags = (prefix, imgs = baked.images) => imgs?.mark?.src
  ? `<link rel="icon" href="${imgs.mark.src}">\n<link rel="apple-touch-icon" href="${imgs.mark.src}">`
  : `<link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="${prefix}assets/icon-180.png">`;
const NOINDEX = '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">\n<meta name="googlebot" content="noindex, nofollow">';
function homePage(src, version, preview) {
  const imgs = versionImages[version] ?? baked.images;
  const pageBaked = { ...baked, images: imgs, version };
  let h = src
    .replaceAll('{{APP_URL}}', app)
    .replaceAll('{{WHATSAPP_NUMBER}}', wa)
    .replaceAll('{{WHATSAPP_LOCAL}}', phoneText(wa) || 'WhatsApp')
    .replaceAll('{{SITE_URL}}/', site ? `${site}/` : '/')
    .replace('/*{{BAKED}}*/{}', JSON.stringify(pageBaked).replace(/</g, '\\u003c'))
    .replace('/*{{FOOTER_CSS}}*/', footerCss)
    .replace('<!--{{FOOTER}}-->', footer);
  h = fill(h, { LEGAL_NAME: shared.LEGAL_NAME, RC: shared.RC, BANK_PARTNER: shared.BANK_PARTNER, BANK_SHORT: String(shared.BANK_PARTNER).replace(/\s*Microfinance Bank$/, ' MFB'), INCORPORATED: shared.INCORPORATED });
  h = h.replace(/<link rel="icon" href="\/?assets\/favicon\.svg" type="image\/svg\+xml">\n<link rel="apple-touch-icon" href="\/?assets\/icon-180\.png">/, iconTags('/', imgs));
  if (preview) {
    // never in search results; a small label so nobody mistakes it for the live page
    h = h.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${NOINDEX}`)
      .replace(/<link rel="canonical"[^>]*>\n?/g, '')
      .replace('</body>', `<div role="note" style="position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;background:#1B2321;color:#fff;font:600 12px/1 Inter,system-ui,sans-serif;padding:9px 14px;border-radius:99px;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:nowrap;pointer-events:none">Preview · ${version === 'draft' ? 'draft' : 'version ' + esc(version)} · ${version === liveVersion ? 'live now' : 'not live'}</div>\n</body>`);
  }
  return h;
}
const versionSrc = (v) => read(`versions/${v}.html`);
writeFileSync(join(out, 'index.html'), homePage(versionSrc(liveVersion), liveVersion, false));
for (const v of VERSIONS) {
  mkdirSync(join(out, 'v', v), { recursive: true });
  writeFileSync(join(out, 'v', v, 'index.html'), homePage(versionSrc(v), v, true));
}
mkdirSync(join(out, 'v', 'draft'), { recursive: true });
writeFileSync(join(out, 'v', 'draft', 'index.html'), homePage(indexSrc, newest, true).replace(/Preview · version [\d.]+ · (live now|not live)/, 'Preview · draft · not live'));

// ---------- the legal pages ----------
// The icons and the Hoolam symbol come from the home page, so there is one copy of each.
const sprite = (indexSrc.match(/<svg width="0" height="0" style="position:absolute" aria-hidden="true">[\s\S]*?<\/svg>\n/g) ?? []).join('');
const LEGAL_PAGES = [
  { slug: 'terms', title: 'Terms of service', blurb: 'The agreement between you and Hoolam when you use the service.' },
  { slug: 'privacy', title: 'Privacy policy', blurb: 'What we collect, why, who sees it and your rights under Nigerian law.' },
  { slug: 'holding-agreement', title: 'Holding agreement', blurb: 'How we receive, hold, release and refund the money in every order.' },
  { slug: 'disputes', title: 'If something goes wrong', blurb: 'Reporting a problem, how we decide, and how refunds work.' },
  { slug: 'acceptable-use', title: 'Acceptable use', blurb: 'What you can and can’t sell or do with Hoolam.' },
  { slug: 'money', title: 'Where the money sits', blurb: 'The bank, the accounts, and every step your money takes.' },
  { slug: 'cookies', title: 'Cookies', blurb: 'What this website stores on your device. (Very little.)' },
  { slug: 'delete-your-data', title: 'Delete your data', blurb: 'How to ask us to delete your details, and what we must keep.' },
];
const layout = read('legal/_layout.html');
const imagesJson = JSON.stringify(Object.fromEntries(Object.entries(baked.images ?? {}).filter(([k]) => k === 'mark').map(([k, v]) => [k, v.src])));

function page({ slug, title, blurb, lede, body, toc, path }) {
  const canonical = site ? `${site}${path}` : '';
  const others = !LEGAL_PAGES.some((p) => p.slug === slug) ? '' : LEGAL_PAGES.filter((p) => p.slug !== slug).map((p) => `<a class="lg-card" href="/legal/${p.slug}/"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('');
  return fill(layout, {
    ...shared, TITLE: esc(title), DESCRIPTION: esc(blurb), LEDE: lede, BODY: body, TOC: toc, OTHERS: others, SPRITE: sprite, FOOTER: footer, FOOTER_CSS: footerCss,
    CANONICAL: canonical ? `<link rel="canonical" href="${esc(canonical)}">\n<meta property="og:url" content="${esc(canonical)}">` : '',
    OG_IMAGE: site ? `${site}/assets/og.png` : '/assets/og.png', ICONS: iconTags('/'), IMAGES: imagesJson.replace(/</g, '\\u003c'), WA_HREF: esc(waLink),
    PAGE_CLASS: toc ? 'has-toc' : 'no-toc',
  }).replace(others ? /^$/ : /\n  <nav class="lg-others"[\s\S]*?<\/nav>/, '');
}

for (const p of LEGAL_PAGES) {
  const src = fill(read(`legal/${p.slug}.html`), shared);
  const lede = (src.match(/<!--lede-->([\s\S]*?)<!--\/lede-->/) ?? [])[1]?.trim() ?? esc(p.blurb);
  const body = src.replace(/<!--lede-->[\s\S]*?<!--\/lede-->/, '').trim();
  const heads = [...body.matchAll(/<h2 id="([a-z0-9-]+)">([\s\S]*?)<\/h2>/g)];
  const toc = heads.length > 2 ? `<ol>${heads.map((h, i) => `<li><a href="#${h[1]}"><span>${String(i + 1).padStart(2, '0')}</span>${h[2]}</a></li>`).join('')}</ol>` : '';
  mkdirSync(join(out, 'legal', p.slug), { recursive: true });
  writeFileSync(join(out, 'legal', p.slug, 'index.html'), page({ ...p, lede, body, toc, path: `/legal/${p.slug}/` }));
}
// /legal/: every page, in plain words
const hub = `<div class="lg-hub">${LEGAL_PAGES.map((p) => `<a class="lg-card" href="/legal/${p.slug}/"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('')}</div>
<section class="lg-company" aria-labelledby="company"><h2 id="company" class="plain">The company behind Hoolam</h2>
<dl><div><dt>Registered name</dt><dd>${COMPANY.legalName}</dd></div><div><dt>RC number</dt><dd>${COMPANY.rc}</dd></div>
<div><dt>Registered with</dt><dd>Corporate Affairs Commission, Nigeria, on ${COMPANY.incorporated}</dd></div><div><dt>Registered office</dt><dd>${esc(COMPANY.address)}</dd></div>
<div><dt>Money for orders held with</dt><dd>${COMPANY.bankPartner}, through ${COMPANY.payService}</dd></div><div><dt>Contact</dt><dd>${shared.EMAIL_LINK}</dd></div></dl></section>`;
mkdirSync(join(out, 'legal'), { recursive: true });
writeFileSync(join(out, 'legal', 'index.html'), page({ slug: '', title: 'Legal', blurb: 'Every agreement and policy for using Hoolam, written to be read.',
  lede: 'Every agreement and policy for using Hoolam. We’ve written them to be read, not skimmed past. Each page starts with a short version.', body: hub, toc: '', path: '/legal/' }));

const pages = ['/', '/legal/', ...LEGAL_PAGES.map((p) => `/legal/${p.slug}/`)];
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}/sitemap.xml\n` : ''}`);
if (site) writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${site}${p}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(out, '404.html'), page({ slug: '404', title: 'Page not found', blurb: 'This page doesn’t exist.', lede: 'This page doesn’t exist, or it has moved.', body: `<p><a class="lg-btn" href="/">Go to the Hoolam home page</a></p>`, toc: '', path: '/404' }).replace('<meta name="robots" content="index,follow">', '<meta name="robots" content="noindex">'));

const n = Object.keys(baked.images ?? {}).length;
console.log(`Site built → dist-site/  (${pages.length} pages, home page ${liveVersion} live, ${VERSIONS.length} versions + draft to preview; server: ${app}${live ? `, settings copied, ${n} image${n === 1 ? '' : 's'}` : ', server not reached: using the built-in numbers'}${site ? `, site: ${site}` : ''})`);
