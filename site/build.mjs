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
//   /about/, /contact/     site/pages/<page>.html, wrapped in site/pages/_layout.html
// The footer (site/partials/footer.*) is shared by all of them.
//
// Environment (all optional):
//   HOOLAM_APP_URL          the Hoolam server (default https://hoolam.onrender.com)
//   WHATSAPP_PUBLIC_NUMBER  used only if the server can't be reached
//   SITE_URL                this site's own address, for link previews and canonical links
//   SITE_OFFLINE=1          don't contact the server (tests)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const EXT = { 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr' };

// The company, exactly as registered with the Corporate Affairs Commission. Meta checks the website against these.
const COMPANY = {
  legalName: 'HOOLAM DIGITAL PLATFORM LTD',
  rc: '9919417',
  address: '8, Delta Bakery Road, Woji, Rivers State, Nigeria',
  incorporated: '8 October 2026',
  bankPartner: 'Moniepoint Microfinance Bank',
  payService: 'Monnify',
  // the EFCC's Special Control Unit against Money Laundering (registered): its number shows once it's put here
  scuml: '',
  // the Nigeria Data Protection Commission (registered): its number shows once it's put here
  ndpc: '',
};
// The date the legal pages took effect. Change it (and say what changed) whenever their wording changes.
const LEGAL_EFFECTIVE = '18 October 2026'; // the ambassador programme (Ambassador agreement; terms, privacy and cookies: ambassadors). Before: 14 Oct 2026, Google Analytics with consent

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
// the ambassador programme (Console → Settings → Features): the menu link, hoolam.com/ambassadors and the links show only while it's on
const amb = ok && live.ambassadors?.on ? live.ambassadors : null;
const ambLinks = amb && Array.isArray(live.ambassadorLinks) ? live.ambassadorLinks.filter((l) => /^[a-z0-9-]{2,40}$/.test(l.slug)) : [];
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const pctText = (n) => `${Number(Number(n).toFixed(2))}%`;

// ---------- what the website shows from the chat (site.json `show`): the chat's pictures and voice notes, live numbers ----------
// Copied into the site like the other images, so they load even while the server sleeps. The numbers are also
// refreshed live by site/assets/show.js. Pages ask for a picture with {{ART:<id>}} (its address) and {{ALT:<id>}}.
const showLive = ok && live.show ? live.show : null;
const ART_ALT = { held: 'Hoolam chat card: the money is held safely', 'seller-held': 'Hoolam chat card for the seller: the money is ready', handover: 'Hoolam chat card: the 4-digit handover code',
  frozen: 'Hoolam chat card: the money is frozen while a rep sorts it out', paid: 'Hoolam chat card: the seller is paid', refund: 'Hoolam chat card: the buyer is refunded in full',
  'real-hoolam': 'How to know it’s the real Hoolam', 'amb-share': 'The card an ambassador shares' };
const artSrc = {}, artAlt = { ...ART_ALT };
const showData = { api: app, voices: {}, proof: showLive?.proof ?? null };
if (showLive) {
  for (const [id, a] of Object.entries(showLive.art ?? {})) {
    artAlt[id] = a.alt || artAlt[id] || '';
    try { artSrc[id] = await copyImage(`art-${id}`, a); } catch (e) { artSrc[id] = a.url; console.log(`  couldn't copy chat picture ${id}: ${e.message} (loads it live instead)`); }
  }
  for (const [id, v] of Object.entries(showLive.voices ?? {})) {
    try { showData.voices[id] = { src: await copyImage(id, v), mime: v.mime }; } catch { showData.voices[id] = { src: v.url, mime: v.mime }; }
  }
}
const showCss = createHash('sha256').update(read('assets/show.css')).digest('hex').slice(0, 10);
const showJs = createHash('sha256').update(read('assets/show.js')).digest('hex').slice(0, 10);
const officialQr = showLive?.qr && /^<svg[\s>]/.test(showLive.qr.replace(/^<\?xml[^>]*>\s*/, '')) ? showLive.qr.replace(/^<\?xml[^>]*>\s*/, '').replace('<svg', '<svg role="img" aria-label="QR code that opens Hoolam on WhatsApp"') : '';

/** Hoolam's one WhatsApp number, to save (vCard) or open, with a QR code for visitors on a computer. */
function officialBlock() {
  if (!wa) return '';
  return `<div class="official${officialQr ? ' has-qr' : ''}">
  <span class="of-ic"><svg class="ic" aria-hidden="true"><use href="#i-shield-check"/></svg></span>
  <div class="of-t"><span>Hoolam’s only WhatsApp number</span><b>${esc(phoneText(wa))}</b></div>
  ${officialQr ? `<div class="of-qr">${officialQr}<small>Scan to chat on your phone</small></div>` : ''}
  <div class="of-btns"><a class="of-btn main" data-wa href="${esc(waLink)}" target="_blank" rel="noopener"><span class="wa-ic" aria-hidden="true"></span>Chat on WhatsApp</a><a class="of-btn ghost" href="/hoolam.vcf"><svg class="ic" aria-hidden="true"><use href="#i-user-plus"/></svg>Save the number</a></div>
  <p class="of-note">We never message you from any other number, never ask for your PIN, OTP or password, and never ask you to pay into a personal account.</p>
</div>`;
}
/** Fills in the chat's pictures and the official number, and adds the voice notes and live numbers where a page uses them. */
function withShow(h) {
  h = h.replace(/\{\{ART:([a-z0-9-]+)\}\}/g, (_, id) => esc(artSrc[id] ?? `${app}/site/art/${id}`))
    .replace(/\{\{ALT:([a-z0-9-]+)\}\}/g, (_, id) => esc(artAlt[id] ?? ''))
    .replaceAll('{{OFFICIAL}}', officialBlock());
  if (!/data-voice=|data-proof|class="official|class="chat-shot/.test(h)) return h;
  return h.replace('</head>', `<link rel="stylesheet" href="/assets/show.css?v=${showCss}">\n</head>`)
    .replace('</body>', `<script>window.HOOLAM_SHOW=${JSON.stringify(showData).replace(/</g, '\\u003c')}</script>\n<script src="/assets/show.js?v=${showJs}" defer></script>\n</body>`);
}

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
  // the company's registrations, as rows of "The company behind Hoolam" (About, Contact us, /legal/)
  SCUML_ROW: `<div><dt>Anti-money laundering</dt><dd>Registered with the EFCC’s Special Control Unit against Money Laundering (SCUML)${COMPANY.scuml ? `, no. ${esc(COMPANY.scuml)}` : ''}</dd></div>\n        `,
  NDIC_ROW: `<div><dt>Deposit insurance</dt><dd>${COMPANY.bankPartner} is insured by the Nigeria Deposit Insurance Corporation (NDIC)</dd></div>\n        `,
  NDPC_ROW: `<div><dt>Data protection</dt><dd>Registered with the Nigeria Data Protection Commission (NDPC)${COMPANY.ndpc ? `, no. ${esc(COMPANY.ndpc)}` : ''}</dd></div>\n        `,
  EMAIL: esc(contact.email), EMAIL_LINK: `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`,
  WHATSAPP: esc(phoneText(wa)), WA_LINK: `<a data-wa href="${esc(waLink)}" target="_blank" rel="noopener">${wa ? `WhatsApp on ${esc(phoneText(wa))}` : 'WhatsApp'}</a>`,
  TXN_SELLER: bandsText(txn.seller), TXN_BUYER: bandsText(txn.buyer),
  FEE_RATE: `${String(fees.rate).replace(/\.0+$/, '')}%`, FEE_MIN: naira(fees.min), FEE_MAX: naira(fees.max), FEE_ROUND: naira(fees.roundTo || 1), MAX_DEAL: naira(maxDeal), MAX_DEAL_VERIFIED: naira(maxDealVerified),
  ACCEPT_HOURS: hours(timing.acceptHours), NUDGE_HOURS: hours(timing.nudgeHours), FLAG_HOURS: hours(timing.flagHours), UNPAID_HOURS: hours(timing.unpaidHours), AUTO_RELEASE: minutesText(timing.autoReleaseMinutes ?? 1440),
};
// About and Contact us sit at the end of the footer's Product list: on every page except the home versions
// made before they existed (versions.json "footerPages")
const FOOTER_MORE = '\n          <li><a href="/about/">About</a></li>\n          <li><a href="/contact/">Contact us</a></li>';
// the home versions made before 18 Oct 2026 (no "ambassadors" in versions.json) keep How it works, Pricing and Why trust us in the footer
const PRODUCT_TOP_OLD = '          <li><a href="/#journey">How it works</a></li>\n          <li><a href="/#pricing">Pricing</a></li>\n          <li><a href="/#trust">Why trust us</a></li>\n';
const FOOTER_AMB = '\n          <li><a href="/ambassadors/">Become an ambassador</a></li>';
const footerSrc = read('partials/footer.html');
// "Our only WhatsApp number": on every page except the home versions made before it (versions.json "official")
// with a QR code that opens the chat, for visitors on a computer
const FOOTER_OFFICIAL = wa ? `\n        <div class="sf-official"><svg class="ic" aria-hidden="true"><use href="#sf-shield"/></svg><span>Our only WhatsApp number is <b>${esc(phoneText(wa))}</b>. <a href="/hoolam.vcf">Save it</a></span>${officialQr ? `<span class="sf-qr">${officialQr}<small>Scan to chat</small></span>` : ''}</div>` : '';
const footerFor = (more, modern = true, official = true) => fill(footerSrc, { ...shared, CONTACT_ITEMS: contactItems, FOOTER_MORE: more ? FOOTER_MORE : '', PRODUCT_TOP: modern ? '' : PRODUCT_TOP_OLD, FOOTER_AMB: modern && amb ? FOOTER_AMB : '', FOOTER_OFFICIAL: official ? FOOTER_OFFICIAL : '' });
// the website chat (site/assets/chat.js): on About, Contact us, the legal pages and the home versions with "liveChat"
const chatJs = read('assets/chat.js');
const chatVer = createHash('sha256').update(chatJs).digest('hex').slice(0, 10);
const chatTag = (logo) => `<script src="/assets/chat.js?v=${chatVer}" data-api="${esc(app)}"${logo ? ` data-logo="${esc(logo)}"` : ''} data-wa="${esc(waLink)}" defer></script>`;
const footerCss = read('partials/footer.css');

// ---------- the home page: the live version at /, every version (and the draft) as a hidden preview ----------
const indexSrc = read('index.html');
const iconTags = (prefix, imgs = baked.images) => imgs?.mark?.src
  ? `<link rel="icon" href="${imgs.mark.src}">\n<link rel="apple-touch-icon" href="${imgs.mark.src}">`
  : `<link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="${prefix}assets/icon-180.png">`;
const NOINDEX = '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">\n<meta name="googlebot" content="noindex, nofollow">';
const footerPages = (v) => !!manifest.versions.find((x) => x.version === v)?.footerPages;
const hasChat = (v) => !!manifest.versions.find((x) => x.version === v)?.liveChat;
const hasAmb = (v) => !!manifest.versions.find((x) => x.version === v)?.ambassadors;
const hasOfficial = (v) => !!manifest.versions.find((x) => x.version === v)?.official;
/** "Ambassador" in the top menu and "Become an ambassador" in the phone menu (home versions from 1.2.0, while the programme is on). */
function withAmbMenu(h) {
  h = h.replace(/(<nav class="menu" aria-label="Main">[\s\S]*?)(<\/nav>)/, '$1<a href="/ambassadors/">Ambassador</a>$2');
  return h.replace(/(\n\s*)(<a href="\/about\/"[^>]*>About)/, '$1<a href="/ambassadors/">Become an ambassador<svg class="ic go" aria-hidden="true"><use href="#i-arrow-right"/></svg></a>$1$2');
}
function homePage(src, version, preview, draft = false) {
  const imgs = versionImages[version] ?? baked.images;
  const pageBaked = { ...baked, images: imgs, version };
  let h = src
    .replaceAll('{{APP_URL}}', app)
    .replaceAll('{{WHATSAPP_NUMBER}}', wa)
    .replaceAll('{{WHATSAPP_LOCAL}}', phoneText(wa) || 'WhatsApp')
    .replaceAll('{{SITE_URL}}/', site ? `${site}/` : '/')
    .replace('/*{{BAKED}}*/{}', JSON.stringify(pageBaked).replace(/</g, '\\u003c'))
    .replace('/*{{FOOTER_CSS}}*/', footerCss)
    .replace('<!--{{FOOTER}}-->', footerFor(draft || footerPages(version), draft || hasAmb(version), draft || hasOfficial(version)));
  if (amb && (draft || hasAmb(version))) h = withAmbMenu(h);
  h = fill(h, { AUTO_RELEASE: shared.AUTO_RELEASE, LEGAL_NAME: shared.LEGAL_NAME, RC: shared.RC, BANK_PARTNER: shared.BANK_PARTNER, BANK_SHORT: String(shared.BANK_PARTNER).replace(/\s*Microfinance Bank$/, ' MFB'), INCORPORATED: shared.INCORPORATED });
  if (draft || hasChat(version)) h = h.replace('</body>', `${chatTag(imgs?.mark?.src)}\n</body>`);
  h = withShow(h);
  h = h.replace(/<link rel="icon" href="\/?assets\/favicon\.svg" type="image\/svg\+xml">\n<link rel="apple-touch-icon" href="\/?assets\/icon-180\.png">/, iconTags('/', imgs));
  if (preview) h = asPreview(h, draft ? 'draft' : version); // never in search results, labelled, links stay in the version
  return h;
}
const versionSrc = (v) => read(`versions/${v}.html`);
writeFileSync(join(out, 'index.html'), homePage(versionSrc(liveVersion), liveVersion, false));
for (const v of VERSIONS) {
  mkdirSync(join(out, 'v', v), { recursive: true });
  writeFileSync(join(out, 'v', v, 'index.html'), homePage(versionSrc(v), v, true));
}
mkdirSync(join(out, 'v', 'draft'), { recursive: true });
writeFileSync(join(out, 'v', 'draft', 'index.html'), homePage(indexSrc, newest, true, true).replace(/Preview · version [\d.]+ · (live now|not live)/, 'Preview · draft · not live'));

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
  { slug: 'ambassadors', title: 'Ambassador agreement', blurb: 'How Hoolam ambassadors earn, get paid, and the rules they follow.' },
];
// The other pages (About, Contact us, Ambassadors, the legal pages) are versioned with the home page: each version
// names its copy in versions.json ("pages"), kept in site/versions/pages/<copy>/ (pages/ and legal/). Versions made
// before 1.2.1 use the copy "1.2.0" (the pages as they were). The draft uses site/pages and site/legal.
const pagesSet = (v) => v === 'draft' ? '' : `versions/pages/${manifest.versions.find((x) => x.version === v)?.pages ?? '1.2.0'}/`;
const readFor = (v, file) => read(`${pagesSet(v)}${file}`);
/** What every page of one version shares: its layouts and its footer. */
function ctxFor(v) {
  return { v, layout: readFor(v, 'legal/_layout.html'), pageLayout: readFor(v, 'pages/_layout.html'), footer: footerFor(true, true, v === 'draft' || hasOfficial(v)) };
}
const liveCtx = ctxFor(liveVersion);
/** A preview of one version (/v/<version>/…): never indexed, labelled, and its links stay inside that version. */
function previewNote(v) {
  return `<div role="note" style="position:fixed;left:50%;bottom:max(12px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;background:#1B2321;color:#fff;font:600 12px/1 Inter,system-ui,sans-serif;padding:9px 14px;border-radius:99px;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:nowrap;pointer-events:none">Preview · ${v === 'draft' ? 'draft' : 'version ' + esc(v)} · ${v === liveVersion ? 'live now' : 'not live'}</div>`;
}
function inVersion(h, v) {
  const b = `/v/${v}`;
  return h.replace(/href="\/(#[^"]*)?"/g, (_, hash) => `href="${b}/${hash ?? ''}"`)
    .replace(/href="\/(about|contact|ambassadors|legal)\//g, `href="${b}/$1/`);
}
function asPreview(h, v) {
  h = h.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${NOINDEX}`).replace(/<link rel="canonical"[^>]*>\n?/g, '').replace(/<meta property="og:url"[^>]*>\n?/g, '')
    .replace(/<meta name="robots" content="index,follow">\n?/, '');
  return inVersion(h, v).replace('</body>', `${previewNote(v)}\n</body>`);
}
const imagesJson = JSON.stringify(Object.fromEntries(Object.entries(baked.images ?? {}).filter(([k]) => k === 'mark').map(([k, v]) => [k, v.src])));

/** "About 4 minutes to read", from the words on the page (about 200 a minute). */
function readTime(html) {
  const words = html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const m = Math.max(1, Math.round(words / 200));
  return `About ${m} minute${m === 1 ? '' : 's'} to read`;
}
function page({ slug, title, blurb, lede, body, toc, path }, ctx = liveCtx) {
  const canonical = site ? `${site}${path}` : '';
  const others = !LEGAL_PAGES.some((p) => p.slug === slug) ? '' : LEGAL_PAGES.filter((p) => p.slug !== slug).map((p) => `<a class="lg-card" href="/legal/${p.slug}/"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('');
  return fill(ctx.layout, {
    ...shared, TITLE: esc(title), DESCRIPTION: esc(blurb), LEDE: lede, BODY: body, TOC: toc, OTHERS: others, SPRITE: sprite, FOOTER: ctx.footer, FOOTER_CSS: footerCss,
    CANONICAL: canonical ? `<link rel="canonical" href="${esc(canonical)}">\n<meta property="og:url" content="${esc(canonical)}">` : '',
    OG_IMAGE: site ? `${site}/assets/og.png` : '/assets/og.png', ICONS: iconTags('/'), IMAGES: imagesJson.replace(/</g, '\\u003c'), WA_HREF: esc(waLink),
    PAGE_CLASS: toc ? 'has-toc' : 'no-toc',
    CHAT: chatTag(baked.images?.mark?.src),
    READ: LEGAL_PAGES.some((p) => p.slug === slug) ? `<p class="lg-read"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>${readTime(body)}</p>` : '',
  }).replace(others ? /^$/ : /\n  <nav class="lg-others"[\s\S]*?<\/nav>/, '');
}

/** The legal pages of one version, into `dir` (the site, or its preview folder). */
function buildLegal(ctx, dir, preview) {
const done = (h) => (preview ? asPreview(withShow(h), ctx.v) : withShow(h));
for (const p of LEGAL_PAGES) {
  const src = fill(readFor(ctx.v, `legal/${p.slug}.html`), shared);
  const lede = (src.match(/<!--lede-->([\s\S]*?)<!--\/lede-->/) ?? [])[1]?.trim() ?? esc(p.blurb);
  const body = src.replace(/<!--lede-->[\s\S]*?<!--\/lede-->/, '').trim();
  const heads = [...body.matchAll(/<h2 id="([a-z0-9-]+)">([\s\S]*?)<\/h2>/g)];
  const toc = heads.length > 2 ? `<ol>${heads.map((h, i) => `<li><a href="#${h[1]}"><span>${String(i + 1).padStart(2, '0')}</span>${h[2]}</a></li>`).join('')}</ol>` : '';
  mkdirSync(join(dir, 'legal', p.slug), { recursive: true });
  writeFileSync(join(dir, 'legal', p.slug, 'index.html'), done(page({ ...p, lede, body, toc, path: `/legal/${p.slug}/` }, ctx)));
}
// /legal/: every page, in plain words
const hub = `<div class="lg-hub">${LEGAL_PAGES.map((p) => `<a class="lg-card" href="/legal/${p.slug}/"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('')}</div>
<section class="lg-company" aria-labelledby="company"><h2 id="company" class="plain">The company behind Hoolam</h2>
<dl><div><dt>Registered name</dt><dd>${COMPANY.legalName}</dd></div><div><dt>RC number</dt><dd>${COMPANY.rc}</dd></div>
<div><dt>Registered with</dt><dd>Corporate Affairs Commission, Nigeria, on ${COMPANY.incorporated}</dd></div><div><dt>Registered office</dt><dd>${esc(COMPANY.address)}</dd></div>
<div><dt>Money for orders held with</dt><dd>${COMPANY.bankPartner}, through ${COMPANY.payService}</dd></div>${shared.SCUML_ROW}${shared.NDIC_ROW}${shared.NDPC_ROW}<div><dt>Contact</dt><dd>${shared.EMAIL_LINK}</dd></div></dl></section>`;
mkdirSync(join(dir, 'legal'), { recursive: true });
writeFileSync(join(dir, 'legal', 'index.html'), done(page({ slug: '', title: 'Legal', blurb: 'Every agreement and policy for using Hoolam, written to be read.',
  lede: 'Every agreement and policy for using Hoolam. We’ve written them to be read, not skimmed past. Each page starts with a short version.', body: hub, toc: '', path: '/legal/' }, ctx)));
}

// ---------- About and Contact us ----------
const repLink = wa ? `https://wa.me/${wa}?text=${encodeURIComponent('Hi Hoolam, I’d like to talk to a rep')}` : waLink;
const socials = (contact.socials ?? []).filter((x) => /^https:\/\//.test(x.url));
// the company as search engines read it (name, registration, address, how to reach us, hours)
const organization = {
  '@type': 'Organization', '@id': `${site || ''}/#organization`, name: 'Hoolam', legalName: COMPANY.legalName, ...(site ? { url: `${site}/` } : {}),
  // the logo the live site shows: the uploaded logo icon, else the drawing
  ...(site ? { logo: baked.images?.mark?.src ? `${site}${baked.images.mark.src}` : `${site}/assets/icon-180.png` } : {}),
  alternateName: ['useHoolam'],
  description: 'Safe buying and selling on WhatsApp, for Nigeria. The buyer’s money waits with Hoolam until the item arrives, then goes to the seller.',
  identifier: { '@type': 'PropertyValue', propertyID: 'RC number (Corporate Affairs Commission, Nigeria)', value: COMPANY.rc },
  email: contact.email || undefined, ...(wa ? { telephone: `+${wa}` } : {}),
  address: { '@type': 'PostalAddress', streetAddress: '8, Delta Bakery Road', addressLocality: 'Woji', addressRegion: 'Rivers State', addressCountry: 'NG' },
  areaServed: { '@type': 'Country', name: 'Nigeria' },
  contactPoint: [{
    '@type': 'ContactPoint', contactType: 'customer support', areaServed: 'NG', availableLanguage: ['English'],
    ...(wa ? { telephone: `+${wa}` } : {}), ...(contact.email ? { email: contact.email } : {}),
    hoursAvailable: { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '09:00', closes: '17:00' },
  }],
  ...(socials.length ? { sameAs: socials.map((x) => x.url) } : {}),
};
// the logo icon and the WhatsApp icon set in Console → Settings → Brand, as on the home page's top bar
const pageImagesJson = JSON.stringify(Object.fromEntries(Object.entries(baked.images ?? {}).filter(([k]) => ['mark', 'whatsapp'].includes(k)).map(([k, v]) => [k, v.src])));
/** What hoolam.com/ambassadors shows: the live shares and payout rules, an example month, and the application form. */
function ambVars() {
  const a = amb;
  const feeAt = (price) => { let f = (price * fees.rate) / 100; f = Math.min(fees.max, Math.max(fees.min, f)); const r = fees.roundTo || 1; f = Math.round(f / r) * r; const band = txn.seller.find((b) => b.upTo == null || price <= b.upTo) ?? txn.seller[txn.seller.length - 1]; return f + band.fee; };
  const rev = feeAt(20000);
  const share = Math.floor((rev * a.sellerPct) / 100), buyer = Math.floor((rev * a.buyerPct) / 100);
  return {
    SELLER_PCT: pctText(a.sellerPct), BUYER_PCT: pctText(a.buyerPct), BONUS: naira(a.bonus), BONUS_ORDERS: String(a.bonusOrders),
    PAYOUT_DAY: ordinal(a.payoutDay), PAYOUT_MIN: naira(a.payoutMin),
    EX_REV: naira(rev), EX_SHARE: naira(share), EX_BUYER: naira(buyer), EX_SELLER_MONTH: naira(share * 10), EX_TWENTY: naira(share * 10 * 20), EX_FIVE: naira(share * 10 * 5),
    EX_MONTH: naira(share * 10 * 6 + a.bonus * 2 + buyer * 8),
    // the calculator on the page: today's fees and the seller share
    CALC_JSON: esc(JSON.stringify({ rate: fees.rate, min: fees.min, max: fees.max, roundTo: fees.roundTo || 1, txn: txn.seller, sellerPct: a.sellerPct })),
    FORM: a.applyWeb ? ambForm(a.api) : `<div class="card closed"><h3>Apply in WhatsApp</h3><p class="sec-p">Applications on the website are closed for now. Open the menu in our WhatsApp chat and tap <b>Become an ambassador</b>.</p><p style="margin-top:16px"><a class="btn" data-wa href="${esc(waLink)}" target="_blank" rel="noopener">Open WhatsApp</a></p></div>`,
  };
}
/** The application: 4 short steps, answers kept if the page reloads, sent to the server. */
function ambForm(api) {
  const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];
  const chips = (name, o) => Object.entries(o).map(([v, t]) => `<label><input type="checkbox" name="${name}" value="${v}"><span>${esc(t)}</span></label>`).join('');
  const radios = (name, o) => Object.entries(o).map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}"><span>${esc(t)}</span></label>`).join('');
  const KNOWS = { vendors: 'Online vendors / sellers', students: 'Students', traders: 'Market traders', shoppers: 'Shoppers', riders: 'Riders and dispatch' };
  const CHANNELS = { status: 'WhatsApp status', groups: 'WhatsApp groups', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', facebook: 'Facebook', in_person: 'In person', flyers: 'Flyers' };
  const REACH = { under_500: 'Under 500', '500_2000': '500 to 2,000', '2000_10000': '2,000 to 10,000', over_10000: 'Over 10,000' };
  return `<form class="card form" id="amb-form" novalidate data-api="${esc(api)}">
  <div class="prog" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i></div>
  <p class="step-of" id="step-of">Step 1 of 4</p>
  <div data-step="1"><h3>About you</h3><p class="hint">So we know who you are and how to reach you.</p><div class="fields">
    <div class="f"><label for="a-name">Full name</label><input type="text" id="a-name" name="name" autocomplete="name" maxlength="80" required><p class="err-msg">Enter your full name.</p></div>
    <div class="f"><label for="a-phone">WhatsApp number</label><input type="tel" id="a-phone" name="phone" autocomplete="tel" inputmode="tel" placeholder="08031234567" required><small>We reply here, and you sign in to your dashboard with it.</small><p class="err-msg">Enter your WhatsApp number, like 08031234567.</p></div>
    <div class="f"><label for="a-email">Email <span class="opt">(optional)</span></label><input type="email" id="a-email" name="email" autocomplete="email" inputmode="email"><p class="err-msg">That email doesn’t look right.</p></div>
  </div></div>
  <div data-step="2" hidden><h3>Where you are</h3><p class="hint">Where you’ll find sellers and buyers.</p><div class="fields">
    <div class="f"><label for="a-state">State</label><select id="a-state" name="state" required><option value="">Choose your state</option>${STATES.map((x) => `<option>${esc(x)}</option>`).join('')}</select><p class="err-msg">Choose your state.</p></div>
    <div class="f"><label for="a-city">City or area</label><input type="text" id="a-city" name="city" maxlength="60" placeholder="Yaba" required><p class="err-msg">Enter your city or area.</p></div>
    <div class="f"><label for="a-community">Campus, market or community <span class="opt">(optional)</span></label><input type="text" id="a-community" name="community" maxlength="80" placeholder="UNILAG, Balogun Market…"><small>Shown on your link if you’re approved, like “Tobi · UNILAG”.</small></div>
  </div></div>
  <div data-step="3" hidden><h3>Your reach</h3><p class="hint">Who you know and where you’ll share Hoolam.</p><div class="fields">
    <fieldset class="f"><legend>Who do you know well?</legend><div class="chips">${chips('knows', KNOWS)}</div><p class="err-msg">Tick at least one.</p></fieldset>
    <fieldset class="f"><legend>Where will you share Hoolam?</legend><div class="chips">${chips('channels', CHANNELS)}</div><p class="err-msg">Tick at least one.</p></fieldset>
    <div class="f"><label for="a-handle">Your main social handle <span class="opt">(optional)</span></label><input type="text" id="a-handle" name="handle" maxlength="60" placeholder="@tobi.styles"></div>
    <fieldset class="f"><legend>Roughly how many people can you reach?</legend><div class="chips">${radios('reach', REACH)}</div><p class="err-msg">Choose one.</p></fieldset>
    <fieldset class="f"><legend>Do you sell online yourself?</legend><div class="chips">${radios('sells', { yes: 'Yes', no: 'No' })}</div><p class="err-msg">Choose one.</p></fieldset>
  </div></div>
  <div data-step="4" hidden><h3>Check and send</h3><p class="hint">Tap Change to fix anything.</p>
    <dl class="review" id="a-review"></dl>
    <div class="fields"><div class="f"><label for="a-why">Why do you want to be a Hoolam ambassador? <span class="opt">(optional)</span></label><textarea id="a-why" name="why" maxlength="600"></textarea></div></div>
    <label class="agree"><input type="checkbox" name="agree" id="a-agree"><span>I agree to the <a href="/legal/ambassadors/" target="_blank" rel="noopener">Ambassador agreement</a>.</span></label>
  </div>
  <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <div class="form-err" id="a-err" role="alert"></div>
  <div class="nav"><button type="button" class="btn ghost" id="a-back" hidden>Back</button><button type="submit" class="btn" id="a-next">Next</button></div>
</form>
<script>
(function () {
  var f = document.getElementById('amb-form'); if (!f) return;
  var KEY = 'hoolam:amb-apply', step = 1, N = 4, sent = false;
  var steps = f.querySelectorAll('[data-step]'), bars = f.querySelectorAll('.prog i'), of = document.getElementById('step-of');
  var back = document.getElementById('a-back'), next = document.getElementById('a-next'), err = document.getElementById('a-err');
  var LABEL = ${JSON.stringify({ knows: KNOWS, channels: CHANNELS, reach: REACH })};
  function vals() { var d = {}; ['name', 'phone', 'email', 'state', 'city', 'community', 'handle', 'why'].forEach(function (k) { d[k] = (f.elements[k].value || '').trim(); });
    d.knows = [].map.call(f.querySelectorAll('[name=knows]:checked'), function (x) { return x.value; }); d.channels = [].map.call(f.querySelectorAll('[name=channels]:checked'), function (x) { return x.value; });
    var r = f.querySelector('[name=reach]:checked'), s = f.querySelector('[name=sells]:checked'); d.reach = r ? r.value : ''; d.sells = s ? s.value : ''; d.agree = f.elements.agree.checked; d.website = f.elements.website.value; return d; }
  function save() { try { var d = vals(); delete d.website; localStorage.setItem(KEY, JSON.stringify({ d: d, step: step })); } catch (e) {} }
  function restore() { try { var j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!j) return; var d = j.d || {};
    ['name', 'phone', 'email', 'state', 'city', 'community', 'handle', 'why'].forEach(function (k) { if (d[k]) f.elements[k].value = d[k]; });
    (d.knows || []).forEach(function (v) { var x = f.querySelector('[name=knows][value="' + v + '"]'); if (x) x.checked = true; });
    (d.channels || []).forEach(function (v) { var x = f.querySelector('[name=channels][value="' + v + '"]'); if (x) x.checked = true; });
    ['reach', 'sells'].forEach(function (k) { var x = d[k] && f.querySelector('[name=' + k + '][value="' + d[k] + '"]'); if (x) x.checked = true; });
    if (d.agree) f.elements.agree.checked = true; if (j.step > 1 && j.step <= N) show(j.step, true); } catch (e) {} }
  function bad(el, on) { var w = el.closest('.f'); if (w) w.classList.toggle('bad', on); return on; }
  function check(n) { var d = vals(), wrong = false, first = null;
    function t(name, cond) { var el = f.elements[name]; var b = bad(el.length ? el[0] : el, cond); if (b && !first) first = el.length ? el[0] : el; wrong = wrong || b; }
    if (n === 1) { t('name', d.name.replace(/\\s+/g, ' ').length < 3); t('phone', !/^(\\+?234|0)?[789][01]\\d{8}$/.test(d.phone.replace(/[\\s-]/g, ''))); t('email', !!d.email && !/^[^\\s@]+@[^\\s@]+\\.[a-z]{2,}$/i.test(d.email)); }
    if (n === 2) { t('state', !d.state); t('city', d.city.length < 2); }
    if (n === 3) { t('knows', !d.knows.length); t('channels', !d.channels.length); t('reach', !d.reach); t('sells', !d.sells); }
    if (first) first.focus(); return !wrong; }
  function review() { var d = vals(), rows = [
      ['Name', d.name, 1], ['WhatsApp', d.phone, 1], ['Email', d.email || '—', 1], ['Where', [d.community, d.city, d.state].filter(Boolean).join(', '), 2],
      ['Knows', d.knows.map(function (k) { return LABEL.knows[k]; }).join(', '), 3], ['Shares on', d.channels.map(function (k) { return LABEL.channels[k]; }).join(', '), 3],
      ['Reach', (LABEL.reach[d.reach] || '') + (d.handle ? ' · ' + d.handle : ''), 3], ['Sells online', d.sells === 'yes' ? 'Yes' : 'No', 3]];
    var dl = document.getElementById('a-review'); dl.innerHTML = '';
    rows.forEach(function (r) { var div = document.createElement('div'); var dt = document.createElement('dt'); dt.textContent = r[0]; var dd = document.createElement('dd'); dd.textContent = r[1];
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Change'; b.setAttribute('aria-label', 'Change ' + r[0].toLowerCase()); b.onclick = function () { show(r[2]); };
      div.appendChild(dt); div.appendChild(dd); div.appendChild(b); dl.appendChild(div); }); }
  function show(n, quiet) { step = n; steps.forEach(function (s) { s.hidden = Number(s.getAttribute('data-step')) !== n; });
    bars.forEach(function (b, i) { b.classList.toggle('on', i < n); }); of.textContent = 'Step ' + n + ' of ' + N;
    back.hidden = n === 1; next.textContent = n === N ? 'Send application' : 'Next'; err.classList.remove('on');
    if (n === N) review(); save();
    if (!quiet) { var top = f.getBoundingClientRect().top; if (top < 70) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); var h = steps[n - 1].querySelector('h3'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } } }
  back.onclick = function () { if (step > 1) show(step - 1); };
  f.addEventListener('input', save); f.addEventListener('change', function (e) { var w = e.target.closest('.f'); if (w) w.classList.remove('bad'); save(); });
  f.addEventListener('submit', function (e) {
    e.preventDefault(); if (sent) return;
    if (step < N) { if (check(step)) show(step + 1); return; }
    var d = vals(); if (!d.agree) { err.textContent = 'Please tick that you agree to the Ambassador agreement.'; err.classList.add('on'); return; }
    next.disabled = true; next.textContent = 'Sending…'; err.classList.remove('on');
    fetch(f.getAttribute('data-api') + '/ambassadors/apply', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); return j; }); })
      .then(function (j) { sent = true; try { localStorage.removeItem(KEY); } catch (x) {}
        if (window.gtag) gtag('event', 'ambassador_apply', { already: !!j.already });
        f.innerHTML = '<div class="done"><i><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg></i><h3>' + (j.already ? 'We already have your application' : 'Application sent') + '</h3><p>We’ll reply on WhatsApp within 24 hours. Keep an eye on your chats.</p></div>'; })
      .catch(function (x) { next.disabled = false; next.textContent = 'Send application'; err.textContent = x.message || 'Something went wrong. Please try again.'; err.classList.add('on'); });
  });
  restore();
})();
</script>`;
}

const INFO_PAGES = [
  { slug: 'about', type: 'AboutPage', title: 'About Hoolam: safe buying and selling on WhatsApp',
    description: 'Hoolam holds the buyer’s money until the item arrives, then pays the seller. Who we are, why we built it, and what keeps your money safe.' },
  { slug: 'contact', type: 'ContactPage', title: 'Contact Hoolam: WhatsApp, email and live reps',
    description: 'Reach Hoolam on WhatsApp any time, or talk to a live rep from 9am to 5pm, every day. Email, phone and our registered office in Nigeria.' },
  ...(amb ? [{ slug: 'ambassadors', type: 'WebPage', title: 'Become a Hoolam ambassador: earn from every safe order you bring',
    description: 'Bring sellers and buyers to Hoolam and earn a share of what Hoolam makes on their completed orders, paid monthly. Free to join; we reply within 24 hours.' }] : []),
];
/** About, Contact us and Ambassadors of one version, into `dir`. */
function buildInfo(ctx, dir, preview) {
for (const p of INFO_PAGES) {
  const path = `/${p.slug}/`;
  const canonical = site ? `${site}${path}` : '';
  const vars = {
    ...shared, WA_HREF: esc(waLink), REP_HREF: esc(repLink), BANK_SHORT: String(COMPANY.bankPartner).replace(/\s*Microfinance Bank$/, ' MFB'),
    // the registration number is added once it's set in COMPANY.scuml

    HERE_ABOUT: p.slug === 'about' ? ' class="here" aria-current="page"' : '', HERE_CONTACT: p.slug === 'contact' ? ' class="here" aria-current="page"' : '',
    MENU_AMB: amb ? `<a href="/ambassadors/"${p.slug === 'ambassadors' ? ' aria-current="page"' : ''}>Ambassador</a>` : '',
    DRAWER_AMB: amb ? `    <a href="/ambassadors/"${p.slug === 'ambassadors' ? ' class="here" aria-current="page"' : ''}>Become an ambassador<svg class="ic go" aria-hidden="true"><use href="#i-arrow-right"/></svg></a>\n` : '',
    ...(p.slug === 'ambassadors' ? ambVars() : {}),
    WA_BIG: wa ? `<a class="big" data-wa href="${esc(waLink)}" target="_blank" rel="noopener">${esc(phoneText(wa))}</a>` : '',
    PHONE_CARD: contact.phone && contact.phone !== wa
      ? `<div class="way card"><i><svg class="ic" aria-hidden="true"><use href="#sf-phone"/></svg></i><h2>Call us</h2><a class="big" href="tel:+${esc(contact.phone)}">${esc(phoneText(contact.phone))}</a><p>From 9am to 5pm, every day.</p></div>` : '',
    SAFETY: wa ? `Hoolam only messages you from <b>${esc(phoneText(wa))}</b>.` : '',
    REP_REPLY: minutesText(Number(timing.repReplyMinutes) || 30),
    // your photo on the About page (Console → Settings → Brand), else your initial
    FOUNDER_PHOTO: baked.images?.founder?.src ? `<img src="${esc(baked.images.founder.src)}" alt="Raphael Levinders, founder of Hoolam" width="320" height="320" loading="lazy">` : '<span aria-hidden="true">R</span>',
    MAP_HREF: esc(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(COMPANY.address)}`),
    SOCIALS: socials.length ? `<div class="socials" aria-label="Hoolam on social media">${socials.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Hoolam on ${esc(x.name)}: ${esc(x.label)}"><svg class="ic" aria-hidden="true"><use href="#sf-${esc(x.kind)}"/></svg>${esc(x.label)}</a>`).join('')}</div>` : '',
  };
  // About's "Who's behind Hoolam" shows only while it's on (Console → Settings → Features)
  const founderOn = !!(ok && live.about?.founder);
  const body = fill(readFor(ctx.v, `pages/${p.slug}.html`), vars).replace(/<!--founder-->([\s\S]*?)<!--\/founder-->/, (_, x) => (founderOn ? x : ''));
  const jsonld = { '@context': 'https://schema.org', '@graph': [organization, { '@type': p.type, name: p.title, description: p.description, ...(canonical ? { url: canonical } : {}), about: { '@id': organization['@id'] }, inLanguage: 'en-NG' }] };
  const html = fill(ctx.pageLayout, {
    ...vars, TITLE: esc(p.title), DESCRIPTION: esc(p.description), BODY: body, SPRITE: sprite, FOOTER: ctx.footer, FOOTER_CSS: footerCss,
    CANONICAL: canonical ? `<link rel="canonical" href="${esc(canonical)}">\n<meta property="og:url" content="${esc(canonical)}">` : '',
    OG_IMAGE: site ? `${site}/assets/og.png` : '/assets/og.png', ICONS: iconTags('/'), IMAGES: pageImagesJson.replace(/</g, '\\u003c'),
    JSONLD: JSON.stringify(jsonld).replace(/</g, '\\u003c'),
    CHAT: chatTag(baked.images?.mark?.src),
  });
  mkdirSync(join(dir, p.slug), { recursive: true });
  writeFileSync(join(dir, p.slug, 'index.html'), preview ? asPreview(withShow(html), ctx.v) : withShow(html));
}
}
// the live version's pages at /about/, /legal/… and every version's (and the draft's) at /v/<version>/about/…
buildLegal(liveCtx, out, false);
buildInfo(liveCtx, out, false);
for (const v of [...VERSIONS, 'draft']) { const c = ctxFor(v); buildLegal(c, join(out, 'v', v), true); buildInfo(c, join(out, 'v', v), true); }

// ---------- "Save the number": a contact card for Hoolam's one WhatsApp number ----------
/** The logo icon as the contact's photo, when it's a PNG or JPEG (lines folded at 75 characters, as vCards need). */
function vcPhoto() {
  const src = baked.images?.mark?.src;
  const type = src && (/\.png$/.test(src) ? 'PNG' : /\.jpe?g$/.test(src) ? 'JPEG' : null);
  if (!type) return [];
  try {
    const line = `PHOTO;ENCODING=b;TYPE=${type}:${readFileSync(join(out, src)).toString('base64')}`;
    return [line.match(/.{1,74}/g).join('\r\n ')];
  } catch { return []; }
}
if (wa) {
  const vc = (t) => String(t).replace(/([,;\\])/g, '\\$1');
  writeFileSync(join(out, 'hoolam.vcf'), ['BEGIN:VCARD', 'VERSION:3.0', 'N:;Hoolam;;;', 'FN:Hoolam', `ORG:${vc(COMPANY.legalName)}`, `TEL;TYPE=CELL,VOICE:+${wa}`,
    ...(contact.email ? [`EMAIL;TYPE=INTERNET:${contact.email}`] : []), ...(site ? [`URL:${site}/`] : []),
    `NOTE:${vc('Hoolam\'s only WhatsApp number. Safe buying and selling: your money is held until you get what you ordered.')}`, ...vcPhoto(), 'END:VCARD', ''].join('\r\n'));
}

// ---------- search engines and AI tools ----------
// The live home page says who Hoolam is (company data), where its real address is (canonical) and its questions and answers (FAQ),
// all read from what the page itself shows. Nothing here changes how any page looks.
const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (h) => decode(h.replace(/<span class="pm">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
// the fee answer as visitors see it once the page has loaded today's fees
const feeAnswer = `${shared.FEE_RATE} of the price, starting from ${shared.FEE_MIN}, never more than ${shared.FEE_MAX}. Whoever starts the order pays it. The other side pays a small flat transaction fee, from ${naira(txn.seller[0].fee)}. Orders go up to ${shared.MAX_DEAL} for now.`;
const homeFile = join(out, 'index.html');
const homeHtml = readFileSync(homeFile, 'utf8');
const faqHtml = homeHtml.match(/<section class="faq"[\s\S]*?<\/section>/)?.[0] ?? '';
const faq = [...faqHtml.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p([^>]*)>([\s\S]*?)<\/p>\s*<\/details>/g)]
  .map(([, q, attrs, ans]) => ({ q: plain(q), a: /data-p="faq"/.test(attrs) ? feeAnswer : plain(ans) })).filter((x) => x.q && x.a);
if (site) {
  const homeLd = { '@context': 'https://schema.org', '@graph': [
    organization,
    { '@type': 'WebSite', '@id': `${site}/#website`, url: `${site}/`, name: 'Hoolam', inLanguage: 'en-NG', publisher: { '@id': organization['@id'] } },
    { '@type': 'WebPage', '@id': `${site}/#webpage`, url: `${site}/`, name: 'Hoolam · Safe orders on WhatsApp', isPartOf: { '@id': `${site}/#website` }, about: { '@id': organization['@id'] }, inLanguage: 'en-NG' },
    ...(faq.length ? [{ '@type': 'FAQPage', '@id': `${site}/#faq`, mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) }] : []),
  ] };
  const tags = `<link rel="canonical" href="${site}/">\n${homeHtml.includes('property="og:url"') ? '' : `<meta property="og:url" content="${site}/">\n`}<script type="application/ld+json">${JSON.stringify(homeLd).replace(/</g, '\\u003c')}</script>\n`;
  writeFileSync(homeFile, homeHtml.replace('</head>', `${tags}</head>`));
}

// llms.txt: a plain summary of Hoolam for AI assistants (https://llmstxt.org)
const llms = `# Hoolam

> Hoolam is a WhatsApp escrow service for Nigeria. When people buy and sell on WhatsApp, Instagram, TikTok or Facebook, the buyer pays Hoolam instead of the seller. Hoolam holds the money safely until the buyer has received the item and is happy, then pays the seller. No app is needed: everything happens in a WhatsApp chat.

Hoolam is run by ${COMPANY.legalName} (RC ${COMPANY.rc}), registered with the Corporate Affairs Commission, Nigeria. Money for orders is held with ${COMPANY.bankPartner}${COMPANY.payService ? ` (${COMPANY.payService})` : ''}, insured by the NDIC. Hoolam is registered with the EFCC's Special Control Unit against Money Laundering (SCUML) and the Nigeria Data Protection Commission (NDPC).

## How it works

1. It starts on WhatsApp: the buyer tells Hoolam what they're buying and the price agreed, and the seller confirms with one tap.
2. The buyer pays by bank transfer to a one-time account for that order. The money goes to Hoolam, not the seller.
3. The seller can see the money is ready, then sends the item.
4. The buyer checks the item at the door.
5. If the buyer is happy, the seller is paid straight to their bank account. If something is wrong, the money stays frozen while a Hoolam rep sorts it out.

## Fees

- Hoolam's fee: ${shared.FEE_RATE} of the price, starting from ${shared.FEE_MIN}, never more than ${shared.FEE_MAX}. Whoever starts the order pays it.
- The other side pays a small flat transaction fee: ${shared.TXN_SELLER}.
- Orders go up to ${shared.MAX_DEAL} for now (${shared.MAX_DEAL_VERIFIED} for verified users).

## Questions

${faq.map((x) => `- **${x.q}** ${x.a}`).join('\n')}

## Contact

${wa ? `- WhatsApp (orders and help, any time): ${phoneText(wa)} (https://wa.me/${wa})\n` : ''}${contact.email ? `- Email: ${contact.email}\n` : ''}- Live reps: 9am to 5pm, every day (live chat on the website, or WhatsApp)
- Registered office: ${COMPANY.address}

## Pages
${site ? `
- [Home](${site}/): what Hoolam is, how an order works, fees and questions
- [About](${site}/about/): who we are, why we built Hoolam, the company behind it
- [Contact us](${site}/contact/): WhatsApp, live reps, email and office${amb ? `\n- [Become an ambassador](${site}/ambassadors/): bring sellers and buyers to Hoolam and earn a share of what Hoolam makes on their completed orders` : ''}
- [Where the money sits](${site}/legal/money/): the bank, the accounts, and every step the money takes
- [If something goes wrong](${site}/legal/disputes/): reporting a problem and how refunds work
- [Terms of service](${site}/legal/terms/)
- [Privacy policy](${site}/legal/privacy/)
` : ''}`;
writeFileSync(join(out, 'llms.txt'), llms);

const pages = ['/', '/about/', '/contact/', ...(amb ? ['/ambassadors/'] : []), '/legal/', ...LEGAL_PAGES.map((p) => `/legal/${p.slug}/`)];
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${site ? `Sitemap: ${site}/sitemap.xml\n` : ''}`);
// when each page last changed: the newest commit touching the files it's built from (left out if git isn't there)
const lastChanged = (files) => { try { return execFileSync('git', ['log', '-1', '--format=%cs', '--', ...files.map((f) => join(here, f))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const ps = pagesSet(liveVersion);
const sources = (p) => p === '/' ? [`versions/${liveVersion}.html`, 'versions/versions.json', 'partials'] : p === '/about/' || p === '/contact/' || p === '/ambassadors/' ? [`${ps}pages${p.slice(0, -1)}.html`, `${ps}pages/_layout.html`, 'partials'] : p === '/legal/' ? [`${ps}legal/_layout.html`, 'partials'] : [`${ps}legal${p.slice(6, -1)}.html`, `${ps}legal/_layout.html`];
// the pictures on each page, for Google Images: the images uploaded for the live version (the drawings are drawn in code, so they aren't image files)
const pageImages = (p) => p === '/' ? Object.entries(baked.images ?? {}).filter(([k]) => k !== 'whatsapp').map(([, v]) => v.src)
  : baked.images?.mark ? [baked.images.mark.src] : [];
const imageTags = (p) => pageImages(p).map((src) => `<image:image><image:loc>${esc(site + src)}</image:loc></image:image>`).join('');
if (site) writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${pages.map((p) => { const d = lastChanged(sources(p)); return `  <url><loc>${site}${p}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}${imageTags(p)}</url>`; }).join('\n')}\n</urlset>\n`);
// what to do next, for the 404 page and the campaign links' in-between page: check a seller, start an order, the official number
const chatTo = (t) => wa ? `https://wa.me/${wa}?text=${encodeURIComponent(t)}` : `${app}/chat?text=${encodeURIComponent(t)}`;
const NEXT_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="nx-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></symbol><symbol id="nx-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol><symbol id="nx-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></symbol><symbol id="i-shield-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></symbol><symbol id="i-user-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></symbol></defs></svg>`;
const NEXT_CSS = `.nx-list{display:grid;gap:10px;margin:8px 0 22px;padding:0;list-style:none}
.nx-list a{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:18px;background:var(--card,#FFFDF9);box-shadow:inset 0 0 0 1px var(--rule,#E8E1D5);text-decoration:none;color:inherit}
.nx-list a:hover{box-shadow:inset 0 0 0 1.5px var(--teal,#0E5C63)}
.nx-list i{flex:none;width:40px;height:40px;border-radius:12px;background:var(--mint,#E2EFEA);color:var(--teal,#0E5C63);display:grid;place-items:center}
.nx-list i svg{width:20px;height:20px}
.nx-list span{font-size:.9rem;color:var(--soft,#58615E);line-height:1.45}.nx-list b{display:block;color:var(--ink,#1B2321);font-size:1rem}`;
const nextSteps = () => `${NEXT_SPRITE}<style>${NEXT_CSS}</style><ul class="nx-list">
<li><a data-wa href="${esc(chatTo('Check a seller'))}" target="_blank" rel="noopener"><i><svg aria-hidden="true"><use href="#nx-search"/></svg></i><span><b>Check a seller</b>Send their number on WhatsApp and see their record before you pay.</span></a></li>
<li><a data-wa href="${esc(chatTo('Hi Hoolam, I want to buy safely'))}" target="_blank" rel="noopener"><i><svg aria-hidden="true"><use href="#nx-lock"/></svg></i><span><b>Start a safe order</b>You pay Hoolam. The seller is paid when you’re happy.</span></a></li>
<li><a href="/"><i><svg aria-hidden="true"><use href="#nx-home"/></svg></i><span><b>Go to the home page</b>See how Hoolam works and what it costs.</span></a></li>
</ul>`;
writeFileSync(join(out, '404.html'), withShow(page({ slug: '404', title: 'Page not found', blurb: 'This page doesn’t exist.', lede: 'The link may be wrong or old. Here’s what you can do instead.', body: `${nextSteps()}{{OFFICIAL}}`, toc: '', path: '/404' }).replace('<meta name="robots" content="index,follow">', '<meta name="robots" content="noindex">')
  .replace(/<ul class="lg-meta"[\s\S]*?<\/ul>/, '').replace(/<aside class="lg-end">[\s\S]*?<\/aside>/, '').replace('<style>.nx-list{', '<style>.lg-doc .nx-list{padding:0}.nx-list{')));

// ---------- hoolam.com/check: is this a real Hoolam order? ----------
// For someone who got an order on WhatsApp from a number they don't know: type the code (or open the link with ?c=HL-…),
// the server answers yes (item, price, when it started, where it stands) or no. Never in search results.
mkdirSync(join(out, 'check'), { recursive: true });
writeFileSync(join(out, 'check', 'index.html'), withShow(`<!doctype html>
<html lang="en-NG"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Check a Hoolam order</title><meta name="description" content="Got an order on WhatsApp? Type its code to check it's a real Hoolam order."><meta name="robots" content="noindex"><meta name="theme-color" content="#0E5C63">
${iconTags('/')}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700&display=swap">
<style>
:root{--teal:#0E5C63;--teal-2:#0A464B;--gold:#C9992E;--green:#2E8B57;--red:#B4442E;--bg:#F7F3EC;--card:#FFFDF9;--ink:#1B2321;--soft:#58615E;--rule:#E8E1D5;--mint:#E2EFEA}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:400 16px/1.55 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.w{max-width:460px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;gap:10px;height:52px;color:var(--ink);text-decoration:none}.top b{font:600 1.25rem Poppins,Inter,sans-serif;letter-spacing:-.02em}
.mk{width:34px;height:34px;border-radius:11px;background:var(--teal);display:grid;place-items:center;overflow:hidden}.mk img{width:100%;height:100%;object-fit:contain}.mk.img{background:none}
h1{font:700 1.6rem/1.2 Poppins,Inter,sans-serif;letter-spacing:-.03em;margin-top:18px}
.lead{color:var(--soft);margin-top:6px}
form{display:flex;gap:8px;margin-top:18px}
input{flex:1;min-width:0;height:56px;border:1.5px solid var(--rule);border-radius:16px;padding:0 16px;font:600 1.15rem Inter,sans-serif;letter-spacing:.06em;text-transform:uppercase;background:#fff;color:var(--ink)}
input::placeholder{letter-spacing:.04em;color:#A8AFAC;font-weight:500}
input:focus{outline:3px solid rgba(201,153,46,.35);border-color:var(--gold)}
button{height:56px;padding:0 22px;border:0;border-radius:16px;background:var(--teal);color:#fff;font:600 1rem Inter,sans-serif;cursor:pointer}button:hover{background:var(--teal-2)}button[disabled]{opacity:.6}
.res{margin-top:16px;border-radius:22px;background:var(--card);box-shadow:inset 0 0 0 1px var(--rule);overflow:hidden}
.res[hidden]{display:none}
.rh{display:flex;align-items:center;gap:12px;padding:16px 18px}
.rh i{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}.rh i svg{width:22px;height:22px}
.rh b{font:700 1.08rem/1.3 Poppins,Inter,sans-serif}
.ok .rh{background:#E7F4EC}.ok .rh i{background:var(--green);color:#fff}.ok .rh b{color:#1F6B42}
.no .rh{background:#FBECE8}.no .rh i{background:var(--red);color:#fff}.no .rh b{color:var(--red)}
.rows{padding:6px 18px 4px}
.rows div{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--rule)}
.rows div:first-child{border-top:0}
.rows span{color:var(--soft)}.rows strong{font-weight:600;text-align:right}
.steps{display:flex;gap:6px;padding:4px 18px 0}.steps i{flex:1;height:6px;border-radius:9px;background:var(--rule)}.steps i.on{background:var(--teal)}
.st{padding:10px 18px 0;font-weight:600}
.note{margin:14px 18px 18px;padding:12px 14px;border-radius:14px;background:#FBF4E2;color:#5B430C;font-size:.9rem}
.no p{padding:14px 18px 0;color:var(--soft)}.no p.note{margin:12px 18px 16px;padding:12px 14px;color:#5B430C}
.go{display:flex;align-items:center;justify-content:center;gap:8px;min-height:50px;margin:0 18px 18px;border-radius:14px;background:var(--teal);color:#fff;font-weight:600;text-decoration:none}
.sec{margin-top:26px}
a:focus-visible,button:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
</style></head>
<body>${NEXT_SPRITE}<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="ck-yes" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></symbol><symbol id="ck-no" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></symbol></defs></svg>
<div class="w">
<a class="top" href="/"><span class="mk${baked.images?.mark?.src ? ' img' : ''}">${baked.images?.mark?.src ? `<img src="${esc(baked.images.mark.src)}" alt="">` : '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8.5" r="3.7" fill="#C9992E"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'}</span><b>Hoolam</b></a>
<h1>Check a Hoolam order</h1>
<p class="lead">Got an order on WhatsApp? Type its code to see if it’s real.</p>
<form id="f" novalidate><label class="sr" for="c" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Order code</label>
<input id="c" name="c" placeholder="HL-7K2QF" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="10" required><button id="b">Check</button></form>
<div class="res" id="r" hidden aria-live="polite"></div>
${wa ? `<section class="sec">{{OFFICIAL}}</section>` : ''}
</div>
<script>(function(){
var API=${JSON.stringify(app)},WA=${JSON.stringify(wa ? `https://wa.me/${wa}?text=` : `${app}/chat?text=`)};
var f=document.getElementById('f'),c=document.getElementById('c'),b=document.getElementById('b'),r=document.getElementById('r');
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]})}
function norm(v){v=String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^HL/,'');return v?'HL-'+v:''}
function day(s){return new Date(s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Lagos'})}
function show(h,cls){r.className='res '+cls;r.innerHTML=h;r.hidden=false}
function check(code){
  if(!/^HL-[A-Z2-9]{5}$/.test(code)){show('<div class="rh"><i><svg><use href="#ck-no"/></svg></i><b>That doesn’t look like an order code</b></div><p>It looks like HL- and 5 letters or numbers, for example HL-7K2QF.</p><div style="height:18px"></div>','no');return}
  b.disabled=true;b.textContent='Checking…';
  fetch(API+'/check/'+encodeURIComponent(code)+'.json').then(function(x){return x.json().then(function(j){if(!x.ok)throw new Error(j.error||'Try again');return j})}).then(function(j){
    if(j.found){var bars='';for(var i=1;i<=6;i++)bars+='<i class="'+(i<=j.step?'on':'')+'"></i>';
      show('<div class="rh"><i><svg><use href="#ck-yes"/></svg></i><b>This is a real Hoolam order</b></div>'+
        '<div class="rows"><div><span>Order</span><strong>'+esc(j.code)+'</strong></div><div><span>Item</span><strong>'+esc(j.item)+'</strong></div><div><span>Price</span><strong>'+esc(j.price)+'</strong></div><div><span>Started</span><strong>'+day(j.started)+'</strong></div></div>'+
        (j.step?'<div class="steps" aria-hidden="true">'+bars+'</div>':'')+'<p class="st">'+esc(j.status)+'</p>'+
        '<p class="note">Only pay into the account Hoolam sends you in our WhatsApp chat. Never pay anyone directly.</p>','ok');
    }else{
      show('<div class="rh"><i><svg><use href="#ck-no"/></svg></i><b>We can’t find this order</b></div><p>Don’t send anything or pay anyone for it. Ask us first.</p>'+
        '<p class="note">Check the code is typed right: HL- and 5 letters or numbers.</p><a class="go" data-wa href="'+esc(WA+encodeURIComponent('Hi Hoolam, is order '+code+' real?'))+'" target="_blank" rel="noopener">Ask Hoolam on WhatsApp</a>','no');
    }
    if(window.gtag)gtag('event','order_check',{found:!!j.found});
  }).catch(function(e){show('<div class="rh"><i><svg><use href="#ck-no"/></svg></i><b>'+esc(e.message||'Couldn’t check right now')+'</b></div><div style="height:18px"></div>','no')}).then(function(){b.disabled=false;b.textContent='Check'})}
f.onsubmit=function(e){e.preventDefault();var code=norm(c.value);if(code)c.value=code;check(code);try{history.replaceState(null,'','?c='+encodeURIComponent(code))}catch(x){}};
var q=new URLSearchParams(location.search).get('c');if(q){c.value=norm(q);check(norm(q))}else c.focus();
})();</script>
</body></html>
`));

// ---------- campaign links (Console → Settings → Links) ----------
// hoolam.com/<slug>: a tiny page that counts the tap on the server, then moves the visitor on to the page with the tags
// Google Analytics reads (utm_source / utm_medium / utm_campaign). Never in search results, and never over a real page.
const campaignLinks = (ok && Array.isArray(live.links)) ? live.links.filter((l) => /^[a-z0-9-]{2,40}$/.test(l.slug) && typeof l.target === 'string' && l.target.startsWith('/')) : [];
let linksBuilt = 0;
for (const l of campaignLinks) {
  const dir = join(out, l.slug);
  if (existsSync(dir)) { console.log(`  skipped link /${l.slug}: the website already uses that address`); continue; }
  mkdirSync(dir, { recursive: true });
  const target = esc(l.target);
  writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hoolam</title><meta name="robots" content="noindex">${site ? `<link rel="canonical" href="${site}/">` : ''}
<meta http-equiv="refresh" content="1; url=${target}">
<script>(function(){try{navigator.sendBeacon&&navigator.sendBeacon(${JSON.stringify(`${app}/l/${l.slug}/tap`)})}catch(e){}location.replace(${JSON.stringify(l.target)}+(location.hash||''))})();</script>
<style>:root{--teal:#0E5C63;--card:#FFFDF9;--rule:#E8E1D5;--mint:#E2EFEA;--ink:#1B2321;--soft:#58615E}body{margin:0;min-height:100vh;background:#F7F3EC;font:16px/1.55 Inter,system-ui,sans-serif;color:#1B2321;padding:32px 16px}.w{max-width:440px;margin:0 auto}h1{font:700 1.3rem/1.3 Poppins,Inter,sans-serif;color:#0E5C63;margin:0 0 6px}p{margin:0 0 16px;color:#58615E}.go{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:16px;background:#0E5C63;color:#fff;font-weight:600;text-decoration:none;margin-bottom:22px}</style>
</head><body><div class="w"><h1>Taking you to Hoolam…</h1><p>If nothing happens, tap the button.</p><a class="go" href="${target}">Continue to Hoolam</a>
<p>Or, while you’re here:</p>${nextSteps()}</div></body></html>
`);
  linksBuilt++;
}

// ---------- ambassadors' links: hoolam.com/a/<name> ----------
// A small welcome page for the people an ambassador shares it with: their photo and first name, what Hoolam is,
// and "I'm buying" / "I'm selling", each opening WhatsApp with "… Tobi sent me (TOBI)" typed in, so they're linked to
// the ambassador. The tap is counted on the server. Never in search results. An old name moves to the new one;
// an ended or paused ambassador's link still works, without their name.
let ambBuilt = 0;
for (const l of ambLinks) {
  const dir = join(out, 'a', l.slug);
  mkdirSync(dir, { recursive: true });
  if (l.to) {
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=/a/${esc(l.to)}/"><title>Hoolam</title><script>location.replace('/a/${l.to}/'+location.search)</script></head><body><a href="/a/${esc(l.to)}/">Continue to Hoolam</a></body></html>\n`);
    continue;
  }
  writeFileSync(join(dir, 'index.html'), withShow(ambLinkPage(l)));
  ambBuilt++;
}
function ambLinkPage(l) {
  const name = l.active && l.name ? l.name : null;
  const code = name ? ` ${name} sent me (${l.slug.toUpperCase()})` : '';
  const go = (what) => wa ? `https://wa.me/${wa}?text=${encodeURIComponent(`Hi Hoolam, I want to ${what} safely.${code}`)}` : `${app}/chat?text=${encodeURIComponent(`Hi Hoolam, I want to ${what} safely.${code}`)}`;
  const title = name ? `${name} invited you to Hoolam` : 'Buy and sell safely with Hoolam';
  const desc = 'Buy and sell on WhatsApp safely. Your money is held until you get what you ordered.';
  const og = l.photo || (site ? `${site}/assets/og.png` : '/assets/og.png');
  const mark = baked.images?.mark?.src;
  const badge = name ? `<span class="ver"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>Verified Hoolam ambassador${l.area ? ` · ${esc(l.area)}` : ''}</span>` : '';
  const shot = (n, id, cap) => `<figure class="chat-shot"><div class="cs-bubble"><img src="{{ART:${id}}}" alt="{{ALT:${id}}}" loading="lazy" decoding="async" width="900" height="900"><span class="cs-time">9:41<svg class="ic" aria-hidden="true"><use href="#i-check-check"/></svg></span></div><figcaption><b>${n}</b>${cap}</figcaption></figure>`;
  return `<!doctype html>
<html lang="en-NG"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#0E5C63">
${iconTags('/')}
<meta property="og:type" content="website"><meta property="og:site_name" content="Hoolam"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(og)}">${l.photo ? '<meta property="og:image:width" content="800"><meta property="og:image:height" content="800"><meta name="twitter:card" content="summary">' : '<meta name="twitter:card" content="summary_large_image">'}
${site ? `<meta property="og:url" content="${esc(`${site}/a/${l.slug}/`)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700&display=swap">
<style>
:root{--teal:#0E5C63;--teal-3:#083E43;--gold:#C9992E;--green:#2E8B57;--bg:#F7F3EC;--card:#FFFDF9;--ink:#1B2321;--soft:#58615E;--rule:#E8E1D5;--mint:#E2EFEA}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:400 16px/1.6 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
.w{width:100%;max-width:460px;margin:0 auto;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;gap:10px;height:52px;color:var(--ink);text-decoration:none}.top b{font:600 1.25rem Poppins,Inter,sans-serif;letter-spacing:-.02em}
.mk{width:34px;height:34px;border-radius:11px;background:var(--teal);display:grid;place-items:center;overflow:hidden}.mk img{width:100%;height:100%;object-fit:contain}.mk.img{background:none}
.card{margin-top:12px;background:var(--card);border-radius:28px;box-shadow:inset 0 0 0 1px var(--rule),0 24px 50px -32px rgba(8,62,67,.55);overflow:hidden;text-align:center}
.cov{height:96px;background:radial-gradient(120% 140% at 85% -20%,rgba(201,153,46,.5),transparent 55%),linear-gradient(135deg,#12737b,var(--teal) 55%,var(--teal-3))}
.av{width:112px;height:112px;margin:-60px auto 0;border-radius:50%;background:#EAF3F3;box-shadow:0 0 0 5px var(--card),0 0 0 7px var(--gold);overflow:hidden;display:grid;place-items:center;font:700 2.6rem Poppins,Inter,sans-serif;color:var(--teal);position:relative}
.av img{width:100%;height:100%;object-fit:cover}
.in{padding:16px 22px 24px}h1{font:700 1.6rem/1.2 Poppins,Inter,sans-serif;letter-spacing:-.03em}
.ver{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:5px 11px;border-radius:99px;background:#E7F4EC;color:var(--green);font-size:.82rem;font-weight:600}
.ver svg{width:15px;height:15px}
.lead{margin-top:14px;color:var(--soft);font-size:1.02rem}
.btns{display:grid;gap:10px;margin-top:20px}
.b{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;border-radius:16px;font:600 1.02rem Inter,sans-serif;text-decoration:none;transition:transform .15s,background .2s}
.b:active{transform:scale(.98)}.b svg{width:20px;height:20px}
.b.buy{background:var(--teal);color:#fff;box-shadow:0 14px 28px -14px rgba(14,92,99,.8)}.b.buy:hover{background:#0A464B}
.b.sell{background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--rule)}.b.sell:hover{box-shadow:inset 0 0 0 1.5px var(--teal)}
.how{margin-top:14px;display:grid;gap:8px;text-align:left}
.how div{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:16px;background:var(--card);box-shadow:inset 0 0 0 1px var(--rule);font-size:.95rem}
.how i{width:34px;height:34px;border-radius:11px;background:var(--mint);color:var(--teal);display:grid;place-items:center;flex:none}.how i svg{width:18px;height:18px}
.foot{margin-top:18px;text-align:center;color:var(--soft);font-size:.8rem;line-height:1.5}.foot a{color:var(--teal);font-weight:600;text-decoration:none}
/* their photo is the page: big, square, with who they are on it */
.ph{position:relative;aspect-ratio:1/1;background:#EAF3F3}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.ph::after{content:"";position:absolute;inset:auto 0 0;height:46%;background:linear-gradient(transparent,rgba(8,62,67,.82))}
.ph .ver{position:absolute;left:16px;bottom:16px;z-index:1;margin:0;background:rgba(255,253,249,.95);box-shadow:0 6px 18px -8px rgba(0,0,0,.4)}
.sec{margin-top:26px}
.sec h2{font:700 1.15rem/1.3 Poppins,Inter,sans-serif;letter-spacing:-.02em;margin:0 0 4px}
.sec>p{color:var(--soft);font-size:.92rem;margin:0 0 12px}
.shots{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-inline:16px;margin:0 -16px;padding:4px 16px 10px;scrollbar-width:none}
.shots::-webkit-scrollbar{display:none}
.shots .chat-shot{flex:0 0 78%;scroll-snap-align:start;padding:12px;border-radius:22px;background:#E9E3D8}
.shots .chat-shot .cs-bubble{max-width:none}
.shots figcaption b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--teal);color:#fff;font-size:.72rem}
.sec .proof h3{display:none}
.sec .official{margin-top:4px}

a:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
</style></head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="i-check-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></symbol><symbol id="i-shield-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></symbol><symbol id="i-user-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></symbol></defs></svg>
<div class="w">
<a class="top" href="/"><span class="mk${mark ? ' img' : ''}">${mark ? `<img src="${esc(mark)}" alt="">` : '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8.5" r="3.7" fill="#C9992E"/><path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'}</span><b>Hoolam</b></a>
<main class="card">
  ${l.photo && name ? `<div class="ph"><img src="${esc(l.photo)}" alt="${esc(name)}, a Hoolam ambassador" width="800" height="800">${badge}</div>`
    : `<div class="cov" aria-hidden="true"></div><div class="av">${l.photo ? `<img src="${esc(l.photo)}" alt="">` : esc((name ?? 'H')[0].toUpperCase())}</div>`}
  <div class="in">
    <h1>${name ? `${esc(name)} invited you to Hoolam` : 'Buy and sell safely on WhatsApp'}</h1>
    ${l.photo && name ? '' : badge}
    <p class="lead">Buy and sell on WhatsApp safely. Your money is held until you get what you ordered.</p>
    <div class="btns">
      <a class="b buy" data-wa href="${esc(go('buy'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>I’m buying</a>
      <a class="b sell" data-wa href="${esc(go('sell'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>I’m selling</a>
    </div>
  </div>
</main>
<section class="sec" aria-labelledby="how-h">
  <h2 id="how-h">How it works, in WhatsApp</h2>
  <p>These are the real messages you get. Swipe to see each step.</p>
  <div class="shots">
    ${shot(1, 'held', 'You pay Hoolam. The money is held')}
    ${shot(2, 'handover', 'You see the item, then give the code')}
    ${shot(3, 'paid', 'Only then is the seller paid')}
  </div>
</section>
<section class="sec">
  <div class="proof" data-proof hidden>
    <h2>Real orders, counted live</h2>
    <ul class="proof-row">
      <li data-n="completed" hidden><b data-v></b><span>orders completed safely</span></li>
      <li data-n="refunded" hidden><b data-v></b><span>buyers refunded in full</span></li>
      <li data-n="started" hidden><b data-v></b><span>orders started on Hoolam</span></li>
    </ul>
    <p class="proof-note"><span class="dot" aria-hidden="true"></span>Counted from real Hoolam orders. Test orders never count.</p>
  </div>
</section>
${wa ? `<section class="sec" aria-labelledby="real-h"><h2 id="real-h">Make sure it’s the real Hoolam</h2>{{OFFICIAL}}</section>` : ''}
<p class="foot">No app to download. Everything happens in WhatsApp.<br>${COMPANY.legalName} · RC ${COMPANY.rc} · <a href="/">hoolam.com</a></p>
</div>
<script>(function(){try{navigator.sendBeacon&&navigator.sendBeacon(${JSON.stringify(`${app}/a/${l.slug}/tap`)})}catch(e){}})();</script>
</body></html>
`;
}

// ---------- Google Analytics (with consent) ----------
// On the live pages only (never the /v/ previews or the draft). Every consent starts "denied": until a visitor taps Accept
// on the banner (site/assets/analytics.js), Google gets only cookieless pings. GA_MEASUREMENT_ID can override the ID; GA_OFF=1 turns it off.
const GA_ID = (process.env.GA_MEASUREMENT_ID ?? 'G-J2YB5ZF1NE').trim();
if (GA_ID && /^G-[A-Z0-9]+$/.test(GA_ID) && process.env.GA_OFF !== '1') {
  const analyticsVer = createHash('sha256').update(read('assets/analytics.js')).digest('hex').slice(0, 10);
  const head = `<!-- Google tag (gtag.js), with consent mode: no analytics cookies until the visitor accepts -->
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:/(?:^|;\\s*)hoolam_consent=yes/.test(document.cookie)?'granted':'denied'});
gtag('js',new Date());gtag('config','${GA_ID}',{content_group:'Website'});</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
`;
  const tail = `<script src="/assets/analytics.js?v=${analyticsVer}" defer></script>\n`;
  const live = ['index.html', '404.html', join('about', 'index.html'), join('contact', 'index.html'), join('legal', 'index.html'), ...LEGAL_PAGES.map((p) => join('legal', p.slug, 'index.html')),
    ...(amb ? [join('ambassadors', 'index.html'), ...ambLinks.filter((l) => !l.to).map((l) => join('a', l.slug, 'index.html'))] : [])];
  for (const f of live) {
    const file = join(out, f);
    const html = readFileSync(file, 'utf8');
    if (html.includes('googletagmanager.com/gtag/js')) continue;
    writeFileSync(file, html.replace('</head>', `${head}</head>`).replace('</body>', `${tail}</body>`));
  }
}

// ---------- where people come from: "(ref: …)" on every WhatsApp button (site/assets/wa-ref.js) ----------
{
  const refVer = createHash('sha256').update(read('assets/wa-ref.js')).digest('hex').slice(0, 10);
  const pagesWithWa = ['index.html', '404.html', join('about', 'index.html'), join('contact', 'index.html'), join('legal', 'index.html'), ...LEGAL_PAGES.map((p) => join('legal', p.slug, 'index.html')),
    ...(amb ? [join('ambassadors', 'index.html')] : []), ...pages.map((p) => join(p.replace(/^\/|\/$/g, ''), 'index.html'))];
  for (const f of new Set(pagesWithWa)) {
    const file = join(out, f);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    if (html.includes('/assets/wa-ref.js')) continue;
    writeFileSync(file, html.replace('</body>', `<script src="/assets/wa-ref.js?v=${refVer}" defer></script>\n</body>`));
  }
}

const n = Object.keys(baked.images ?? {}).length;
console.log(`Site built → dist-site/  (${pages.length} pages, home page ${liveVersion} live, ${VERSIONS.length} versions + draft to preview; server: ${app}${live ? `, settings copied, ${n} image${n === 1 ? '' : 's'}, ${linksBuilt} campaign link${linksBuilt === 1 ? '' : 's'}${amb ? `, ambassadors on (${ambBuilt} link${ambBuilt === 1 ? '' : 's'})` : ''}` : ', server not reached: using the built-in numbers'}${site ? `, site: ${site}` : ''})`);
