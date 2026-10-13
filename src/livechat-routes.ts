import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { bus, type ChatEvent } from './events.js';
import { CHAT_MAX_FILE, ChatError, firstName, type LiveChat } from './livechat.js';
import { openStream } from './sse.js';

/**
 * The website chat's API (hoolam.com talks to this server). Visitors prove who they are with the key the server gave
 * them (header x-chat-key, or ?key= for the live connection and files). No cookies, so any page can call it.
 */
export function registerLiveChatRoutes(app: FastifyInstance, chat: LiveChat, db: Db, log: (l: string) => void) {
  const cors = (reply: FastifyReply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'content-type, x-chat-key, x-file-name')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-max-age', '600');
  const keyOf = (req: FastifyRequest) => (req.headers['x-chat-key'] as string | undefined) ?? (req.query as { key?: string }).key ?? null;
  const visitor = async (req: FastifyRequest) => {
    const v = await chat.visitorFor(keyOf(req));
    if (!v) throw new ChatError('Your chat has expired. Please start a new one.', 401);
    return v;
  };
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id) || 0;

  app.register(async (r) => {
    r.addHook('onSend', async (_req, reply, payload) => { cors(reply); return payload; });
    r.setErrorHandler((err, _req, reply) => {
      cors(reply);
      if (err instanceof ChatError) return reply.code(err.status).send({ error: err.message });
      const e = err as Error & { statusCode?: number };
      if (e.statusCode === 413) return reply.code(413).send({ error: 'Files can be up to 10 MB.' });
      if (e.statusCode === 415) return reply.code(415).send({ error: 'Send a photo (JPG, PNG or WebP) or a PDF.' });
      log(`live chat error: ${e.stack ?? e.message}`);
      return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: 'Something went wrong. Please try again.' });
    });
    r.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHAT_MAX_FILE + 1024 }, (_req, body, done) => done(null, body));
    r.options('/*', async (_req, reply) => cors(reply).code(204).send());

    r.get('/config', async (_req, reply) => { reply.header('cache-control', 'public, max-age=60'); return chat.contentForVisitors(); });

    r.post('/start', async (req) => {
      const b = req.body as { name?: string; phone?: string; text?: string; page?: string };
      return chat.start({ key: keyOf(req), name: b.name ?? '', phone: b.phone ?? '', text: b.text ?? '', page: b.page ?? null, ip: req.ip ?? null });
    });
    r.post('/resume', async (req) => chat.resume(String((req.body as { code?: string }).code ?? '')));

    r.get('/me', async (req) => {
      const v = await visitor(req);
      return { visitor: { name: v.name, phone: v.phone.replace(/^\+234/, '0') }, threads: await chat.visitorThreads(v.id) };
    });
    r.get('/threads/:id', async (req) => chat.visitorThread((await visitor(req)).id, idOf(req)));
    r.post('/threads/:id/messages', async (req) => { await chat.visitorSend((await visitor(req)).id, idOf(req), String((req.body as { text?: string }).text ?? '')); return { ok: true }; });
    r.post('/threads/:id/files', { bodyLimit: CHAT_MAX_FILE + 1024 }, async (req) => {
      const v = await visitor(req);
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
      await chat.visitorFile(v.id, idOf(req), name, req.body as Buffer);
      return { ok: true };
    });
    r.post('/threads/:id/seen', async (req) => { await chat.visitorSeen((await visitor(req)).id, idOf(req), Number((req.body as { upTo?: number }).upTo) || 0); return { ok: true }; });
    r.post('/threads/:id/typing', async (req) => { await chat.visitorTyping((await visitor(req)).id, idOf(req)); return { ok: true }; });
    r.post('/threads/:id/close', async (req) => { await chat.visitorClose((await visitor(req)).id, idOf(req)); return { ok: true }; });
    r.post('/threads/:id/rate', async (req) => { await chat.rateThread((await visitor(req)).id, idOf(req), (req.body as { rating: 'UP' | 'DOWN' }).rating); return { ok: true }; });

    r.get('/files/:id', async (req, reply) => {
      const v = await visitor(req);
      const f = await chat.file(idOf(req), { visitorId: v.id });
      return reply.type(f.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=86400')
        .header('content-disposition', `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.name.replace(/"/g, '')}"`).send(f.bytes);
    });

    // live updates for this visitor's chats: rep replies, typing, "seen", closed / reopened
    r.get('/events', async (req, reply) => {
      const v = await visitor(req);
      const owner = new Map<number, number>();
      const mine = async (threadId: number) => {
        if (!owner.has(threadId)) owner.set(threadId, Number((await db.query('SELECT visitor_id FROM chat_threads WHERE id=$1', [threadId])).rows[0]?.visitor_id ?? 0));
        return owner.get(threadId) === v.id;
      };
      const s = openStream(req, reply, { 'access-control-allow-origin': '*' });
      chat.online.set(v.id, (chat.online.get(v.id) ?? 0) + 1);
      const on = (e: ChatEvent) => {
        void mine(e.threadId).then((yes) => {
          if (!yes) return;
          if (e.type === 'message') {
            const m = e.message as { kind: string; by: string | null; staffId?: string };
            if (m.kind === 'NOTE') return;
            const { staffId: _s, ...rest } = m;
            s.send('message', { threadId: e.threadId, message: { ...rest, by: m.by ? firstName(m.by) : null } });
          } else if (e.type === 'typing' && e.who === 'staff') s.send('typing', { threadId: e.threadId, name: e.name ?? null });
          else if (e.type === 'seen' && e.by === 'staff') s.send('seen', { threadId: e.threadId, upTo: e.upTo });
          else if (e.type === 'thread') s.send('thread', { threadId: e.threadId });
        }).catch(() => {});
      };
      bus.on('chat', on);
      s.onClose(() => {
        bus.off('chat', on);
        const n = (chat.online.get(v.id) ?? 1) - 1;
        if (n > 0) chat.online.set(v.id, n); else chat.online.delete(v.id);
      });
      s.send('ready', { ok: true });
    });
  }, { prefix: '/livechat' });
}
