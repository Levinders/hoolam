import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { AmbassadorError, deviceName, monthKey, type Ambassadors } from './ambassadors.js';
import { ambassadorCard } from './amb-image.js';
import { ambassadorPage } from './amb-page.js';
import { isBot } from './trust.js';

/**
 * The ambassador programme on the web:
 *   POST /ambassadors/apply          the website's application form (hoolam.com/ambassadors)
 *   GET  /a/:slug/photo.jpg          an ambassador's photo (their link's preview picture)
 *   POST /a/:slug/tap                their link's page on the website counts the tap
 *   GET  /ambassador                 their private dashboard (signs in with a code sent to their WhatsApp)
 *   /ambassador/api/…                what the dashboard reads and does
 * The dashboard's cookie only works on /ambassador, is HttpOnly and SameSite=Lax; every change also needs the
 * x-hoolam header (which other sites can't send), so a page elsewhere can't act for them.
 */
const COOKIE = 'hoolam_amb';
const DAYS = 30;

export function registerAmbassadorRoutes(app: FastifyInstance, o: { ambassadors: Ambassadors; markUrl: () => string | null; waNumber: () => string; secure: boolean; log: (l: string) => void }) {
  const a = o.ambassadors;
  const cors = (r: FastifyReply) => r.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'content-type').header('access-control-allow-methods', 'POST, OPTIONS');

  // ---------- applying on the website ----------
  // a few tries per address an hour, so the form can't be flooded
  const tries = new Map<string, { n: number; at: number }>();
  const limited = (ip: string) => {
    const now = Date.now(), t = tries.get(ip);
    if (!t || now - t.at > 3600_000) { tries.set(ip, { n: 1, at: now }); return false; }
    t.n++;
    if (tries.size > 5000) tries.clear();
    return t.n > 30; // generous: many people share one mobile network address
  };
  app.options('/ambassadors/apply', async (_req, reply) => cors(reply).code(204).send());
  app.post('/ambassadors/apply', async (req, reply) => {
    cors(reply);
    const cfg = a.cfg();
    if (!cfg.on || !cfg.applyWeb) return reply.code(403).send({ error: 'Applications are closed for now.' });
    if (limited(req.ip)) return reply.code(429).send({ error: 'Too many tries. Please wait a while and try again.' });
    const b = parseBody(req.body);
    if (b.website) return reply.send({ ok: true }); // the hidden field only robots fill in
    if (!b.agree) return reply.code(400).send({ error: 'Please tick that you agree to the Ambassador agreement.' });
    try {
      const r = await a.apply({
        fullName: b.name, phone: b.phone, email: b.email || null, state: b.state, city: b.city, community: b.community || null,
        knows: arr(b.knows), channels: arr(b.channels), handle: b.handle || null, reach: b.reach, sellsOnline: b.sells === 'yes' ? true : b.sells === 'no' ? false : null, why: b.why || null,
      }, 'website');
      return reply.send({ ok: true, already: r.already });
    } catch (e) {
      if (e instanceof AmbassadorError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // ---------- an ambassador's link ----------
  app.get('/a/:slug/photo.jpg', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const p = await a.photo({ slug: slug.toLowerCase() });
    if (!p) return reply.code(404).type('text/plain').send('No photo');
    const v = (req.query as { v?: string }).v;
    return reply.type('image/jpeg').header('x-content-type-options', 'nosniff').header('access-control-allow-origin', '*')
      .header('cache-control', v === p.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300').send(p.bytes);
  });
  app.options('/a/:slug/tap', async (_req, reply) => cors(reply).code(204).send());
  app.post('/a/:slug/tap', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (/^[a-z0-9-]{2,40}$/.test(slug) && !isBot(req.headers['user-agent'])) await a.tap(slug).catch((e) => o.log(`ambassador tap: ${(e as Error).message}`));
    return cors(reply).code(204).send();
  });

  // ---------- the dashboard ----------
  const cookieOf = (req: FastifyRequest) => {
    const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]!) : undefined;
  };
  const setCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/ambassador; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${o.secure ? '; Secure' : ''}`);
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex, nofollow');
  /** The signed-in ambassador, or a 401. Changes also need the x-hoolam header. */
  const who = async (req: FastifyRequest, reply: FastifyReply, change = false): Promise<string | null> => {
    if (change && req.headers['x-hoolam'] !== '1') { reply.code(403).send({ error: 'Not allowed' }); return null; }
    const id = await a.session(cookieOf(req));
    if (!id) { reply.code(401).send({ error: 'Please sign in again.' }); return null; }
    return id;
  };

  app.get('/ambassador', async (_req, reply) => noStore(reply).type('text/html')
    .header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    .send(ambassadorPage({ markUrl: o.markUrl(), waNumber: o.waNumber() })));
  app.get('/ambassador/', async (req, reply) => reply.redirect(`/ambassador${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`));

  app.post('/ambassador/api/code', async (req, reply) => {
    noStore(reply);
    if (req.headers['x-hoolam'] !== '1') return reply.code(403).send({ error: 'Not allowed' });
    if (limited(`code:${req.ip}`)) return reply.code(429).send({ error: 'Too many tries. Please wait a while and try again.' });
    const r = await a.sendCode(String(parseBody(req.body).phone ?? ''));
    if (r === 'wait') return reply.code(429).send({ error: 'We just sent a code. Please wait a minute before asking for another.' });
    // the same answer whether or not the number is an ambassador's, so numbers can't be checked here
    if (r === 'not-delivered') return reply.code(409).send({ error: 'We couldn\'t send the code to your WhatsApp. Send "hi" to Hoolam on WhatsApp first, then try again.', needsHi: true });
    return reply.send({ ok: true });
  });
  app.post('/ambassador/api/verify', async (req, reply) => {
    noStore(reply);
    if (req.headers['x-hoolam'] !== '1') return reply.code(403).send({ error: 'Not allowed' });
    const b = parseBody(req.body);
    const r = await a.verifyCode(String(b.phone ?? ''), String(b.code ?? ''), deviceName(String(req.headers['user-agent'] ?? '')));
    if (r === 'wrong') return reply.code(400).send({ error: 'That code isn\'t right. Check it and try again.' });
    if (r === 'expired') return reply.code(400).send({ error: 'That code has expired. Ask for a new one.' });
    if (r === 'locked') return reply.code(400).send({ error: 'Too many wrong tries. Ask for a new code.' });
    setCookie(reply, r.token, DAYS * 86400);
    return reply.send({ ok: true });
  });
  app.post('/ambassador/api/signout', async (req, reply) => {
    noStore(reply);
    const t = cookieOf(req);
    if (t) await a.signOut(t);
    setCookie(reply, '', 0);
    return reply.send({ ok: true });
  });
  app.post('/ambassador/api/signout-all', async (req, reply) => {
    noStore(reply);
    const id = await who(req, reply, true); if (!id) return;
    await a.signOutAll(id);
    setCookie(reply, '', 0);
    return reply.send({ ok: true });
  });
  app.get('/ambassador/api/me', async (req, reply) => {
    noStore(reply);
    const id = await who(req, reply); if (!id) return;
    const m = String((req.query as { m?: string }).m ?? '');
    const ov = await a.overview(id, /^\d{4}-\d{2}$/.test(m) ? m : monthKey());
    if (!ov) return reply.code(401).send({ error: 'Please sign in again.' });
    const { phone: _p, userId: _u, ...rest } = ov;
    const cfg = a.cfg();
    return reply.send({ ...rest, payoutDay: cfg.payoutDay, noticeDays: cfg.noticeDays, defaults: { seller: cfg.sellerPct, buyer: cfg.buyerPct }, share: shareText(ov.link), shares: shareTexts(ov.link) });
  });
  app.post('/ambassador/api/term', async (req, reply) => {
    noStore(reply);
    const id = await who(req, reply, true); if (!id) return;
    const b = parseBody(req.body);
    try {
      if (b.action === 'switch') await a.setTerm(id, Number(b.months));
      else if (b.action === 'renew') await a.renew(id);
      else if (b.action === 'end') await a.end(id, 'Ended by the ambassador');
      else return reply.code(400).send({ error: 'Unknown action' });
    } catch (e) { if (e instanceof AmbassadorError) return reply.code(400).send({ error: e.message }); throw e; }
    return reply.send({ ok: true });
  });
  app.addContentTypeParser(/^image\/(jpeg|png|webp|heic|heif)$/, { parseAs: 'buffer', bodyLimit: 8_000_000 }, (_req, body, done) => done(null, body));
  app.post('/ambassador/api/photo', async (req, reply) => {
    noStore(reply);
    const id = await who(req, reply, true); if (!id) return;
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'Choose a photo first.' });
    try { await a.setPhoto(id, req.body); }
    catch (e) { if (e instanceof AmbassadorError) return reply.code(400).send({ error: e.message }); throw e; }
    return reply.send({ ok: true });
  });
  app.delete('/ambassador/api/photo', async (req, reply) => {
    noStore(reply);
    const id = await who(req, reply, true); if (!id) return;
    await a.removePhoto(id, false);
    return reply.send({ ok: true });
  });
  app.get('/ambassador/api/qr.png', async (req, reply) => {
    const id = await who(req, reply); if (!id) return;
    const amb = await a.get(id);
    if (!amb?.slug) return reply.code(404).send({ error: 'No link yet' });
    const png = await QRCode.toBuffer(a.linkUrl(amb.slug), { width: 900, margin: 2, color: { dark: '#0E5C63', light: '#FFFFFF' } });
    return reply.type('image/png').header('content-disposition', `attachment; filename="hoolam-${amb.slug}-qr.png"`).header('cache-control', 'private, no-store').send(png);
  });
  app.get('/ambassador/api/card.jpg', async (req, reply) => {
    const id = await who(req, reply); if (!id) return;
    const ov = await a.overview(id);
    if (!ov?.slug) return reply.code(404).send({ error: 'No link yet' });
    const p = await a.photo({ userId: id });
    const img = await ambassadorCard(`${id}:${p?.version ?? '-'}:${ov.slug}:${ov.area ?? ''}`, { firstName: ov.firstName, link: ov.linkText!, area: ov.area, photo: p?.bytes ?? null });
    const download = (req.query as { download?: string }).download === '1';
    return reply.type('image/jpeg').header('cache-control', 'private, no-store')
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="hoolam-${ov.slug}.jpg"`).send(img);
  });
}

/** The message ambassadors share (the same as "Share my link" in WhatsApp). */
export const shareText = (link: string | null) => link
  ? `Buying or selling on WhatsApp? Use Hoolam 🛡️\nYour money is held safely until you get what you ordered. No more "pay first and pray".\n\nStart here 👉 ${link}` : null;

/** Three ready-made messages for the Share section: for sellers, for buyers, and a short one for a status. */
export const shareTexts = (link: string | null) => link ? [
  { label: 'For sellers', text: `Do you sell on Instagram or WhatsApp? 🛍️\nWith Hoolam your buyers pay without fear: their money is held safely and you're paid as soon as they get it. More buyers say yes.\n\nStart here 👉 ${link}` },
  { label: 'For buyers', text: `Buying from someone online? 🛡️\nPay through Hoolam. Your money is held safely until you get what you ordered. If anything is wrong, you get it back.\n\nTry it 👉 ${link}` },
  { label: 'For your status', text: `No more "pay first and pray" 🙏🏾\nBuy and sell safely on WhatsApp with Hoolam 👉 ${link}` },
] : [];

function parseBody(body: unknown): Record<string, any> {
  if (typeof body === 'string') { try { return JSON.parse(body) ?? {}; } catch { return {}; } }
  return (body && typeof body === 'object' ? body : {}) as Record<string, any>;
}
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []);
