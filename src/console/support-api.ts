import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { bus, type ChatEvent, type SupportEvent } from '../events.js';
import { CHAT_MAX_FILE, ChatError, CONTENT_KINDS, type ContentKind, type LiveChat } from '../livechat.js';
import { openStream } from '../sse.js';
import { audit, type Actor } from './audit.js';
import { hasAccess, type StaffMember } from './staff.js';

type Staff = StaffMember & { sessionId: string };

/**
 * The console's support widget: live chats from the website and WhatsApp support, side by side, with live updates.
 * Live chat needs the person's live chat access; the WhatsApp counts need WhatsApp support access.
 */
export function registerSupportApi(api: FastifyInstance, d: {
  db: Db; chat: LiveChat;
  need: (req: FastifyRequest, action: string) => void;
  actorOf: (req: FastifyRequest) => Actor;
}) {
  const { db, chat, need } = d;
  const me = (req: FastifyRequest) => req.staff as Staff;
  const who = (req: FastifyRequest) => ({ id: me(req).id, name: me(req).name });
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id) || 0;
  const live = (req: FastifyRequest) => need(req, 'livechat.reply');

  api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHAT_MAX_FILE + 1024 }, (_req, body, done) => done(null, body));

  // ---- the widget's numbers: unread live chat messages (open chats that are mine or nobody's) and WhatsApp ----
  api.get('/support/counts', async (req) => chat.counts(me(req).id, hasAccess(me(req), 'live'), hasAccess(me(req), 'whatsapp')));

  // ---- live updates: new messages (both kinds), typing, "seen", who's looking ----
  api.get('/support/events', async (req, reply) => {
    const s = me(req);
    const canLive = hasAccess(s, 'live'), canWa = hasAccess(s, 'whatsapp');
    const stream = openStream(req, reply);
    const onChat = (e: ChatEvent) => {
      if (!canLive) return;
      if (e.type === 'typing' && e.staffId === s.id) return;
      stream.send('chat', e);
    };
    const onSupport = (e: SupportEvent) => { if (canWa) stream.send('whatsapp', e); };
    bus.on('chat', onChat);
    bus.on('support', onSupport);
    stream.onClose(() => { bus.off('chat', onChat); bus.off('support', onSupport); });
    stream.send('ready', { canLive, canWa });
  });

  // ---- WhatsApp support: mark a conversation read ----
  api.post('/support/:id/read', async (req) => {
    need(req, 'support.reply');
    const phone = (await db.query('SELECT phone FROM support_requests WHERE id=$1', [idOf(req)])).rows[0]?.phone;
    if (phone) await db.query(
      `INSERT INTO support_reads (staff_id, request_id) SELECT $1, id FROM support_requests WHERE phone=$2 ON CONFLICT DO NOTHING`, [me(req).id, phone]);
    return { ok: true };
  });

  // ---- live chat ----
  api.get('/livechat', async (req) => { live(req); const q = req.query as { view?: string; q?: string }; return { rows: await chat.list(me(req).id, q) }; });
  api.get('/livechat/:id', async (req) => { live(req); return chat.thread(me(req).id, idOf(req)); });
  api.post('/livechat/:id/reply', async (req) => { live(req); await chat.reply(who(req), idOf(req), String((req.body as { text?: string }).text ?? '')); return { ok: true }; });
  api.post('/livechat/:id/note', async (req) => { live(req); await chat.note(who(req), idOf(req), String((req.body as { text?: string }).text ?? '')); return { ok: true }; });
  api.post('/livechat/:id/files', { bodyLimit: CHAT_MAX_FILE + 1024 }, async (req) => {
    live(req);
    await chat.staffFile(who(req), idOf(req), decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')), req.body as Buffer);
    return { ok: true };
  });
  api.post('/livechat/:id/assign', async (req) => {
    live(req);
    const before = (await db.query('SELECT assigned_to, ref FROM chat_threads WHERE id=$1', [idOf(req)])).rows[0];
    await chat.assign(who(req), idOf(req));
    if (before?.assigned_to && before.assigned_to !== me(req).id) {
      await audit(db, d.actorOf(req), { action: 'livechat.takeover', targetType: 'livechat', targetId: String(idOf(req)), details: { ref: before.ref, from: before.assigned_to } });
    }
    return { ok: true };
  });
  api.post('/livechat/:id/close', async (req) => {
    live(req);
    await chat.close(who(req), idOf(req));
    await audit(db, d.actorOf(req), { action: 'livechat.close', targetType: 'livechat', targetId: String(idOf(req)) });
    return { ok: true };
  });
  api.post('/livechat/:id/reopen', async (req) => {
    live(req);
    await chat.reopen(idOf(req), who(req));
    await audit(db, d.actorOf(req), { action: 'livechat.reopen', targetType: 'livechat', targetId: String(idOf(req)) });
    return { ok: true };
  });
  api.post('/livechat/:id/read', async (req) => { live(req); await chat.markRead(me(req).id, idOf(req), Number((req.body as { upTo?: number }).upTo) || undefined); return { ok: true }; });
  api.post('/livechat/:id/typing', async (req) => { live(req); chat.typing(who(req), idOf(req)); return { ok: true }; });
  api.post('/livechat/:id/view', async (req) => { live(req); chat.view(who(req), idOf(req), (req.body as { on?: boolean }).on !== false); return { ok: true }; });
  api.get('/livechat/files/:id', async (req, reply) => {
    live(req);
    const f = await chat.file(idOf(req), { staff: true });
    return reply.type(f.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=86400')
      .header('content-disposition', `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.name.replace(/"/g, '')}"`).send(f.bytes);
  });

  // ---- what the chat shows (Home, Questions, News, chips, saved replies, welcome) ----
  api.get('/livechat-content', async (req) => { live(req); return { rows: await chat.contentForStaff() }; });
  api.post('/livechat-content', async (req) => {
    need(req, 'livechat.content');
    const b = req.body as { id?: number; kind: ContentKind; title?: string; body?: string; url?: string | null; shortcut?: string | null; published?: boolean };
    const id = await chat.saveContent(who(req), b);
    await audit(db, d.actorOf(req), { action: b.id ? 'livechat.content.update' : 'livechat.content.create', targetType: 'livechat_content', targetId: String(id), details: { kind: b.kind, title: b.title ?? '', published: b.published ?? null } });
    return { ok: true, id };
  });
  api.post('/livechat-content/reorder', async (req) => {
    need(req, 'livechat.content');
    const b = req.body as { kind: ContentKind; ids: number[] };
    if (!CONTENT_KINDS.includes(b.kind) || !Array.isArray(b.ids)) throw new ChatError('Nothing to reorder.');
    await chat.reorderContent(b.kind, b.ids.map(Number).filter(Boolean));
    return { ok: true };
  });
  api.post('/livechat-content/:id/image', { bodyLimit: CHAT_MAX_FILE + 1024 }, async (req) => {
    need(req, 'livechat.content');
    const imageId = await chat.setContentImage(idOf(req), req.body as Buffer);
    await audit(db, d.actorOf(req), { action: 'livechat.content.image', targetType: 'livechat_content', targetId: String(idOf(req)) });
    return { ok: true, imageId };
  });
  api.delete('/livechat-content/:id/image', async (req) => {
    need(req, 'livechat.content');
    await chat.removeContentImage(idOf(req));
    return { ok: true };
  });
  api.get('/livechat-media/:id', async (req, reply) => {
    live(req);
    const m = await chat.media(idOf(req));
    return reply.type(m.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=86400').send(m.bytes);
  });
  api.delete('/livechat-content/:id', async (req) => {
    need(req, 'livechat.content');
    await chat.removeContent(idOf(req));
    await audit(db, d.actorOf(req), { action: 'livechat.content.delete', targetType: 'livechat_content', targetId: String(idOf(req)) });
    return { ok: true };
  });
}
