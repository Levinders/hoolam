import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { totpCode } from '../src/console/crypto.js';
import { bus } from '../src/events.js';
import { chatPhone, repHours, sniffFile } from '../src/livechat.js';

let h: Harness;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2dd7c0d0000000049454e44ae426082', 'hex');

/** The website's calls. */
async function site(method: string, url: string, body?: unknown, key?: string | null, raw?: { bytes: Buffer; name: string }) {
  const r = await h.app.app.inject({
    method: method as 'GET', url: `/livechat${url}`,
    headers: { ...(key ? { 'x-chat-key': key } : {}), ...(raw ? { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(raw.name) } : body ? { 'content-type': 'application/json' } : {}) },
    payload: raw ? raw.bytes : body ? JSON.stringify(body) : undefined,
  });
  let json: any = null; try { json = r.json(); } catch { /* binary */ }
  return { status: r.statusCode, json, headers: r.headers, raw: r.rawPayload };
}

/** Two teammates: the owner (Ada Okafor) and a support rep (Chioma Eze). */
const cookies: Record<string, string> = {};
async function con(who: 'owner' | 'rep', method: string, url: string, body?: unknown, raw?: { bytes: Buffer; name: string }) {
  const r = await h.app.app.inject({
    method: method as 'GET', url: `/console/api${url}`,
    headers: { cookie: cookies[who] ?? '', 'x-hoolam-console': '1', ...(raw ? { 'content-type': 'application/octet-stream', 'x-file-name': raw.name } : body ? { 'content-type': 'application/json' } : {}) },
    payload: raw ? raw.bytes : body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers['set-cookie'];
  if (typeof set === 'string' && set.includes('hoolam_console=')) cookies[who] = set.split(';')[0]!;
  let json: any = null; try { json = r.json(); } catch { /* binary */ }
  return { status: r.statusCode, json };
}
async function signInRep() {
  const inv = await con('owner', 'POST', '/team/invite', { email: 'chioma@hoolam.ng', name: 'Chioma Eze', role: 'SUPPORT' });
  const token = String(inv.json.inviteUrl).split('/invite/')[1]!;
  const acc = await h.app.app.inject({ method: 'POST', url: `/console/api/auth/invite/${token}`, headers: { 'content-type': 'application/json', 'x-hoolam-console': '1' }, payload: JSON.stringify({ password: 'Str0ngPassw0rd!' }) });
  const a = acc.json();
  const en = await h.app.app.inject({ method: 'POST', url: '/console/api/auth/enroll', headers: { 'content-type': 'application/json', 'x-hoolam-console': '1' }, payload: JSON.stringify({ ticket: a.ticket, code: totpCode(a.secret) }) });
  cookies.rep = String(en.headers['set-cookie']).split(';')[0]!;
  return inv.json.id as string;
}

describe('small parts', () => {
  it('reads Nigerian WhatsApp numbers, real file types and rep hours', () => {
    expect(chatPhone('0803 123 4567')).toBe('+2348031234567');
    expect(chatPhone('+234 803 123 4567')).toBe('+2348031234567');
    expect(chatPhone('8031234567')).toBe('+2348031234567');
    expect(chatPhone('0123')).toBeNull();
    expect(chatPhone('05031234567')).toBeNull();
    expect(sniffFile(PNG)).toBe('image/png');
    expect(sniffFile(Buffer.from('%PDF-1.7 hello'))).toBe('application/pdf');
    expect(sniffFile(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(repHours(new Date('2026-10-13T08:30:00Z')).open).toBe(true);  // 9:30am in Lagos
    expect(repHours(new Date('2026-10-13T16:30:00Z')).open).toBe(false); // 5:30pm
  });
});

describe('live chat', () => {
  let key = '', thread = 0, repId = '';
  it('the chat shows the home page questions, with today\'s fees filled in', async () => {
    const c = await site('GET', '/config');
    expect(c.status).toBe(200);
    expect(c.headers['access-control-allow-origin']).toBe('*');
    expect(c.json.questions.map((q: any) => q.title)).toEqual(['Do I need an app?', 'How much does it cost?', 'What if my item never comes?', 'What if the buyer says no at the gate?', 'How do I pay or get paid?', 'Who do I talk to if something goes wrong?']);
    expect(c.json.questions[1].body).toMatch(/^2\.5% of the price, starting from ₦300, never more than ₦5,000\./);
    expect(c.json.questions[1].body).not.toContain('{');
    expect(c.json.chips).toContain('Is my money safe?');
    expect(c.json.welcome).toBe('Hi there. How can we help today?');
    expect(c.json.home).toBeUndefined(); // Home shows only "Prefer WhatsApp?" now
    expect(JSON.stringify(c.json)).not.toContain('/fees'); // saved replies are for reps only
  });

  it('a visitor starts with their name, WhatsApp number and a message', async () => {
    expect((await site('POST', '/start', { name: 'Ivana', phone: '123', text: 'Hi' })).json.error).toMatch(/WhatsApp number/);
    expect((await site('POST', '/start', { name: '', phone: '08031234567', text: 'Hi' })).json.error).toMatch(/your name/);
    const r = await site('POST', '/start', { name: 'Ivana Okoro', phone: '0803 123 4567', text: 'Is my money safe with you?', page: '/contact/' });
    expect(r.status).toBe(200);
    key = r.json.key; thread = r.json.threadId;
    expect(key.length).toBeGreaterThan(20);
    const me = await site('GET', '/me', null, key);
    expect(me.json.visitor).toEqual({ name: 'Ivana Okoro', phone: '08031234567' });
    expect(me.json.threads[0]).toMatchObject({ id: thread, status: 'OPEN', unread: 0, last: { kind: 'VISITOR', text: 'Is my money safe with you?' } });
    expect((await site('GET', `/threads/${thread}`, null, 'not-a-real-key-not-a-real-key')).status).toBe(401);
  });

  it('reps see it, the first reply takes the chat, others must take it over', async () => {
    const s = await con('owner', 'POST', '/auth/setup', { setupToken: 'test-admin-token-123456', name: 'Ada Okafor', email: 'ada@hoolam.ng', password: 'Str0ngPassw0rd' });
    await con('owner', 'POST', '/auth/enroll', { ticket: s.json.ticket, code: totpCode(s.json.secret) });
    repId = await signInRep();
    const counts = await con('rep', 'GET', '/support/counts');
    expect(counts.json).toMatchObject({ live: 1, liveMessages: 1 });
    const list = await con('rep', 'GET', '/livechat?view=unassigned');
    expect(list.json.rows[0]).toMatchObject({ id: thread, name: 'Ivana Okoro', phone: '08031234567', unread: 1, assignedTo: null });
    expect((await con('rep', 'POST', `/livechat/${thread}/reply`, { text: 'Hi Ivana! Yes, your money is held safely until the item arrives.' })).status).toBe(200);
    const t = await con('rep', 'GET', `/livechat/${thread}`);
    expect(t.json).toMatchObject({ mine: true, assignedName: 'Chioma Eze' });
    expect(t.json.messages.map((m: any) => m.kind)).toEqual(['VISITOR', 'SYSTEM', 'STAFF']);
    // the owner can read along, but not reply until they take it over
    const blocked = await con('owner', 'POST', `/livechat/${thread}/reply`, { text: 'Hello' });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('Chioma is handling this chat. Take it over first.');
    expect((await con('owner', 'POST', `/livechat/${thread}/note`, { text: 'Her order HL-ABCDE is paid.' })).status).toBe(200);
    // the visitor sees "Chioma" (first name only), never the note
    const v = await site('GET', `/threads/${thread}`, null, key);
    expect(v.json.rep).toBe('Chioma');
    expect(v.json.messages.map((m: any) => [m.kind, m.by, m.body])).toEqual([
      ['VISITOR', null, 'Is my money safe with you?'], ['SYSTEM', 'Chioma', 'joined'], ['STAFF', 'Chioma', 'Hi Ivana! Yes, your money is held safely until the item arrives.'],
    ]);
    expect(JSON.stringify(v.json)).not.toContain('HL-ABCDE');
    expect(v.json.seenUpTo).toBeGreaterThan(0); // Chioma has read it
    // takeover: the visitor sees "Ada joined"
    await con('owner', 'POST', `/livechat/${thread}/assign`);
    expect((await site('GET', `/threads/${thread}`, null, key)).json.rep).toBe('Ada');
    expect((await con('owner', 'POST', `/livechat/${thread}/reply`, { text: 'I’ll take it from here.' })).status).toBe(200);
  });

  it('both sides send photos and PDFs (checked by their bytes, up to 10 MB)', async () => {
    expect((await site('POST', `/threads/${thread}/files`, null, key, { bytes: PNG, name: 'receipt.png' })).status).toBe(200);
    const bad = await site('POST', `/threads/${thread}/files`, null, key, { bytes: Buffer.from('MZ not really'), name: 'evil.png' });
    expect(bad.status).toBe(415);
    const v = await site('GET', `/threads/${thread}`, null, key);
    const file = v.json.messages.at(-1).file;
    expect(file).toMatchObject({ name: 'receipt.png', mime: 'image/png', size: PNG.length });
    const got = await site('GET', `/files/${file.id}?key=${key}`);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.raw, PNG)).toBe(0);
    // someone else can't open it
    const other = await site('POST', '/start', { name: 'Musa', phone: '08051112222', text: 'Hello' });
    expect((await site('GET', `/files/${file.id}?key=${other.json.key}`)).status).toBe(404);
    expect((await site('GET', `/threads/${thread}`, null, other.json.key)).status).toBe(404);
    expect((await con('owner', 'POST', `/livechat/${thread}/files`, null, { bytes: Buffer.from('%PDF-1.4 test'), name: 'guide.pdf' })).status).toBe(200);
  });

  it('typing and "seen" reach the other side live', async () => {
    const seen: any[] = [];
    const on = (e: any) => seen.push(e);
    bus.on('chat', on);
    await site('POST', `/threads/${thread}/typing`, {}, key);
    await con('owner', 'POST', `/livechat/${thread}/typing`);
    const last = (await site('GET', `/threads/${thread}`, null, key)).json.messages.at(-1).id;
    await site('POST', `/threads/${thread}/seen`, { upTo: last }, key);
    bus.off('chat', on);
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: thread, type: 'typing', who: 'visitor' }),
      expect.objectContaining({ threadId: thread, type: 'typing', who: 'staff', name: 'Ada' }),
      expect.objectContaining({ threadId: thread, type: 'seen', by: 'visitor', upTo: last }),
    ]));
    expect((await con('owner', 'GET', `/livechat/${thread}`)).json.visitorReadUpTo).toBe(last);
  });

  it('close, rate the rep, and a new message reopens it', async () => {
    await con('owner', 'POST', `/livechat/${thread}/close`);
    let v = await site('GET', `/threads/${thread}`, null, key);
    expect(v.json.status).toBe('CLOSED');
    expect(v.json.messages.at(-1)).toMatchObject({ kind: 'SYSTEM', body: 'closed', by: 'Ada' });
    await site('POST', `/threads/${thread}/rate`, { rating: 'UP' }, key);
    expect((await con('owner', 'GET', `/livechat/${thread}`)).json).toMatchObject({ rating: 'UP', ratedStaff: 'Ada Okafor' });
    expect((await con('owner', 'GET', `/livechat/${thread}`)).json.ratedAt).toBeTruthy();
    const team = await con('owner', 'GET', '/team');
    expect(team.json.rows.find((r: any) => r.name === 'Ada Okafor')).toMatchObject({ chat_up: 1, chat_down: 0 });
    await site('POST', `/threads/${thread}/messages`, { text: 'One more question please' }, key);
    v = await site('GET', `/threads/${thread}`, null, key);
    expect(v.json.status).toBe('OPEN');
    expect(v.json.messages.slice(-2).map((m: any) => m.body)).toEqual(['reopened', 'One more question please']);
  });

  it('if the visitor has left, one WhatsApp message tells them about the reply, with a link back', async () => {
    h.app.messenger.setTemplateStatus('hoolam_live_chat_reply', 'APPROVED');
    await con('owner', 'POST', `/livechat/${thread}/reply`, { text: 'Sure, what would you like to know?' });
    await h.db.query(`UPDATE chat_threads SET last_staff_at=now() - interval '5 minutes' WHERE id=$1`, [thread]);
    const before = h.transcript.length;
    expect((await h.app.liveChat.sweep()).notified).toBe(1);
    const sent = h.transcript.slice(before).find((t) => t.phone === '+2348031234567');
    expect(sent?.text).toMatch(/Hi Ivana, a Hoolam rep replied to your chat on our website/);
    expect(sent?.text).toMatch(/Sure, what would you like to know\?/);
    const code = (await h.db.query('SELECT resume_code FROM chat_threads WHERE id=$1', [thread])).rows[0].resume_code;
    expect(sent?.text).toContain(`/contact/?chat=${code}`);
    expect((await h.app.liveChat.sweep()).notified).toBe(0); // only once
    // the link opens the same chat on another phone
    const r = await site('POST', '/resume', { code });
    expect(r.json.threadId).toBe(thread);
    expect((await site('GET', `/threads/${thread}`, null, r.json.key)).status).toBe(200);
  });

  it('one conversation per WhatsApp number: a new device joins it but sees only what comes after', async () => {
    const old = await site('GET', `/threads/${thread}`, null, key);
    expect(old.json.partial).toBe(false);
    const before = old.json.messages.length;
    // same number, new browser (no key): same conversation, new key
    const r = await site('POST', '/start', { name: 'Ivana O.', phone: '+234 803 123 4567', text: 'It’s me again, from my laptop', page: '/about/' });
    expect(r.json.threadId).toBe(thread);
    expect(r.json.key).not.toBe(key);
    const me = await site('GET', '/me', null, r.json.key);
    expect(me.json.threads).toHaveLength(1);
    const fresh = await site('GET', `/threads/${thread}`, null, r.json.key);
    expect(fresh.json.partial).toBe(true);
    expect(fresh.json.messages.map((m: any) => m.body)).toEqual(['It’s me again, from my laptop']);
    // the first device still sees everything
    expect((await site('GET', `/threads/${thread}`, null, key)).json.messages).toHaveLength(before + 1);
    // a closed chat reopens when the same number writes again
    await con('owner', 'POST', `/livechat/${thread}/close`);
    const again = await site('POST', '/start', { name: 'Ivana', phone: '08031234567', text: 'Back again' }, key);
    expect(again.json.threadId).toBe(thread);
    expect((await site('GET', `/threads/${thread}`, null, key)).json.status).toBe('OPEN');
    // a different number is a different person
    const other = await site('POST', '/start', { name: 'Ivana', phone: '08039998888', text: 'New number' }, key);
    expect(other.json.threadId).not.toBe(thread);
  });

  it('new questions and news go to the top; news can carry a picture', async () => {
    const q = await con('rep', 'POST', '/livechat-content', { kind: 'QUESTION', title: 'Can I cancel?', body: 'Yes, before the seller sends it.' });
    expect((await site('GET', '/config')).json.questions[0].title).toBe('Can I cancel?');
    const n = await con('rep', 'POST', '/livechat-content', { kind: 'NEWS', title: 'New look', body: 'The chat has a fresh look.' });
    expect((await con('rep', 'POST', `/livechat-content/${n.json.id}/image`, null, { bytes: Buffer.from('<svg/>'), name: 'x' })).status).toBe(415);
    expect((await con('rep', 'POST', `/livechat-content/${n.json.id}/image`, null, { bytes: PNG, name: 'look.png' })).status).toBe(200);
    const news = (await site('GET', '/config')).json.news;
    expect(news[0].title).toBe('New look');
    expect(news[0].imageId).toBeGreaterThan(0);
    const img = await site('GET', `/media/${news[0].imageId}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.raw, PNG)).toBe(0);
    await con('rep', 'DELETE', `/livechat-content/${n.json.id}/image`);
    expect((await site('GET', '/config')).json.news[0].imageId).toBeNull();
    expect((await site('GET', `/media/${news[0].imageId}`)).status).toBe(404);
    await con('rep', 'DELETE', `/livechat-content/${q.json.id}`);
    await con('rep', 'DELETE', `/livechat-content/${n.json.id}`);
  });

  it('reps manage what the chat shows; saved replies stay with the team', async () => {
    const c = await con('rep', 'GET', '/livechat-content');
    expect(c.json.rows.some((r: any) => r.kind === 'HOME')).toBe(false);
    expect((await con('rep', 'POST', '/livechat-content', { kind: 'HOME', title: 'x', body: 'y' })).json.error).toMatch(/Unknown kind/);
    expect(c.json.rows.filter((r: any) => r.kind === 'SAVED').map((r: any) => r.shortcut)).toEqual(['fees', 'safe', 'order', 'hours']);
    expect((await con('rep', 'POST', '/livechat-content', { kind: 'SAVED', title: 'Again', body: 'x', shortcut: 'fees' })).json.error).toMatch(/already used/);
    const n = await con('rep', 'POST', '/livechat-content', { kind: 'NEWS', title: 'Holiday hours', body: 'Reps are off on 25 December.' });
    expect(n.status).toBe(200);
    expect((await site('GET', '/config')).json.news.map((x: any) => x.title)).toContain('Holiday hours');
    await con('rep', 'POST', '/livechat-content', { id: n.json.id, kind: 'NEWS', title: 'Holiday hours', body: 'Reps are off on 25 December.', published: false });
    expect((await site('GET', '/config')).json.news.map((x: any) => x.title)).not.toContain('Holiday hours');
  });

  it('support access is per person: switching live chat off for someone closes it to them', async () => {
    expect((await con('owner', 'GET', '/auth/state')).json.me.access).toEqual({ whatsapp: true, live: true, ambassadors: true });
    await con('owner', 'POST', `/team/${repId}/access`, { live: false });
    const r = await con('rep', 'GET', '/livechat');
    expect(r.status).toBe(403);
    expect((await con('rep', 'GET', '/auth/state')).json.me.access).toEqual({ whatsapp: true, live: false, ambassadors: false });
    expect((await con('owner', 'GET', '/team')).json.rows.find((x: any) => x.id === repId).access).toEqual({ whatsapp: true, live: false, ambassadors: false });
    await con('owner', 'POST', `/team/${repId}/access`, { live: true });
    expect((await con('rep', 'GET', '/livechat')).status).toBe(200);
  });
});
