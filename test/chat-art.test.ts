import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import * as K from '../src/chat-art/cards.js';
import { ChatArt } from '../src/chat-art/index.js';
import { SLOTS } from '../src/chat-art/slots.js';
import { Messenger } from '../src/whatsapp/client.js';
import { msg } from '../src/whatsapp/messages.js';

let h: Harness;
const ADMIN = 'test-admin-token-123456';
beforeAll(async () => { h = await startHarness({ quiet: true, twoStep: false }); }, 120_000);
afterAll(async () => { await h?.stop(); });

async function call(method: string, url: string, o: { body?: unknown; raw?: Buffer; type?: string; cookie?: string; name?: string } = {}) {
  const r = await h.app.app.inject({
    method: method as 'GET', url: `/console/api${url}`,
    headers: { 'x-hoolam-console': '1', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.type ? { 'content-type': o.type } : {}), ...(o.name ? { 'x-file-name': o.name } : {}) },
    payload: o.raw ?? (o.body ? JSON.stringify(o.body) : undefined),
  });
  let json: any = null; try { json = r.json(); } catch { /* not JSON */ }
  const set = r.headers['set-cookie'];
  return { status: r.statusCode, json, raw: r.rawPayload, type: r.headers['content-type'], cookie: typeof set === 'string' ? set.split(';')[0] : undefined };
}

/** A Messenger that talks to a pretend WhatsApp, and records what it was sent. */
function liveMessenger() {
  const sent: any[] = [];
  let n = 0;
  const m = new Messenger(h.db, { dryRun: false, token: 't', phoneNumberId: '1', graphVersion: 'v21.0', fetchImpl: (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${++n}` }] }), { status: 200 }); }) as typeof fetch });
  const uploads: string[] = [];
  const art = new ChatArt(h.db, { media: { upload: async (_b: Buffer, mime: string) => { uploads.push(mime); return `media-${uploads.length}`; } } as any, dryRun: false });
  m.setArt(art);
  return { m, sent, uploads, art };
}
const open = (phone: string) => h.db.query(`INSERT INTO chat_sessions (phone, state, last_inbound_at) VALUES ($1,'IDLE',now()) ON CONFLICT (phone) DO UPDATE SET last_inbound_at=now()`, [phone]);

describe('the pictures', () => {
  it('every live card, fixed picture and sticker draws, light enough for WhatsApp', async () => {
    const jpeg = (b: Buffer) => b.subarray(0, 3).toString('hex') === 'ffd8ff';
    const all = await Promise.all([
      K.moneyHeld({ side: 'buyer', amount: '₦15,300', code: 'HL-7K2QF', other: 'Kemi' }), K.moneyHeld({ side: 'seller', amount: '₦14,500', code: 'HL-7K2QF' }),
      K.paid({ state: 'paid', amount: '₦14,500', code: 'HL-7K2QF' }), K.paid({ state: 'ready', amount: '₦14,500' }), K.refund({ amount: '₦15,300', code: 'HL-7K2QF' }),
      K.payment({ amount: '₦15,300', accountNumber: '5000123456', bankName: 'Moniepoint', accountName: 'Hoolam', code: 'HL-7K2QF', validUntil: '3:45 PM today' }),
      K.handover({ digits: '4821', code: 'HL-7K2QF', to: 'rider' }), K.frozen({ side: 'seller', amount: '₦14,500', code: 'HL-7K2QF' }),
      K.summary({ side: 'buyer', item: 'A very long item name that has to wrap onto a second line and then be cut short somewhere sensible', lines: [{ icon: 'store', text: 'Seller' }], big: { label: 'Total', value: '₦15,000' } }),
      K.trustCard({ name: 'Kemi', verified: true, isNew: false, completed: 3 }), K.trustStatus({ name: 'Kemi', verified: false, isNew: true, completed: 0, link: 'hoolam.com/s/kemi' }),
      K.complete({ item: 'Wig', n: 1 }), K.fees({ rows: [{ price: '₦5,000', hoolam: '₦300', txn: '₦500' }] }),
      K.ambMonth({ name: 'Tobi', month: 'October', amount: '₦0', bars: [], people: 0, activeSellers: 0 }), K.ambWelcome({ name: 'Tobi' }),
      K.howItWorks(), K.status(1), K.status(6), K.idCheck(), K.codeWhere(), K.photoTips(), K.realHoolam({ number: '0811 766 3890' }), K.rider(), K.ambIntro({ seller: '20%', buyer: '10%', bonus: '₦1,000' }),
    ]);
    for (const b of all) { expect(jpeg(b)).toBe(true); expect(b.length).toBeLessThan(300_000); }
    const st = await K.sticker('paid');
    const meta = await sharp(st).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512, hasAlpha: true });
    expect(st.length).toBeLessThan(100_000);
  }, 60_000);

  it('every slot in the console list can show a preview (voice and video only once uploaded)', async () => {
    const art = new ChatArt(h.db, { media: {} as any, dryRun: true });
    for (const s of SLOTS) {
      const p = await art.preview(s.id);
      if (s.kind === 'voice' || s.kind === 'video') expect(p, s.id).toBeNull();
      else expect(p?.bytes.length, s.id).toBeGreaterThan(1000);
    }
  }, 60_000);
});

describe('the logo', () => {
  it('pictures use the uploaded logo icon, and the drawn mark when there is none', async () => {
    const { setMarkSource, refreshMark, markImage, markKey } = await import('../src/brand-mark.js');
    const { renderBrandCard } = await import('../src/receipt.js');
    const icon = await sharp({ create: { width: 300, height: 300, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const drawn = await renderBrandCard();
    setMarkSource(async () => ({ mime: 'image/png', bytes: icon }));
    await refreshMark(true);
    expect(markImage(0, 0, 64)).toMatch(/^<image href="data:image\/png;base64,/);
    expect(markKey()).not.toBe('drawn');
    const withIcon = await renderBrandCard();
    expect(withIcon.equals(drawn)).toBe(false);
    // the red icon is in the picture where the mark goes
    const { data, info } = await sharp(withIcon).raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 200 && data[i + 1]! < 60 && data[i + 2]! < 60) red++;
    expect(red).toBeGreaterThan(5000);
    setMarkSource(async () => null);
    await refreshMark(true);
    expect(markImage(0, 0, 64)).toBeNull();
    expect((await renderBrandCard()).equals(drawn)).toBe(true);
    setMarkSource(null);
  }, 30_000);
});

describe('sending', () => {
  it('a button message gets the picture on top; a text message becomes a picture with the words under it', async () => {
    const { m, sent, uploads } = liveMessenger();
    const p = '+2348011110001';
    await open(p);
    await m.send(p, msg.welcome('Ada'));
    expect(sent.at(-1).interactive.header).toEqual({ type: 'image', image: { id: 'media-1' } });
    expect(sent.at(-1).interactive.body.text).toMatch(/Welcome to Hoolam/);
    await m.send(p, msg.askDealCode());
    expect(sent.at(-1).interactive).toMatchObject({ header: { type: 'image' }, body: { text: expect.stringMatching(/HL-7K2QF/) } }); // plain text gets "Main menu", so the picture sits on top
    await m.send(p, msg.saveHoolam()); // a text that keeps no menu: the picture, with the words under it
    expect(sent.at(-1)).toMatchObject({ type: 'image', image: { caption: expect.stringMatching(/Save Hoolam/) } });
    // the same picture is uploaded once, then reused
    await m.send(p, msg.welcome('Ada'));
    expect(uploads.filter((x) => x === 'image/jpeg')).toHaveLength(3);
  }, 30_000);

  it('a voice note goes only once it is uploaded, and "first time only" ones only the first time', async () => {
    const { m, sent, art } = liveMessenger();
    const p = '+2348011110002';
    await open(p);
    const payment = () => msg.payInstructions({ minor: 1_530_000, currency: 'NGN' }, '5000123456', 'Moniepoint', 'Hoolam', null, 'HL-AAAAA');
    await m.send(p, payment());
    expect(sent.filter((x) => x.type === 'audio')).toHaveLength(0); // nothing recorded yet
    await art.put('voice-first-pay', Buffer.from('OggS fake voice note'), 'audio/ogg', 'first-pay.opus', null);
    await m.send(p, payment());
    expect(sent.at(-1)).toMatchObject({ type: 'audio', audio: { id: expect.any(String) } });
    const before = sent.length;
    await m.send(p, payment());
    expect(sent.slice(before).some((x) => x.type === 'audio')).toBe(false); // the first time only
    await m.send(p, msg.help()); // "How it works" plays it every time it's asked for
    expect(sent.filter((x) => x.type === 'audio')).toHaveLength(1);
    await art.put('voice-how', Buffer.from('ID3 fake mp3'), 'audio/mp3', 'how.mp3', null);
    await m.send(p, msg.help()); await m.send(p, msg.help());
    expect(sent.filter((x) => x.type === 'audio')).toHaveLength(3);
  }, 30_000);

  it('stickers and reactions go with their message', async () => {
    const { m, sent } = liveMessenger();
    const p = '+2348011110003';
    await open(p);
    await m.send(p, msg.ratedUp('Kemi'));
    expect(sent.at(-1)).toMatchObject({ type: 'sticker', sticker: { id: expect.any(String) } });
    await m.send(p, msg.humanLogged('S-1', 'wamid.theirs'));
    expect(sent.at(-2)).toMatchObject({ type: 'reaction', reaction: { message_id: 'wamid.theirs', emoji: '✅' } });
  }, 30_000);
});

describe('the console', () => {
  let owner = '';
  it('lists every item, uploads a voice note, replaces a picture, and puts it back', async () => {
    owner = (await call('POST', '/auth/setup', { body: { setupToken: ADMIN, name: 'Raphael', email: 'r@hoolam.ng', password: 'Str0ngPassw0rd' } })).cookie!;
    const list = await call('GET', '/chat-media', { cookie: owner });
    expect(list.json.items.length).toBe(SLOTS.length);
    expect(list.json.items.find((x: any) => x.id === 'voice-seller-held')).toMatchObject({ kind: 'voice', custom: false, script: expect.arrayContaining([expect.stringMatching(/not a bank alert/)]) });

    const pic = await call('GET', '/chat-media/how-it-works/file', { cookie: owner });
    expect(pic.status).toBe(200);
    expect(pic.type).toMatch(/image\/jpeg/);
    expect((await call('GET', '/chat-media/voice-seller-held/file', { cookie: owner })).status).toBe(404);

    const up = await call('PUT', '/chat-media/voice-handover', { raw: Buffer.from('OggS voice'), type: 'audio/ogg', name: 'handover.opus', cookie: owner });
    expect(up.status).toBe(200);
    expect(up.json.items.find((x: any) => x.id === 'voice-handover')).toMatchObject({ custom: true, fileName: 'handover.opus' });
    expect((await call('PUT', '/chat-media/voice-handover', { raw: Buffer.from('RIFF'), type: 'audio/wav', cookie: owner })).status).toBe(400);

    const mine = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#ff0000' } }).png().toBuffer();
    expect((await call('PUT', '/chat-media/how-it-works', { raw: mine, type: 'image/png', name: 'mine.png', cookie: owner })).status).toBe(200);
    const after = await call('GET', '/chat-media/how-it-works/file', { cookie: owner });
    const { dominant } = await sharp(after.raw).stats();
    expect(dominant.r).toBeGreaterThan(200);
    expect((await call('DELETE', '/chat-media/how-it-works', { cookie: owner })).json.items.find((x: any) => x.id === 'how-it-works').custom).toBe(false);
    const audit = await h.db.query(`SELECT action FROM audit_log WHERE action LIKE 'chat_media.%' ORDER BY id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['chat_media.upload', 'chat_media.upload', 'chat_media.remove']);
  }, 60_000);
});
