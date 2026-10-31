import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../scripts/harness.js';
import { parseInbound } from '../src/whatsapp/inbound.js';

let h: Harness;
let seq = 0;
const phone = () => `+2348090000${String(++seq).padStart(3, '0')}`;
beforeAll(async () => { h = await startHarness({ quiet: true }); }, 120_000);
afterAll(async () => { await h?.stop(); });
const src = async (p: string) => (await h.db.query('SELECT source, source_detail FROM users WHERE phone=$1', [p])).rows[0];

describe('where each person came from (Source)', () => {
  it('a website button: the page, and the "(ref: …)" never gets in the way of the chat', async () => {
    const p = phone();
    await h.say(p, 'Hi Hoolam (ref: web-pricing)', 'Ada');
    expect(await src(p)).toEqual({ source: 'website', source_detail: { page: 'pricing' } });
    await h.say(p, 'Hi Hoolam, I’d like to talk to a rep (ref: web-contact)');
    expect(await src(p)).toMatchObject({ source: 'website', source_detail: { page: 'pricing' } }); // decided once, on the first message
  });

  it('a campaign link carried through the website', async () => {
    const p = phone();
    await h.say(p, 'Hi Hoolam (ref: ig-bf)', 'Bola');
    expect(await src(p)).toEqual({ source: 'campaign', source_detail: { slug: 'ig-bf' } });
  });

  it('a Facebook or Instagram ad: WhatsApp says which', async () => {
    const p = phone();
    const [m] = parseInbound({ entry: [{ changes: [{ value: { contacts: [{ wa_id: p.slice(1), profile: { name: 'Chi' } }], messages: [{ from: p.slice(1), id: 'ad1', type: 'text', text: { body: 'Hello' }, referral: { source_type: 'ad', source_id: '123', headline: 'Black Friday: buy safely', source_url: 'https://www.instagram.com/p/xyz' } }] } }] }] });
    expect(m!.referral).toEqual({ type: 'ad', id: '123', headline: 'Black Friday: buy safely', url: 'https://www.instagram.com/p/xyz' });
    await h.app.chat.handle(m!);
    expect(await src(p)).toMatchObject({ source: 'ad', source_detail: { headline: 'Black Friday: buy safely', where: 'Instagram' } });
  });

  it('someone\'s order reached their number first', async () => {
    const seller = phone(), buyer = phone();
    await h.say(seller, 'hi', 'Bayo');
    const code = await h.sellOrder(seller, buyer, { item: 'Red cap', price: '5000' });
    await h.say(buyer, `View ${code}`, 'Tolu');
    const s = await src(buyer);
    expect(s.source).toBe('order');
    expect(s.source_detail).toMatchObject({ code, role: 'buyer' });
    expect(s.source_detail.byName).toBeTruthy();
  });

  it('a seller\'s page, and messaging directly', async () => {
    const s = phone();
    await h.say(s, 'hi', 'Kemi');
    await h.db.query(`UPDATE users SET profile_slug='kemi-wigs', profile_public=true WHERE phone=$1`, [s]);
    const b = phone();
    await h.say(b, 'Buy from @kemi-wigs', 'Femi');
    expect(await src(b)).toMatchObject({ source: 'seller_page', source_detail: { slug: 'kemi-wigs' } });
    const d = phone();
    await h.say(d, 'hello', 'Uche');
    expect((await src(d)).source).toBe('direct');
  });
});
