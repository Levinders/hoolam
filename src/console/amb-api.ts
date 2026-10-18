import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AmbassadorError, AMB_CHANNELS, AMB_KNOWS, AMB_REACH, monthKey, type Ambassadors } from '../ambassadors.js';

/**
 * Console → Ambassadors (main menu) and the ambassador pieces of other pages.
 *   Reviewing (ambassadors.review: Owner, Admin, and any rep switched on in Team): applications, invite, remove a photo.
 *   Managing (ambassadors.manage: Owner): custom shares, change a link name, pause / resume / end, held earnings, payouts.
 * Seeing is open to every role. Every change goes in the audit trail.
 */
export interface AmbConsoleHelpers {
  a: Ambassadors;
  need: (req: FastifyRequest, action: string) => void;
  act: <T>(req: FastifyRequest, e: { action: string; targetType: string; targetId: string; reason?: string | null; details?: Record<string, unknown> }, fn: () => Promise<T>) => Promise<T>;
  reasonOf: (body: unknown, min?: number) => string;
  fail: (status: number, message: string) => Error;
  can: (req: FastifyRequest, action: string) => boolean;
}

export function registerAmbassadorConsole(api: FastifyInstance, h: AmbConsoleHelpers) {
  const { a } = h;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { throw e instanceof AmbassadorError ? h.fail(400, e.message) : e; }
  };
  const labels = { knows: AMB_KNOWS, channels: AMB_CHANNELS, reach: AMB_REACH };

  api.get('/ambassadors', async (req) => {
    const [stats, apps, list, held, due] = await Promise.all([a.stats(), a.applications('PENDING'), a.list(), a.held(), a.payouts('DUE')]);
    const cfg = a.cfg();
    return {
      on: cfg.on, cfg: { sellerPct: cfg.sellerPct, buyerPct: cfg.buyerPct, bonusMinor: cfg.bonusMinor, bonusOrders: cfg.bonusOrders, payoutDay: cfg.payoutDay, payoutMinMinor: cfg.payoutMinMinor },
      stats, applications: apps, ambassadors: list, held, payouts: due, labels,
      canReview: h.can(req, 'ambassadors.review'), canManage: h.can(req, 'ambassadors.manage'), month: monthKey(),
    };
  });
  api.get('/ambassadors/applications', async (req) => {
    const s = String((req.query as { status?: string }).status ?? 'PENDING').toUpperCase();
    return { rows: await a.applications((['PENDING', 'APPROVED', 'DECLINED', 'ALL'].includes(s) ? s : 'PENDING') as 'PENDING'), labels };
  });
  api.post('/ambassadors/applications/:id/approve', async (req) => {
    h.need(req, 'ambassadors.review');
    const id = Number((req.params as { id: string }).id);
    const note = String((req.body as { note?: string })?.note ?? '').trim() || null;
    const r = await wrap(() => h.act(req, { action: 'ambassador.approve', targetType: 'ambassador_application', targetId: String(id), reason: note }, () => a.approve(id, req.staff!.id, note)));
    return { ok: true, userId: r.userId };
  });
  api.post('/ambassadors/applications/:id/decline', async (req) => {
    h.need(req, 'ambassadors.review');
    const id = Number((req.params as { id: string }).id);
    const reason = h.reasonOf(req.body);
    await wrap(() => h.act(req, { action: 'ambassador.decline', targetType: 'ambassador_application', targetId: String(id), reason }, () => a.decline(id, req.staff!.id, reason)));
    return { ok: true };
  });
  api.post('/ambassadors/invite', async (req) => {
    h.need(req, 'ambassadors.review');
    const b = (req.body ?? {}) as { phone?: string; name?: string; city?: string };
    const r = await wrap(() => h.act(req, { action: 'ambassador.invite', targetType: 'ambassador', targetId: String(b.phone ?? ''), details: { name: b.name ?? null } },
      () => a.invite({ phone: String(b.phone ?? ''), name: String(b.name ?? ''), city: b.city ?? null }, req.staff!.id)));
    return { ok: true, userId: r.userId };
  });

  api.get('/ambassadors/payouts', async (req) => {
    const s = String((req.query as { status?: string }).status ?? 'DUE').toUpperCase();
    return { rows: await a.payouts((['DUE', 'PAID', 'ALL'].includes(s) ? s : 'DUE') as 'DUE') };
  });
  api.post('/ambassadors/payouts/:id/paid', async (req) => {
    h.need(req, 'ambassadors.manage');
    const id = (req.params as { id: string }).id;
    const ref = String((req.body as { reference?: string })?.reference ?? '').trim();
    await wrap(() => h.act(req, { action: 'ambassador.payout.paid', targetType: 'ambassador_payout', targetId: id, details: { reference: ref } }, () => a.markPaid(id, ref, req.staff!.id)));
    return { ok: true };
  });
  api.post('/ambassadors/payouts/run', async (req) => {
    h.need(req, 'ambassadors.manage');
    const m = String((req.body as { month?: string })?.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(m)) throw h.fail(400, 'Pick a month');
    const made = await h.act(req, { action: 'ambassador.payout.run', targetType: 'ambassador_payout', targetId: m }, () => a.payoutRun(m));
    return { ok: true, made };
  });
  api.post('/ambassadors/earnings/:id/:decision', async (req) => {
    h.need(req, 'ambassadors.manage');
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== 'approve' && decision !== 'void') throw h.fail(404, 'Not found');
    const reason = h.reasonOf(req.body);
    await wrap(() => h.act(req, { action: `ambassador.earning.${decision}`, targetType: 'ambassador_earning', targetId: id, reason }, () => a.decideHold(Number(id), decision === 'approve', req.staff!.id)));
    return { ok: true };
  });

  api.get('/ambassadors/:userId', async (req) => {
    const { userId } = req.params as { userId: string };
    const m = String((req.query as { m?: string }).m ?? '');
    const o = await a.overview(userId, /^\d{4}-\d{2}$/.test(m) ? m : monthKey());
    if (!o) throw h.fail(404, 'Not an ambassador');
    const app = (await a.db.query(
      `SELECT x.* FROM ambassador_applications x JOIN ambassadors y ON y.application_id=x.id WHERE y.user_id=$1`, [userId])).rows[0] ?? null;
    const held = (await a.held()).filter((x) => x.userId === userId);
    const trail = (await a.db.query(`SELECT action, actor, reason, details, at FROM audit_log WHERE target_id=$1 AND action LIKE 'ambassador.%' ORDER BY id DESC LIMIT 30`, [userId])).rows;
    return {
      ...o, held, trail, labels, canReview: h.can(req, 'ambassadors.review'), canManage: h.can(req, 'ambassadors.manage'),
      application: app ? { id: Number(app.id), source: app.source, state: app.state, city: app.city, community: app.community, knows: app.knows, channels: app.channels, handle: app.handle, reach: app.reach, sellsOnline: app.sells_online, why: app.why, email: app.email, createdAt: app.created_at } : null,
    };
  });
  api.get('/ambassadors/:userId/photo', async (req, reply) => {
    const p = await a.photo({ userId: (req.params as { userId: string }).userId });
    if (!p) throw h.fail(404, 'No photo');
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=60').send(p.bytes);
  });
  api.delete('/ambassadors/:userId/photo', async (req) => {
    h.need(req, 'ambassadors.review');
    const { userId } = req.params as { userId: string };
    const reason = h.reasonOf(req.body);
    await h.act(req, { action: 'ambassador.photo.remove', targetType: 'ambassador', targetId: userId, reason }, () => a.removePhoto(userId, true));
    return { ok: true };
  });
  api.post('/ambassadors/:userId/share', async (req) => {
    h.need(req, 'ambassadors.manage');
    const { userId } = req.params as { userId: string };
    const b = (req.body ?? {}) as { seller?: number | null | ''; buyer?: number | null | '' };
    const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
    const reason = h.reasonOf(req.body);
    await wrap(() => h.act(req, { action: 'ambassador.share', targetType: 'ambassador', targetId: userId, reason, details: { seller: num(b.seller), buyer: num(b.buyer) } },
      () => a.setCustomPct(userId, num(b.seller), num(b.buyer))));
    return { ok: true };
  });
  api.post('/ambassadors/:userId/name', async (req) => {
    h.need(req, 'ambassadors.manage');
    const { userId } = req.params as { userId: string };
    const name = String((req.body as { name?: string })?.name ?? '');
    const reason = h.reasonOf(req.body);
    const slug = await wrap(() => h.act(req, { action: 'ambassador.name', targetType: 'ambassador', targetId: userId, reason, details: { name } }, () => a.claimName(userId, name)));
    return { ok: true, slug };
  });
  api.post('/ambassadors/:userId/:what', async (req) => {
    h.need(req, 'ambassadors.manage');
    const { userId, what } = req.params as { userId: string; what: string };
    if (!['pause', 'resume', 'end'].includes(what)) throw h.fail(404, 'Not found');
    const reason = what === 'resume' ? (String((req.body as { reason?: string })?.reason ?? '').trim() || null) : h.reasonOf(req.body);
    await wrap(() => h.act(req, { action: `ambassador.${what}`, targetType: 'ambassador', targetId: userId, reason },
      () => what === 'pause' ? a.pause(userId, reason!) : what === 'resume' ? a.resume(userId) : a.end(userId, reason!, req.staff!.id)));
    return { ok: true };
  });
}
