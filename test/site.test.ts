import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness({ quiet: true, env: { WHATSAPP_PUBLIC_NUMBER: '2348012345678', SITE_URL: 'https://hoolam.example', CONSOLE_URL: 'https://console.hoolam.com', PAY_URL: 'https://pay.hoolam.com' } }); }, 120_000);
afterAll(async () => { await h?.stop(); });

describe('landing page ↔ server', () => {
  it('/site.json gives the live fees, deal limit and number, readable from another site', async () => {
    const r = await h.app.app.inject({ method: 'GET', url: '/site.json' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.json()).toEqual({ currency: 'NGN', whatsapp: '2348012345678', fees: { rate: 2.5, min: 300, max: 5000, roundTo: 100 }, maxDeal: 50000, images: {} });
  });

  it('follows fee changes made in the console', async () => {
    await h.app.settings.save(h.db, { fee_min: 400, max_deal: 80_000 }, null);
    const j = (await h.app.app.inject({ method: 'GET', url: '/site.json' })).json();
    expect(j.fees.min).toBe(400);
    expect(j.maxDeal).toBe(80_000);
  });

  it('/chat opens WhatsApp, and / sends visitors to the landing page', async () => {
    const chat = await h.app.app.inject({ method: 'GET', url: '/chat' });
    expect(chat.statusCode).toBe(302);
    expect(chat.headers.location).toBe('https://wa.me/2348012345678?text=Hi%20Hoolam');
    const root = await h.app.app.inject({ method: 'GET', url: '/' });
    expect(root.headers.location).toBe('https://hoolam.example');
    const con = await h.app.app.inject({ method: 'GET', url: '/', headers: { host: 'console.hoolam.com' } });
    expect(con.headers.location).toBe('/console/');
  });

  it('the site builds with the server address and number filled in', () => {
    execFileSync('node', ['site/build.mjs'], { env: { ...process.env, SITE_OFFLINE: '1', HOOLAM_APP_URL: 'https://app.example/', WHATSAPP_PUBLIC_NUMBER: '+234 801 234 5678', SITE_URL: 'https://hoolam.example' } });
    const html = readFileSync('dist-site/index.html', 'utf8');
    expect(html).toContain('app: "https://app.example"');
    expect(html).toContain('whatsapp: "2348012345678"');
    expect(html).toContain('content="https://hoolam.example/assets/og.png"');
    expect(/\{\{(APP_URL|WHATSAPP_NUMBER|SITE_URL)\}\}|CFA|MoMo/.test(html)).toBe(false);
  });

  it('short links: pay.hoolam.com/HL-ABCDE opens the chat to pay, /v/ to see the deal', async () => {
    const pay = await h.app.app.inject({ method: 'GET', url: '/hl-abcde', headers: { host: 'pay.hoolam.com' } });
    expect(pay.headers.location).toBe('https://wa.me/2348012345678?text=Pay%20HL-ABCDE');
    const view = await h.app.app.inject({ method: 'GET', url: '/v/HL-ABCDE', headers: { host: 'go.hoolam.com' } });
    expect(view.headers.location).toBe('https://wa.me/2348012345678?text=View%20HL-ABCDE');
    expect((await h.app.app.inject({ method: 'GET', url: '/whatever' })).statusCode).toBe(404);
    expect(h.app.deals.payLink('HL-ABCDE')).toBe('https://pay.hoolam.com/HL-ABCDE');
  });

  it('the console only opens on console.hoolam.com', async () => {
    const page = await h.app.app.inject({ method: 'GET', url: '/console/deals', headers: { host: 'go.hoolam.com' } });
    expect(page.statusCode).toBe(301);
    expect(page.headers.location).toBe('https://console.hoolam.com/console/deals');
    expect((await h.app.app.inject({ method: 'GET', url: '/console/api/auth/state', headers: { host: 'go.hoolam.com' } })).statusCode).toBe(404);
    expect((await h.app.app.inject({ method: 'GET', url: '/console/api/auth/state', headers: { host: 'console.hoolam.com' } })).statusCode).toBe(200);
    expect((await h.app.app.inject({ method: 'GET', url: '/health', headers: { host: 'go.hoolam.com' } })).statusCode).toBe(200);
  });
});
