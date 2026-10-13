import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A live connection the server writes events into (Server-Sent Events). Used by the website chat and the console's
 * support widget. A heartbeat every 25 seconds keeps proxies from closing it; the browser reconnects by itself.
 */
export function openStream(req: FastifyRequest, reply: FastifyReply, headers: Record<string, string> = {}) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers,
  });
  res.write('retry: 3000\n\n');
  let open = true;
  const closers: (() => void)[] = [];
  const close = () => { if (!open) return; open = false; clearInterval(beat); for (const c of closers) { try { c(); } catch { /* ignore */ } } };
  const beat = setInterval(() => { if (open) res.write(': beat\n\n'); }, 25_000);
  req.raw.on('close', close);
  res.on('error', close);
  return {
    send(event: string, data: unknown) {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn: () => void) { closers.push(fn); },
    get open() { return open; },
  };
}
