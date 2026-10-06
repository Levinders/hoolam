import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Serves the built console (dist-console/) at /console. Unknown paths get index.html so links like /console/deals/HL-ABC work. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-console');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webp': 'image/webp',
};
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

export function registerConsoleStatic(app: FastifyInstance, log: (l: string) => void) {
  const index = join(ROOT, 'index.html');
  if (!existsSync(index)) {
    log('console screens not built (run npm run build:console). The console API still works.');
    app.get('/console', async (_req, reply) => reply.type('text/plain').send('The console has not been built. Run: npm run build'));
    return;
  }
  const indexHtml = readFileSync(index);
  const serve = async (path: string, reply: import('fastify').FastifyReply) => {
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, safe);
    if (file.startsWith(ROOT) && safe && existsSync(file) && statSync(file).isFile()) {
      const long = safe.startsWith('assets/');
      return reply.headers(SECURITY_HEADERS).type(TYPES[extname(file)] ?? 'application/octet-stream')
        .header('cache-control', long ? 'public, max-age=31536000, immutable' : 'no-cache').send(readFileSync(file));
    }
    return reply.headers(SECURITY_HEADERS).type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(indexHtml);
  };
  app.get('/console', async (_req, reply) => reply.redirect('/console/'));
  app.get('/console/', async (_req, reply) => serve('index.html', reply));
  app.get('/console/*', async (req, reply) => {
    const rest = (req.params as { '*': string })['*'];
    if (rest.startsWith('api/')) return reply.code(404).send({ error: 'Not found' });
    return serve(rest, reply);
  });
}
