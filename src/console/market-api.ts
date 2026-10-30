import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CATEGORIES } from '../deals/categories.js';
import type { Listing, Market } from '../market/market.js';

/**
 * Console → Market (main menu).
 *   Seeing (everyone): the numbers, new listings, reports, sellers, upgrades, all listings.
 *   Reviewing (market.review: Owner, Admin): keep or remove an item, approve or decline a seller.
 *   Managing (market.manage: Owner): a seller's own item limit, stop or allow a seller, confirm a paid upgrade, ad links.
 * Every change goes in the audit trail, and the seller hears about it in WhatsApp (with the item's picture).
 */
export interface MarketConsoleHelpers {
  m: Market;
  need: (req: FastifyRequest, action: string) => void;
  can: (req: FastifyRequest, action: string) => boolean;
  act: <T>(req: FastifyRequest, e: { action: string; targetType: string; targetId: string; reason?: string | null; details?: Record<string, unknown> }, fn: () => Promise<T>) => Promise<T>;
  reasonOf: (body: unknown, min?: number) => string;
  fail: (status: number, message: string) => Error;
  /** WhatsApp messages to the seller. */
  tell: {
    removed(l: Listing, reason: string, stopped: boolean): Promise<unknown>;
    decided(userId: string, ok: boolean, reason: string | null): Promise<unknown>;
    upgraded(userId: string, ok: boolean, items: number): Promise<unknown>;
    allowed(userId: string): Promise<unknown>;
  };
  /** go.hoolam.com/i/<code> and the WhatsApp link an ad opens. */
  itemUrl: (code: string) => string;
  adUrl: (code: string, ad: string) => string;
  unit: number;
}

export function registerMarketConsole(api: FastifyInstance, h: MarketConsoleHelpers) {
  const { m } = h;
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);
  const userOf = (req: FastifyRequest) => String((req.params as { userId: string }).userId);
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.title]));

  api.get('/market', async (req) => {
    const cfg = m.cfg();
    return {
      on: cfg.on, approval: cfg.approval, perSeller: cfg.perSeller, upgrade: cfg.upgrade, reportsHide: cfg.reportsHide, strikes: cfg.strikes, adLinks: cfg.adLinks,
      categories: cats, overview: await m.overview(),
      canReview: h.can(req, 'market.review'), canManage: h.can(req, 'market.manage'),
    };
  });

  // ----- the regular check: new listings (newest first), reported ones on top -----
  api.get('/market/check', async () => ({ rows: (await m.toCheck(120)).map((r) => ({ ...r, url: h.itemUrl(r.code) })), categories: cats }));
  api.post('/market/listings/:id/keep', async (req) => {
    h.need(req, 'market.review');
    const id = idOf(req);
    const l = await h.act(req, { action: 'market.keep', targetType: 'market_listing', targetId: String(id) }, () => m.keep(id, req.staff!.id));
    if (!l) throw h.fail(404, 'That item is gone.');
    return { ok: true };
  });
  /** Keep everything on the page in one go (what the team has looked at). */
  api.post('/market/keep-all', async (req) => {
    h.need(req, 'market.review');
    const ids = ((req.body as { ids?: number[] })?.ids ?? []).map(Number).filter(Number.isInteger).slice(0, 200);
    await h.act(req, { action: 'market.keep_all', targetType: 'market_listing', targetId: ids.join(','), details: { count: ids.length } }, async () => { for (const id of ids) await m.keep(id, req.staff!.id); });
    return { ok: true, kept: ids.length };
  });
  api.post('/market/listings/:id/remove', async (req) => {
    h.need(req, 'market.review');
    const id = idOf(req);
    const reason = h.reasonOf(req.body);
    const r = await h.act(req, { action: 'market.remove', targetType: 'market_listing', targetId: String(id), reason }, () => m.remove(id, reason, req.staff!.id));
    if (!r) throw h.fail(404, 'That item was already removed.');
    await h.tell.removed(r.listing, reason, r.stopped).catch(() => {});
    return { ok: true, stopped: r.stopped };
  });

  // ----- all listings -----
  api.get('/market/listings', async (req) => {
    const q = req.query as { q?: string; status?: string };
    const status = ['LIVE', 'PAUSED', 'HIDDEN', 'SOLD_OUT', 'EXPIRED', 'REMOVED'].includes(String(q.status)) ? String(q.status) : undefined;
    return { rows: (await m.listings({ q: q.q?.trim().slice(0, 80) || undefined, status })).map((r) => ({ ...r, url: h.itemUrl(r.code) })), categories: cats };
  });
  api.get('/market/photo/:id/:pos', async (req, reply) => {
    const p = req.params as { id: string; pos: string };
    const b = await m.photo(Number(p.id), Number(p.pos) || 0);
    if (!b) throw h.fail(404, 'No photo');
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(b);
  });

  // ----- sellers: applications, stopped sellers, limits, upgrades -----
  api.get('/market/sellers', async () => ({ applications: await m.applications(), upgrades: await m.upgrades(), sellers: await m.sellers() }));
  api.post('/market/sellers/:userId/decide', async (req) => {
    h.need(req, 'market.review');
    const userId = userOf(req);
    const ok = (req.body as { ok?: boolean })?.ok === true;
    const reason = ok ? null : h.reasonOf(req.body);
    await h.act(req, { action: ok ? 'market.seller_approve' : 'market.seller_decline', targetType: 'user', targetId: userId, reason }, () => m.decide(userId, ok, reason, req.staff!.id));
    await h.tell.decided(userId, ok, reason).catch(() => {});
    return { ok: true };
  });
  api.post('/market/sellers/:userId/stop', async (req) => {
    h.need(req, 'market.manage');
    const userId = userOf(req);
    const stop = (req.body as { stop?: boolean })?.stop !== false;
    const reason = h.reasonOf(req.body);
    await h.act(req, { action: stop ? 'market.seller_stop' : 'market.seller_allow', targetType: 'user', targetId: userId, reason }, () => m.setStopped(userId, stop, reason, req.staff!.id));
    if (!stop) await h.tell.allowed(userId).catch(() => {});
    return { ok: true };
  });
  api.post('/market/sellers/:userId/limit', async (req) => {
    h.need(req, 'market.manage');
    const userId = userOf(req);
    const b = (req.body ?? {}) as { limit?: number | null; days?: number | null };
    const limit = b.limit == null || (b.limit as unknown) === '' ? null : Number(b.limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) throw h.fail(400, 'Use a whole number from 1.');
    const until = b.days ? new Date(Date.now() + Number(b.days) * 86_400_000) : null;
    const reason = h.reasonOf(req.body);
    await h.act(req, { action: 'market.seller_limit', targetType: 'user', targetId: userId, reason, details: { limit, until } }, () => m.setLimit(userId, limit, until, req.staff!.id));
    return { ok: true };
  });
  api.post('/market/upgrades/:id', async (req) => {
    h.need(req, 'market.manage');
    const id = idOf(req);
    const b = (req.body ?? {}) as { ok?: boolean; reference?: string };
    const ok = b.ok === true;
    const reference = String(b.reference ?? '').trim().slice(0, 80) || null;
    if (ok && !reference) throw h.fail(400, 'Add the payment reference, so it can be found later.');
    const reason = ok ? null : h.reasonOf(req.body);
    const r = await h.act(req, { action: ok ? 'market.upgrade_done' : 'market.upgrade_decline', targetType: 'market_upgrade', targetId: String(id), reason, details: { reference } }, () => m.doneUpgrade(id, ok, reference, req.staff!.id));
    if (!r) throw h.fail(409, 'Someone already answered this one.');
    await h.tell.upgraded(r.userId, ok, r.items).catch(() => {});
    return { ok: true };
  });

  // ----- ad links (Features → Market → Ads that open WhatsApp on an item) -----
  api.get('/market/ads', async () => ({ rows: (await m.adLinks()).map((a) => ({ ...a, url: h.adUrl(a.code, a.name) })) }));
  api.post('/market/ads', async (req) => {
    h.need(req, 'market.manage');
    if (!m.cfg().adLinks) throw h.fail(400, 'Turn on Ads that open WhatsApp on an item first (Settings → Features → Market).');
    const b = (req.body ?? {}) as { code?: string; name?: string };
    const l = await m.get(String(b.code ?? '').trim());
    if (!l) throw h.fail(404, 'No item with that code. Copy it from the item\'s link.');
    const a = await h.act(req, { action: 'market.ad_link', targetType: 'market_listing', targetId: String(l.id), details: { name: b.name } }, () => m.adLink(l.id, String(b.name ?? 'ad')));
    return { ok: true, url: h.adUrl(l.code, a.name), name: a.name };
  });
}
