// Builds the landing page into dist-site/. No packages needed: Render runs `node site/build.mjs`.
// Fills in, from the environment (all optional):
//   HOOLAM_APP_URL          the Hoolam server, for live fees and the WhatsApp number (default https://hoolam.onrender.com)
//   WHATSAPP_PUBLIC_NUMBER  digits only; used until the server answers
//   SITE_URL                this site's own address, for link previews on WhatsApp (set it when the domain is connected)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist-site');
const env = process.env;
const strip = (u) => (u ?? '').trim().replace(/\/+$/, '');

const app = strip(env.HOOLAM_APP_URL) || 'https://hoolam.onrender.com';
const site = strip(env.SITE_URL) || strip(env.RENDER_EXTERNAL_URL) || '';
const wa = (env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

let html = readFileSync(join(here, 'index.html'), 'utf8')
  .replaceAll('{{APP_URL}}', app)
  .replaceAll('{{WHATSAPP_NUMBER}}', wa)
  .replaceAll('{{SITE_URL}}/', site ? `${site}/` : '');
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');

console.log(`Landing page built → dist-site/  (server: ${app}${wa ? `, WhatsApp +${wa}` : ''}${site ? `, site: ${site}` : ''})`);
