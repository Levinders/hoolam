import type { Outbound, Button, ListRow } from '../whatsapp/client.js';
import type { User } from '../deals/service.js';
import { CATEGORIES, categoryTitle } from '../deals/categories.js';
import { ART } from '../chat-art/build.js';
import { findPlace, placeNear, placeShort, placeText, type Place } from './areas.js';
import { DELIVERY, DELIVERY_WORDS, nowPrice, onPromo, readSearch, RING_WORDS, startRing, type Card, type Delivery, type Listing, type Market } from './market.js';

/**
 * The market in WhatsApp. Buyers: Browse the market → where to look (once) → categories or typing → swipe cards
 * (Previous · Next · Options) → See more → Buy safely, Save, basket. Sellers: My items → List an item, Manage,
 * Share. Every button id starts with "mk:"; typed answers arrive in states starting with "MK_".
 * Words are short and plain: what it is, what it costs, who sells it, and that the money is held.
 */
export interface MarketChatContext {
  send(phone: string, m: Outbound): Promise<unknown>;
  save(phone: string, state: string, data?: Record<string, unknown>): Promise<void>;
  menu(phone: string, user: User): Promise<unknown>;
  /** Starts an ordinary order from the market (the chat asks what's still missing, then shows the order to check). */
  startOrder(phone: string, user: User, d: { item: string; description: string | null; category: string; priceMinor: number; sellerPhone: string; address: string | null; market: { listingId: number; qty: number; priceMinor: number; title: string }[] }): Promise<unknown>;
  setupSeller(phone: string, user: User): Promise<unknown>;
  kyc(phone: string, user: User): Promise<unknown>;
  askBank(phone: string, user: User): Promise<unknown>;
  download(mediaId: string): Promise<Buffer | null>;
  sellerPhone(userId: string): Promise<string | null>;
  /** The buyer's fee at this price (market fees), for "You pay ₦X, after the seller accepts". */
  buyerQuote(priceMinor: number): { feeMinor: number; buyerPaysMinor: number; sellerGetsMinor: number };
  pageUrl(code: string): string;
  log?: (line: string) => void;
}

type Browse = {
  cat?: string | null; words?: string[]; q?: string | null; min?: number | null; max?: number | null;
  verified?: boolean; promo?: boolean; ring: number; page: number; saved?: boolean; seller?: string | null; sellerName?: string | null;
};
const SIZE = 9; // 9 cards, so the "more" card fits in WhatsApp's 10
const btn = (id: string, title: string): Button => ({ id, title });
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

export class MarketChat {
  constructor(private readonly m: Market, private readonly c: MarketChatContext) {}

  private money(minor: number) { return this.m.money(minor).replace(/\.00$/, ''); }
  private send(phone: string, o: Outbound) { return this.c.send(phone, o); }

  // ---------------------------------------------------------------------------------------------
  // pieces

  private whereText(card: Card, place: Place | null): string {
    const at = card.area ?? card.city ?? card.state ?? 'Nigeria';
    const far = place && place.city && card.city && card.city.toLowerCase() !== place.city.toLowerCase();
    if (far && card.delivery.includes('waybill')) return `${card.city ?? at} · Ships to you`;
    const how = card.delivery.map((d) => (d === 'rider' ? 'rider' : d === 'pickup' ? 'Pickup' : 'waybill'));
    return `${at} · ${how.join(', ').replace(/^./, (x) => x.toUpperCase())}`;
  }
  private record(card: Card) { return card.seller_orders ? `${card.seller_orders} order${card.seller_orders === 1 ? '' : 's'} completed` : 'New on Hoolam'; }
  private art(card: Card, place: Place | null, extra: { ribbon?: string | null; tone?: 'green' | 'gold' | 'grey' | 'red'; greyed?: boolean } = {}) {
    const sold = card.status === 'SOLD_OUT' || card.stock === 0;
    return ART.marketItem({
      listingId: card.id, sellerId: card.seller_id, title: card.title, price: this.money(card.now_minor),
      was: card.on_promo ? this.money(card.price_minor) : null, offPct: card.on_promo ? card.off_pct : null,
      verified: card.seller_verified, where: this.whereText(card, place), seller: card.seller_name, record: this.record(card),
      ribbon: extra.ribbon ?? (sold ? 'Sold out' : card.stock > 0 && card.stock <= 3 ? `${card.stock} left` : null),
      tone: extra.tone ?? (sold ? 'grey' : 'gold'), greyed: extra.greyed ?? sold,
    });
  }
  private priceLine(l: Pick<Listing, 'price_minor' | 'promo_minor' | 'promo_ends'>) {
    if (!onPromo(l)) return `*${this.money(l.price_minor)}*`;
    const ends = l.promo_ends ? ` · until ${new Date(l.promo_ends).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' })}` : '';
    return `~${this.money(l.price_minor)}~ *${this.money(l.promo_minor!)}*${ends}`;
  }
  private deliveryLine(l: Pick<Listing, 'delivery' | 'city'>) {
    return l.delivery.map((d) => d === 'rider' ? `Dispatch rider${l.city ? ` (${l.city})` : ''}` : d === 'waybill' ? 'Waybill (other states)' : 'Pickup').join(' · ');
  }

  // ---------------------------------------------------------------------------------------------
  // buyers: where to look

  /** Browse the market: where to look (once), then the market home. */
  async browse(phone: string, user: User): Promise<unknown> {
    if (!this.m.on()) return this.c.menu(phone, user);
    const b = await this.m.browser(user.id);
    if (!b.place) return this.askWhere(phone);
    return this.home(phone, user);
  }

  async askWhere(phone: string): Promise<unknown> {
    await this.c.save(phone, 'MK_WHERE');
    return this.send(phone, {
      kind: 'buttons', art: ART.picture('market-where'),
      text: '📍 *Where should we look first?*\n\nWe show sellers near you first, then the rest of Nigeria.',
      buttons: [btn('mk:loc', '📍 Send location'), btn('mk:typearea', 'Type my area'), btn('mk:all', '🇳🇬 All Nigeria')],
    });
  }

  private async setPlace(phone: string, user: User, place: (Place & { all?: boolean }) | null): Promise<unknown> {
    await this.m.setBrowser(user.id, { place: place ?? { all: true } });
    return this.home(phone, user, place ? `📍 Showing near *${placeText(place)}*.` : '🇳🇬 Showing all of Nigeria.');
  }
  private placeOf(raw: unknown): Place | null {
    const p = raw as (Place & { all?: boolean }) | null;
    return !p || p.all ? null : p;
  }

  async typedArea(phone: string, user: User, text: string): Promise<unknown> {
    const r = findPlace(text);
    if (r.kind === 'sure') return this.setPlace(phone, user, r.place);
    if (r.kind === 'choose') {
      await this.c.save(phone, 'MK_AREA', { options: r.options });
      return this.send(phone, {
        kind: 'buttons', text: '🤔 Did you mean…',
        buttons: r.options.slice(0, 3).map((p, i) => btn(`mk:pl:${i}`, cut(placeText(p), 20))),
      });
    }
    await this.c.save(phone, 'MK_AREA');
    return this.send(phone, { kind: 'buttons', text: '🤔 We couldn\'t find that area. Try a nearby town, like *Woji, Port Harcourt*, or send your location.', buttons: [btn('mk:loc', '📍 Send location'), btn('mk:all', '🇳🇬 All Nigeria')] });
  }

  async location(phone: string, user: User, lat: number, lng: number): Promise<unknown> {
    const p = placeNear(lat, lng);
    if (!p) return this.send(phone, { kind: 'buttons', text: '📍 We don\'t have sellers mapped near there yet. Type your area, or browse all of Nigeria.', buttons: [btn('mk:typearea', 'Type my area'), btn('mk:all', '🇳🇬 All Nigeria')] });
    return this.setPlace(phone, user, p);
  }

  // ---------------------------------------------------------------------------------------------
  // buyers: the market home, results, paging

  async home(phone: string, user: User, note?: string): Promise<unknown> {
    const b = await this.m.browser(user.id);
    const place = this.placeOf(b.place);
    const cats = await this.m.categoriesWithItems();
    const basket = await this.m.basket(user.id);
    await this.c.save(phone, 'MK_BROWSE');
    await this.m.setBrowser(user.id, { browse: null });
    if (!cats.length) {
      return this.send(phone, { kind: 'buttons', text: `${note ? note + '\n\n' : ''}🛍️ *Hoolam market*\n\nNo items yet. Sellers are adding theirs; check back soon.`, buttons: [btn('mk:where', '📍 Change area')] });
    }
    const icon: Record<string, string> = { clothing: '👗', shoes: '👟', bags: '👜', beauty: '💄', phones: '📱', electronics: '🔌', appliances: '🧊', home: '🛋️', food: '🍲', other: '📦' };
    const rows: ListRow[] = cats.slice(0, 6).map((x) => ({ id: `mk:cat:${x.id}`, title: cut(`${icon[x.id] ?? '📦'} ${categoryTitle(x.id) ?? x.id}`, 24), description: `${x.n} item${x.n === 1 ? '' : 's'}` }));
    const more: ListRow[] = [{ id: 'mk:newest', title: '🆕 Newest', description: 'Just listed' }, { id: 'mk:saved', title: '❤️ Saved', description: 'Items you saved' }];
    if (basket) more.push({ id: 'mk:basket', title: '🧺 My basket', description: `${basket.lines.length} item${basket.lines.length === 1 ? '' : 's'} · ${this.money(basket.totalMinor)}` });
    more.push({ id: 'mk:where', title: '📍 Change area', description: place ? `Now: ${placeText(place)}` : 'Now: all Nigeria' });
    return this.send(phone, {
      kind: 'list', header: '🛍️ Hoolam market',
      text: `${note ? note + '\n\n' : ''}Pick a category, or type what you want, like _black bag under 20k_.\n\n🛡️ Your money is held by Hoolam until you're happy.`,
      button: 'Open the market', sections: [{ title: 'Categories', rows }, { title: 'More', rows: more.slice(0, 10 - rows.length) }],
    });
  }

  /** Shows a page of results for the current browse (the cards, then where you are and Previous · Next · Options). */
  async results(phone: string, user: User, set?: Partial<Browse>): Promise<unknown> {
    const b = await this.m.browser(user.id);
    const place = this.placeOf(b.place);
    const cur: Browse = { ring: startRing(place), page: 0, ...(set && 'ring' in set ? {} : b.browse ?? {}), ...(set ?? {}) };
    if (cur.saved) return this.showSaved(phone, user, cur.page);
    const ring = cur.seller ? 3 : cur.ring;
    const r = await this.m.search({ place, ring, category: cur.cat, words: cur.words, minMinor: cur.min, maxMinor: cur.max, verifiedOnly: cur.verified, promoOnly: cur.promo, sellerId: cur.seller, page: cur.page, pageSize: SIZE });
    await this.m.setBrowser(user.id, { browse: cur });
    await this.c.save(phone, 'MK_BROWSE');
    const label = cur.seller ? `🏪 ${cur.sellerName ?? 'This seller'}'s items` : cur.q ? `🔎 "${cut(cur.q, 40)}"` : cur.cat ? `${categoryTitle(cur.cat)}` : '🆕 Newest';
    const where = cur.seller ? '' : ring >= 3 ? ' in *all Nigeria*' : ` ${ring === 0 ? 'near' : 'in'} *${ring === 0 ? placeShort(place) : ring === 1 ? place?.city : place?.state}*`;
    if (!r.cards.length && r.wider > 0 && ring < 3) return this.results(phone, user, { ...cur, ring: ring + 1, page: 0 }); // nothing here: look wider
    if (cur.q && cur.page === 0) await this.m.logSearch(cur.q, r.total + r.wider);
    if (!r.cards.length) {
      return this.send(phone, { kind: 'buttons', text: `${label}: nothing${where} yet.\n\nTry another word or category.`, buttons: [btn('mk:home', '📂 Categories'), btn('mk:where', '📍 Change area')] });
    }
    await this.m.bump(r.cards.map((x) => x.id), 'seen');
    const from = cur.page * SIZE + 1, to = cur.page * SIZE + r.cards.length;
    await this.send(phone, {
      kind: 'cards',
      text: `${label}${where} · ${r.total} found\n🛡️ Your money is held by Hoolam until you're happy.`,
      cards: r.cards.map((x) => ({ art: this.art(x, place), text: cut(`${x.title}\n${x.seller_name}${x.seller_verified ? ' · ✓ Verified' : ''}`, 160), buttons: [btn(`mk:buy:${x.id}`, '🛡️ Buy safely'), btn(`mk:see:${x.id}`, 'See more')] })),
    });
    const last = to >= r.total;
    const buttons: Button[] = [];
    if (cur.page > 0) buttons.push(btn('mk:prev', '⬅️ Previous'));
    if (!last) buttons.push(btn('mk:next', 'Next ➡️'));
    else if (r.wider > 0 && ring < 3) buttons.push(btn('mk:wide', cut(`🔎 See ${RING_WORDS[ring + 1] === 'your city' ? `all ${place?.city ?? 'your city'}` : RING_WORDS[ring + 1] === 'your state' ? `all ${place?.state ?? 'your state'}` : 'all Nigeria'}`, 20)));
    else buttons.push(btn('mk:again', '🔁 Start again'));
    buttons.push(btn('mk:opts', '☰ Options'));
    const end = last ? (r.wider > 0 && ring < 3 ? `\nThat's everything${where}.` : '\nThat\'s everything.') : '';
    return this.send(phone, { kind: 'buttons', text: `${from}–${to} of ${r.total}${end}`, buttons: buttons.slice(0, 3) });
  }

  /** step 1 / -1 moves a page; 0 shows the same page again (Back); 'first' starts again. */
  async page(phone: string, user: User, step: 1 | -1 | 0 | 'first'): Promise<unknown> {
    const b = (await this.m.browser(user.id)).browse as Browse | null;
    if (!b) return this.home(phone, user);
    if (b.saved) return this.showSaved(phone, user, step === 'first' ? 0 : Math.max(0, b.page + step));
    return this.results(phone, user, { ...b, page: step === 'first' ? 0 : Math.max(0, b.page + step) });
  }
  async widen(phone: string, user: User): Promise<unknown> {
    const b = (await this.m.browser(user.id)).browse as Browse | null;
    if (!b) return this.home(phone, user);
    return this.results(phone, user, { ...b, ring: Math.min(3, b.ring + 1), page: 0 });
  }

  async options(phone: string, user: User): Promise<unknown> {
    const b = await this.m.browser(user.id);
    const cur = b.browse as Browse | null;
    const basket = await this.m.basket(user.id);
    const filtered = cur && (cur.min || cur.max || cur.verified || cur.promo);
    const rows: ListRow[] = [
      { id: 'mk:home', title: '📂 Categories', description: 'All categories' },
      { id: 'mk:saved', title: '❤️ Saved', description: 'Items you saved' },
      ...(basket ? [{ id: 'mk:basket', title: '🧺 My basket', description: `${basket.lines.length} item${basket.lines.length === 1 ? '' : 's'} · ${this.money(basket.totalMinor)}` }] : []),
      { id: 'mk:filter', title: '🔎 Filter', description: 'Price, verified sellers, promos' },
      ...(filtered ? [{ id: 'mk:clear', title: '✖️ Clear filter', description: 'Show everything again' }] : []),
      { id: 'mk:where', title: '📍 Change area', description: placeText(this.placeOf(b.place)) },
    ];
    return this.send(phone, { kind: 'list', text: 'What would you like to do?', button: 'Options', sections: [{ title: 'Market', rows }] });
  }

  async filter(phone: string, user: User): Promise<unknown> {
    const cur = ((await this.m.browser(user.id)).browse ?? { ring: 3, page: 0 }) as Browse;
    const price = cur.max ? `Under ${this.money(cur.max)}` : cur.min ? `From ${this.money(cur.min)}` : 'Any';
    const ringWord = ['Near me', 'My city', 'My state', 'All Nigeria'][cur.ring] ?? 'All Nigeria';
    return this.send(phone, {
      kind: 'list', text: '🔎 *Filter*\n\nTap one to change it, then *Show results*.', button: 'Filter',
      sections: [{ title: 'Filter', rows: [
        { id: 'mk:f:area', title: '📍 Area', description: ringWord },
        { id: 'mk:f:price', title: '💰 Price', description: price },
        { id: 'mk:f:ver', title: '✓ Verified sellers only', description: cur.verified ? 'On' : 'Off' },
        { id: 'mk:f:promo', title: '🏷️ On promo only', description: cur.promo ? 'On' : 'Off' },
        { id: 'mk:f:go', title: '✅ Show results', description: 'With this filter' },
        { id: 'mk:clear', title: '✖️ Clear filter', description: 'Back to everything' },
      ] }],
    });
  }
  async filterPick(phone: string, user: User, what: string, value?: string): Promise<unknown> {
    const b = await this.m.browser(user.id);
    const cur = (b.browse ?? { ring: startRing(this.placeOf(b.place)), page: 0 }) as Browse;
    if (what === 'area' && value == null) {
      return this.send(phone, { kind: 'list', text: '📍 How far should we look?', button: 'Area', sections: [{ title: 'Area', rows: [
        { id: 'mk:f:area:0', title: 'Near me' }, { id: 'mk:f:area:1', title: 'My city' }, { id: 'mk:f:area:2', title: 'My state' }, { id: 'mk:f:area:3', title: 'All Nigeria' }] }] });
    }
    if (what === 'price' && value == null) {
      const unit = 100;
      const steps = [5_000, 10_000, 20_000, 50_000, 100_000, 250_000];
      return this.send(phone, { kind: 'list', text: '💰 Up to how much?', button: 'Price', sections: [{ title: 'Price', rows: [
        ...steps.map((v) => ({ id: `mk:f:price:${v * unit}`, title: `Under ${this.money(v * unit)}` })), { id: 'mk:f:price:0', title: 'Any price' }] }] });
    }
    const next: Browse = { ...cur, page: 0 };
    if (what === 'area') next.ring = Math.max(startRing(this.placeOf(b.place)), Math.min(3, Number(value)));
    if (what === 'price') next.max = Number(value) || null;
    if (what === 'ver') next.verified = !cur.verified;
    if (what === 'promo') next.promo = !cur.promo;
    await this.m.setBrowser(user.id, { browse: next });
    if (what === 'go') return this.results(phone, user, next);
    return this.filter(phone, user);
  }
  async clearFilter(phone: string, user: User): Promise<unknown> {
    const b = await this.m.browser(user.id);
    const cur = (b.browse ?? {}) as Browse;
    return this.results(phone, user, { cat: cur.cat, words: cur.words, q: cur.q, seller: cur.seller, sellerName: cur.sellerName, ring: startRing(this.placeOf(b.place)), page: 0 });
  }

  /** Typed while browsing: a command (next, back, saved…), or a search like "black bag under 20k in Lagos". */
  async typed(phone: string, user: User, text: string): Promise<unknown> {
    const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
    if (['next', 'more', 'next page', 'see more'].includes(t)) return this.page(phone, user, 1);
    if (['back', 'previous', 'prev'].includes(t)) return this.page(phone, user, -1);
    if (['saved', 'favourites', 'favorites', 'my saved'].includes(t)) return this.showSaved(phone, user, 0);
    if (['basket', 'cart', 'my basket'].includes(t)) return this.showBasket(phone, user);
    if (['categories', 'category', 'market', 'home'].includes(t)) return this.home(phone, user);
    if (['filter', 'filters'].includes(t)) return this.filter(phone, user);
    if (['options'].includes(t)) return this.options(phone, user);
    const s = readSearch(text);
    if (s.where) {
      const p = findPlace(s.where);
      if (p.kind === 'sure') await this.m.setBrowser(user.id, { place: p.place });
    }
    const place = this.placeOf((await this.m.browser(user.id)).place);
    if (!s.words.length && !s.maxMinor && !s.minMinor) return this.home(phone, user);
    // a category named in the words ("shoes", "bag") narrows to it
    const cat = CATEGORIES.find((c) => s.words.some((w) => c.id.startsWith(w) || w.startsWith(c.id.replace(/s$/, ''))));
    const words = cat && s.words.length === 1 ? [] : s.words;
    return this.results(phone, user, { q: text.trim().slice(0, 80), words, cat: words.length ? null : cat?.id ?? null, min: s.minMinor, max: s.maxMinor, ring: startRing(place), page: 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // buyers: one item, save, basket, report

  async seeMore(phone: string, user: User, id: number): Promise<unknown> {
    const c = await this.m.card(id);
    if (!c || ['DELETED', 'REMOVED'].includes(c.status)) return this.send(phone, { kind: 'buttons', text: 'This item is no longer available.', buttons: [btn('mk:back', '⬅️ Back')] });
    const place = this.placeOf((await this.m.browser(user.id)).place);
    await this.m.bump(id, 'views');
    if (c.photos > 1) {
      await this.send(phone, {
        kind: 'cards', text: `📷 ${c.title}`,
        cards: Array.from({ length: Math.min(c.photos, 4) }, (_, i) => ({ art: { card: 'marketPhoto', data: { photoListing: id, photoPosition: i } }, text: `Photo ${i + 1} of ${Math.min(c.photos, 4)}`, buttons: [btn(`mk:buy:${id}`, '🛡️ Buy safely')] })),
      });
    }
    const saved = await this.m.isSaved(user.id, id);
    const sold = c.status !== 'LIVE' || c.stock === 0;
    const text = [
      `*${c.title}*`, this.priceLine(c), c.details ? `\n${c.details}` : '',
      `\n📍 ${[c.area, c.city].filter(Boolean).join(', ') || 'Nigeria'}`, `🚚 ${this.deliveryLine(c)}`,
      sold ? '⚪ Sold out for now.' : c.stock <= 3 ? `Only ${c.stock} left.` : '',
      `\n🛡️ *${c.seller_name}*${c.seller_verified ? ' · ✓ Verified' : ''} · ${this.record(c)}`,
      '💳 You pay Hoolam, not the seller. The money is held until you\'re happy.',
    ].filter(Boolean).join('\n');
    return this.send(phone, {
      kind: 'buttons', text: cut(text, 1024), art: c.photos > 1 ? undefined : this.art(c, place),
      buttons: sold ? [btn(`mk:save:${id}`, saved ? '✓ Saved' : '❤️ Save'), btn(`mk:more:${id}`, '☰ More'), btn('mk:back', '⬅️ Back')]
        : [btn(`mk:buy:${id}`, '🛡️ Buy safely'), btn(`mk:save:${id}`, saved ? '✓ Saved' : '❤️ Save'), btn(`mk:more:${id}`, '☰ More')],
    });
  }

  async more(phone: string, user: User, id: number): Promise<unknown> {
    const c = await this.m.card(id);
    if (!c) return this.page(phone, user, 0);
    return this.send(phone, { kind: 'list', text: `*${cut(c.title, 60)}*`, button: 'More', sections: [{ title: 'More', rows: [
      { id: 'mk:back', title: '⬅️ Back to results' },
      ...(c.status === 'LIVE' && c.stock > 0 ? [{ id: `mk:bask:${id}:1`, title: '🧺 Add to basket', description: 'Buy several from this seller at once' }] : []),
      { id: `mk:seller:${c.seller_id}`, title: '🏪 More from this seller', description: cut(c.seller_name, 72) },
      { id: `mk:rep:${id}`, title: '🚩 Report this item', description: 'Fake, wrong price or not allowed' },
    ] }] });
  }

  async save(phone: string, user: User, id: number): Promise<unknown> {
    const on = !(await this.m.isSaved(user.id, id));
    await this.m.save(user.id, id, on);
    return this.send(phone, { kind: 'buttons', text: on ? '❤️ Saved. Find it any time under *Saved*.' : 'Removed from Saved.', buttons: [btn('mk:back', '⬅️ Back'), btn('mk:saved', '❤️ Saved items')] });
  }

  async showSaved(phone: string, user: User, page = 0): Promise<unknown> {
    const all = await this.m.savedCards(user.id);
    await this.m.setBrowser(user.id, { browse: { saved: true, ring: 3, page } });
    await this.c.save(phone, 'MK_BROWSE');
    if (!all.length) return this.send(phone, { kind: 'buttons', text: '❤️ Nothing saved yet. Tap *❤️ Save* on an item you like, to find it here later.', buttons: [btn('mk:home', '📂 Categories')] });
    const place = this.placeOf((await this.m.browser(user.id)).place);
    const cards = all.slice(page * SIZE, page * SIZE + SIZE);
    await this.send(phone, {
      kind: 'cards', text: `❤️ Saved · ${all.length}`,
      cards: cards.map((x) => {
        const live = x.status === 'LIVE' && x.stock > 0;
        return { art: this.art(x, place), text: cut(`${x.title}\n${x.seller_name}${live ? '' : ' · sold out for now'}`, 160), buttons: live ? [btn(`mk:buy:${x.id}`, '🛡️ Buy safely'), btn(`mk:see:${x.id}`, 'See more')] : [btn(`mk:see:${x.id}`, 'See more')] };
      }),
    });
    const buttons: Button[] = [];
    if (page > 0) buttons.push(btn('mk:prev', '⬅️ Previous'));
    if ((page + 1) * SIZE < all.length) buttons.push(btn('mk:next', 'Next ➡️'));
    buttons.push(btn('mk:home', '📂 Categories'));
    return this.send(phone, { kind: 'buttons', text: `${page * SIZE + 1}–${page * SIZE + cards.length} of ${all.length}`, buttons });
  }

  async report(phone: string, user: User, id: number, reason?: string): Promise<unknown> {
    const reasons = ['Fake or a copy', 'Wrong price', 'Not allowed', 'Seller didn\'t answer', 'Something else'];
    if (reason == null) {
      return this.send(phone, { kind: 'list', text: '🚩 What\'s wrong with this item?', button: 'Pick one', sections: [{ title: 'Report', rows: reasons.map((r, i) => ({ id: `mk:rr:${id}:${i}`, title: r })) }] });
    }
    const r = await this.m.report(id, user.id, reasons[Number(reason)] ?? 'Something else');
    if (r.hidden && r.listing) { // enough reports: paused for the team to look, and the seller is told
      const sp = await this.c.sellerPhone(r.listing.seller_id);
      if (sp) await this.notify(sp, r.listing, 'hidden').catch((e) => this.c.log?.(`market hidden notice: ${(e as Error).message}`));
    }
    return this.send(phone, { kind: 'buttons', text: '🙏 Thanks. Our team will look at it.', buttons: [btn('mk:back', '⬅️ Back')] });
  }

  async sellerItems(phone: string, user: User, sellerId: string): Promise<unknown> {
    const c = (await this.m.search({ place: null, ring: 3, sellerId, page: 0, pageSize: 1 })).cards[0];
    return this.results(phone, user, { seller: sellerId, sellerName: c?.seller_name ?? null, ring: 3, page: 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // buyers: buying

  /** Buy safely: how many (if more than one), then the order with the fee shown, then Continue. */
  async buy(phone: string, user: User, id: number, qty?: number): Promise<unknown> {
    const c = await this.m.card(id);
    if (!c || c.status !== 'LIVE' || c.stock === 0) return this.send(phone, { kind: 'buttons', text: '⚪ Sorry, this item just sold out.', buttons: [btn('mk:back', '⬅️ Back')] });
    if (c.seller_id === user.id && !this.m['o'].testMode) return this.send(phone, { kind: 'buttons', text: 'That\'s your own item.', buttons: [btn('mk:back', '⬅️ Back')] });
    if (qty == null && c.stock > 1) {
      const n = Math.min(c.stock, 9);
      return this.send(phone, { kind: 'list', text: `🛡️ *${cut(c.title, 60)}*\n${this.priceLine(c)} each\n\nHow many?`, button: 'How many', sections: [{ title: 'How many', rows: Array.from({ length: n }, (_, i) => ({ id: `mk:qty:${id}:${i + 1}`, title: `${i + 1}`, description: this.money(c.now_minor * (i + 1)) })) }] });
    }
    const q = Math.max(1, Math.min(qty ?? 1, c.stock));
    await this.m.bump(id, 'buys');
    const total = c.now_minor * q;
    const fee = this.c.buyerQuote(total);
    const place = this.placeOf((await this.m.browser(user.id)).place);
    return this.send(phone, {
      kind: 'buttons', art: this.art(c, place),
      text: [
        `🛡️ *${c.title}*${q > 1 ? ` ×${q}` : ''} from *${c.seller_name}*`,
        `${this.money(total)} · 📍 ${c.area ?? c.city ?? 'Nigeria'} · ${this.deliveryLine(c)}`,
        fee.feeMinor ? `Hoolam fee ${this.money(fee.feeMinor)} · *You pay ${this.money(fee.buyerPaysMinor)}*, after the seller accepts` : `*You pay ${this.money(fee.buyerPaysMinor)}*, after the seller accepts`,
        '\nNothing is paid yet.',
      ].join('\n'),
      buttons: [btn(`mk:go:${id}:${q}`, 'Continue'), btn(`mk:bask:${id}:${q}`, '🧺 Add to basket'), btn('mk:back', '⬅️ Back')],
    });
  }

  /** Continue: an ordinary order, everything filled in from the listing. */
  async go(phone: string, user: User, id: number, qty: number): Promise<unknown> {
    const l = await this.m.get(id);
    if (!l || l.status !== 'LIVE' || l.stock < 1) return this.send(phone, { kind: 'buttons', text: '⚪ Sorry, this item just sold out.', buttons: [btn('mk:back', '⬅️ Back')] });
    const q = Math.max(1, Math.min(qty, l.stock));
    return this.startFrom(phone, user, l.seller_id, [{ listing: l, qty: q }]);
  }
  private async startFrom(phone: string, user: User, sellerId: string, lines: { listing: Listing; qty: number }[]): Promise<unknown> {
    const sellerPhone = await this.c.sellerPhone(sellerId);
    if (!sellerPhone) return this.send(phone, { kind: 'buttons', text: 'We couldn\'t reach this seller. Try another item.', buttons: [btn('mk:back', '⬅️ Back')] });
    const one = lines.length === 1 ? lines[0]! : null;
    const item = one ? `${one.listing.title}${one.qty > 1 ? ` ×${one.qty}` : ''}` : lines.map((x) => `${x.listing.title}${x.qty > 1 ? ` ×${x.qty}` : ''}`).join(', ');
    const price = lines.reduce((s, x) => s + nowPrice(x.listing) * x.qty, 0);
    const pickupOnly = lines.every((x) => x.listing.delivery.length === 1 && x.listing.delivery[0] === 'pickup');
    const where = lines[0]!.listing;
    return this.c.startOrder(phone, user, {
      item: cut(item, 200), description: one?.listing.details ?? null, category: lines[0]!.listing.category, priceMinor: price, sellerPhone,
      address: pickupOnly ? `Pickup from the seller${where.area || where.city ? ` in ${[where.area, where.city].filter(Boolean).join(', ')}` : ''}` : null,
      market: lines.map((x) => ({ listingId: x.listing.id, qty: x.qty, priceMinor: nowPrice(x.listing), title: x.listing.title })),
    });
  }

  async addToBasket(phone: string, user: User, id: number, qty: number, fresh = false): Promise<unknown> {
    const l = await this.m.get(id);
    if (!l || l.status !== 'LIVE' || l.stock < 1) return this.send(phone, { kind: 'buttons', text: '⚪ Sorry, this item just sold out.', buttons: [btn('mk:back', '⬅️ Back')] });
    if (fresh) await this.m.clearBasket(user.id);
    const r = await this.m.addToBasket(user.id, l, qty);
    if (!r.ok) {
      const other = await this.m.basket(user.id);
      const name = other?.lines[0]?.listing.seller_name ?? 'another seller';
      return this.send(phone, { kind: 'buttons', text: `🧺 Your basket is for *${name}*. One basket is for one seller, because each seller sends and is paid on their own.\n\nBuy that basket first, or start a new one for this seller.`, buttons: [btn('mk:basket', `🧺 My basket`), btn(`mk:newbask:${id}:${qty}`, 'Start a new basket'), btn('mk:back', '⬅️ Back')] });
    }
    const b = await this.m.basket(user.id);
    return this.send(phone, { kind: 'buttons', text: `🧺 Added. ${b!.lines.length} item${b!.lines.length === 1 ? '' : 's'} from *${b!.lines[0]!.listing.seller_name}* · ${this.money(b!.totalMinor)}`, buttons: [btn('mk:basket', '🧺 My basket'), btn(`mk:seller:${l.seller_id}`, '🏪 Seller\'s items'), btn('mk:back', '⬅️ Back')] });
  }

  async showBasket(phone: string, user: User): Promise<unknown> {
    const b = await this.m.basket(user.id);
    if (!b) return this.send(phone, { kind: 'buttons', text: '🧺 Your basket is empty. Tap *🧺 Add to basket* on items from one seller to buy them together.', buttons: [btn('mk:home', '📂 Categories')] });
    const fee = this.c.buyerQuote(b.totalMinor);
    const lines = b.lines.map((x) => `• ${x.listing.title}${x.qty > 1 ? ` ×${x.qty}` : ''}: ${this.money(x.listing.now_minor * x.qty)}`).join('\n');
    return this.send(phone, {
      kind: 'buttons',
      text: `🧺 *My basket* · *${b.lines[0]!.listing.seller_name}*\n\n${lines}\n\nTotal ${this.money(b.totalMinor)}${fee.feeMinor ? ` · Hoolam fee ${this.money(fee.feeMinor)}` : ''}\n*You pay ${this.money(fee.buyerPaysMinor)}*, after the seller accepts. One order, one payment, all held together.`,
      buttons: [btn('mk:buyall', '🛡️ Buy all safely'), btn('mk:empty', '🗑️ Empty basket'), btn('mk:back', '⬅️ Back')],
    });
  }
  async buyAll(phone: string, user: User): Promise<unknown> {
    const b = await this.m.basket(user.id);
    if (!b) return this.showBasket(phone, user);
    const lines: { listing: Listing; qty: number }[] = [];
    for (const x of b.lines) { const l = await this.m.get(x.listing.id); if (l && l.status === 'LIVE' && l.stock > 0) lines.push({ listing: l, qty: Math.min(x.qty, l.stock) }); }
    if (!lines.length) return this.showBasket(phone, user);
    await this.m.bump(lines.map((x) => x.listing.id), 'buys');
    await this.m.clearBasket(user.id);
    return this.startFrom(phone, user, b.sellerId, lines);
  }
  async emptyBasket(phone: string, user: User): Promise<unknown> {
    await this.m.clearBasket(user.id);
    return this.send(phone, { kind: 'buttons', text: '🗑️ Basket emptied.', buttons: [btn('mk:back', '⬅️ Back')] });
  }

  /** "Buy <code>" typed (from an item page or a shared link): straight to that item. */
  async buyCode(phone: string, user: User, code: string, ad?: string | null): Promise<unknown> {
    const l = await this.m.get(code);
    if (!l || ['DELETED', 'REMOVED'].includes(l.status)) return this.send(phone, { kind: 'buttons', text: 'That item isn\'t in the market any more.', buttons: [btn('mk:home', '🛍️ Browse the market')] });
    if (ad) await this.m.adTap(l.id, ad, 'taps');
    return this.seeMore(phone, user, l.id);
  }

  // ---------------------------------------------------------------------------------------------
  // sellers

  /** My items: the picture with their numbers, then List an item · Manage my items. */
  async myItems(phone: string, user: User): Promise<unknown> {
    if (!this.m.on()) return this.c.menu(phone, user);
    const can = await this.m.canList(user);
    if (!can.ok && ['setup', 'kyc', 'bank', 'apply', 'applied', 'declined', 'stopped'].includes(can.why)) {
      const mine = await this.m.mine(user.id);
      if (!mine.items.length || ['setup', 'apply', 'applied', 'declined', 'stopped'].includes(can.why)) return this.blocked(phone, user, can.why, can.reason ?? null);
    }
    const mine = await this.m.mine(user.id);
    await this.c.save(phone, 'IDLE');
    const atLimit = mine.used >= mine.limit;
    const name = await this.c.sellerPhone(user.id).then(() => user.display_name ?? 'You');
    return this.send(phone, {
      kind: 'buttons', art: ART.myItems({ sellerId: user.id, name: name ?? 'You', live: mine.live, soldOut: mine.soldOut, views: mine.week.views + mine.week.seen }),
      text: `📦 *My items* · ${mine.used} of ${mine.limit} used${mine.paused ? ` · ${mine.paused} paused` : ''}${mine.expired ? ` · ${mine.expired} expired` : ''}`,
      buttons: [atLimit ? btn('mk:upgrade', '⬆️ Get more items') : btn('mk:new', '➕ List an item'), ...(mine.items.length ? [btn('mk:manage', '📋 Manage my items')] : [])],
    });
  }

  private async blocked(phone: string, user: User, why: string, reason: string | null): Promise<unknown> {
    if (why === 'setup') return this.c.setupSeller(phone, user);
    if (why === 'kyc') return this.c.kyc(phone, user);
    if (why === 'bank') return this.c.askBank(phone, user);
    if (why === 'apply' || why === 'declined') {
      return this.send(phone, { kind: 'buttons', text: `🛍️ *Sell in the Hoolam market*\n\nBuyers near you, and across Nigeria, see your items and buy with their money held by Hoolam.${why === 'declined' && reason ? `\n\nLast time: ${reason}` : ''}\n\nApply once. We reply on WhatsApp.`, buttons: [btn('mk:apply', 'Apply')] });
    }
    if (why === 'applied') return this.send(phone, { kind: 'text', text: '⏳ Thanks. Your request to list is with our team. We\'ll reply on WhatsApp soon.' });
    if (why === 'stopped') return this.send(phone, { kind: 'buttons', text: `You can't list for now${reason ? `: ${reason}` : ''}. Talk to a rep to sort it out.`, buttons: [btn('menu:human', '🙋 Talk to a rep')] });
    return this.c.menu(phone, user);
  }

  async apply(phone: string, user: User, note?: string | null): Promise<unknown> {
    if (note === undefined) {
      await this.c.save(phone, 'MK_APPLY');
      return this.send(phone, { kind: 'buttons', text: 'What do you sell? One line is enough, like _sneakers and slides_.', buttons: [btn('mk:applyskip', 'Skip')] });
    }
    await this.m.apply(user.id, note);
    await this.c.save(phone, 'IDLE');
    return this.send(phone, { kind: 'text', text: '⏳ Thanks. We\'ll reply on WhatsApp soon.' });
  }

  async upgrade(phone: string, user: User, ask = false): Promise<unknown> {
    const u = this.m.cfg().upgrade;
    if (!u.on) return this.send(phone, { kind: 'buttons', text: `You've listed ${await this.m.limitFor(user.id)} items, your limit. To list more, talk to a rep.`, buttons: [btn('menu:human', '🙋 Talk to a rep'), btn('mk:manage', '📋 Manage my items')] });
    if (!ask) return this.send(phone, { kind: 'buttons', text: `⬆️ *Get more items*\n\nList up to *${u.items} items* for *${this.money(u.priceMinor)}* a month.`, buttons: [btn('mk:upask', 'Yes, I want it'), btn('mk:manage', '📋 Manage my items')] });
    const r = await this.m.askUpgrade(user.id);
    return this.send(phone, { kind: 'text', text: r.already ? '⏳ Your request is with our team. A rep will message you soon.' : '✅ Got it. A rep will message you to confirm payment, then your limit goes up.' });
  }

  // ----- listing, in the chat: photos → name → category → price → how many → delivery → where -----

  async startListing(phone: string, user: User): Promise<unknown> {
    const can = await this.m.canList(user);
    if (!can.ok) return can.why === 'limit' ? this.upgrade(phone, user) : this.blocked(phone, user, can.why, can.reason ?? null);
    await this.c.save(phone, 'MK_L_PHOTO', { photos: [] });
    return this.send(phone, { kind: 'text', text: '📷 *List an item*\n\nSend 1 to 4 clear photos of the item. Your own photos only.', noMenu: true });
  }

  /** Each typed answer (or photo) while listing or editing. */
  async listingStep(phone: string, user: User, state: string, data: Record<string, any>, m: { type: string; text: string; mediaId: string | null; buttonId: string | null }): Promise<unknown> {
    const text = m.text.trim();
    const save = (st: string, d: Record<string, unknown>) => this.c.save(phone, st, d);
    switch (state) {
      case 'MK_L_PHOTO': {
        const photos: string[] = data.photos ?? [];
        if (m.type === 'image' && m.mediaId) {
          photos.push(m.mediaId);
          if (photos.length >= 4) { await save('MK_L_NAME', { ...data, photos }); return this.send(phone, { kind: 'text', text: '📝 What is it? Name it the way buyers search, like _Nike Air Force 1, size 43_.', noMenu: true }); }
          await save('MK_L_PHOTO', { ...data, photos });
          return this.send(phone, { kind: 'buttons', text: `📷 ${photos.length} photo${photos.length === 1 ? '' : 's'} added. Send another, or tap Done.`, buttons: [btn('mk:photosdone', 'Done')] });
        }
        if (m.buttonId === 'mk:photosdone' && photos.length) { await save('MK_L_NAME', data); return this.send(phone, { kind: 'text', text: '📝 What is it? Name it the way buyers search, like _Nike Air Force 1, size 43_.', noMenu: true }); }
        return this.send(phone, { kind: 'text', text: '📷 Send a photo of the item first.', noMenu: true });
      }
      case 'MK_L_NAME': {
        if (text.length < 3) return this.send(phone, { kind: 'text', text: 'A little more, please. Say what it is, like _Black leather bag_.', noMenu: true });
        await save('MK_L_CAT', { ...data, title: text.slice(0, 80) });
        const cats = this.m.cfg().categories;
        return this.send(phone, { kind: 'list', text: '🏷️ Which category?', button: 'Category', sections: [{ title: 'Category', rows: cats.slice(0, 10).map((id) => ({ id: `mk:lcat:${id}`, title: cut(categoryTitle(id) ?? id, 24) })) }] });
      }
      case 'MK_L_CAT': {
        const id = m.buttonId?.startsWith('mk:lcat:') ? m.buttonId.slice(8) : null;
        if (!id || !this.m.cfg().categories.includes(id)) return this.send(phone, { kind: 'text', text: 'Tap a category from the list.', noMenu: true });
        await save('MK_L_PRICE', { ...data, category: id });
        return this.send(phone, { kind: 'text', text: '💰 The price, in naira? Like _45000_ or _45k_.', noMenu: true });
      }
      case 'MK_L_PRICE': {
        const p = this.parseMoney(text);
        if (!p) return this.send(phone, { kind: 'text', text: 'Type the price as a number, like _45000_.', noMenu: true });
        await save('MK_L_STOCK', { ...data, priceMinor: p });
        return this.send(phone, { kind: 'buttons', text: '📦 How many do you have? Type a number, or tap 1.', buttons: [btn('mk:stock1', 'Just 1')] });
      }
      case 'MK_L_STOCK': {
        const n = m.buttonId === 'mk:stock1' ? 1 : Number(text.replace(/\D/g, ''));
        if (!Number.isInteger(n) || n < 1 || n > 10_000) return this.send(phone, { kind: 'text', text: 'Type how many you have, like _3_.', noMenu: true });
        await save('MK_L_DELIV', { ...data, stock: n });
        return this.deliveryPick(phone, 'mk:ldel');
      }
      case 'MK_L_DELIV': {
        const d = m.buttonId?.startsWith('mk:ldel:') ? this.deliveryOf(m.buttonId.slice(8)) : null;
        if (!d) return this.deliveryPick(phone, 'mk:ldel');
        await save('MK_L_WHERE', { ...data, delivery: d });
        const last = await this.lastPlace(user.id);
        return this.send(phone, last
          ? { kind: 'buttons', text: `📍 Where is it? Type the area and city, like _Woji, Port Harcourt_.`, buttons: [btn('mk:lsame', cut(`Same: ${placeText(last)}`, 20))] }
          : { kind: 'text', text: '📍 Where is it? Type the area and city, like _Woji, Port Harcourt_.', noMenu: true });
      }
      case 'MK_L_WHERE': {
        let place: Place | null = null;
        if (m.buttonId === 'mk:lsame') place = await this.lastPlace(user.id);
        else if (m.buttonId?.startsWith('mk:lpl:')) place = (data.options ?? [])[Number(m.buttonId.slice(7))] ?? null;
        else {
          const r = findPlace(text);
          if (r.kind === 'sure') place = r.place;
          else if (r.kind === 'choose') { await save('MK_L_WHERE', { ...data, options: r.options }); return this.send(phone, { kind: 'buttons', text: '🤔 Did you mean…', buttons: r.options.slice(0, 3).map((p, i) => btn(`mk:lpl:${i}`, cut(placeText(p), 20))) }); }
          else return this.send(phone, { kind: 'text', text: 'We couldn\'t find that area. Try the city, like _Port Harcourt_ or _Ikeja, Lagos_.', noMenu: true });
        }
        if (!place) return this.send(phone, { kind: 'text', text: 'Type the area and city, like _Woji, Port Harcourt_.', noMenu: true });
        return this.finishListing(phone, user, { ...data, place });
      }
      // ----- editing one item -----
      case 'MK_E_PRICE': case 'MK_E_PROMO': {
        const p = /^(stop|end|remove|no|none)$/i.test(text) ? null : this.parseMoney(text);
        if (state === 'MK_E_PROMO' && p == null && /^(stop|end|remove|no|none)$/i.test(text)) return this.applyEdit(phone, user, data.id, { promo: null });
        if (!p) return this.send(phone, { kind: 'text', text: 'Type the amount as a number, like _40000_.', noMenu: true });
        if (state === 'MK_E_PRICE') return this.applyEdit(phone, user, data.id, { price: p });
        await save('MK_E_PROMO_END', { id: data.id, promo: p });
        return this.send(phone, { kind: 'list', text: '🏷️ Until when?', button: 'Promo ends', sections: [{ title: 'Promo ends', rows: [
          { id: 'mk:pend:3', title: 'In 3 days' }, { id: 'mk:pend:7', title: 'In a week' }, { id: 'mk:pend:14', title: 'In 2 weeks' }, { id: 'mk:pend:30', title: 'In a month' }, { id: 'mk:pend:0', title: 'Until I stop it' }] }] });
      }
      case 'MK_E_PROMO_END': {
        const days = m.buttonId?.startsWith('mk:pend:') ? Number(m.buttonId.slice(8)) : NaN;
        if (Number.isNaN(days)) return this.send(phone, { kind: 'text', text: 'Pick when the promo ends from the list.', noMenu: true });
        return this.applyEdit(phone, user, data.id, { promo: data.promo, ends: days ? new Date(Date.now() + days * 86_400_000) : null });
      }
      case 'MK_E_STOCK': {
        const n = Number(text.replace(/\D/g, ''));
        if (!Number.isInteger(n) || !/\d/.test(text)) return this.send(phone, { kind: 'text', text: 'Type how many you have now, like _3_ (0 = sold out).', noMenu: true });
        return this.applyEdit(phone, user, data.id, { stock: n });
      }
      case 'MK_E_DELIV': {
        const d = m.buttonId?.startsWith('mk:edel:') ? this.deliveryOf(m.buttonId.slice(8)) : null;
        if (!d) return this.deliveryPick(phone, 'mk:edel');
        return this.applyEdit(phone, user, data.id, { delivery: d });
      }
    }
    return this.c.menu(phone, user);
  }

  private deliveryPick(phone: string, prefix: string) {
    const opts: [string, string, string][] = [
      ['all', 'All three', 'Pickup, dispatch rider and waybill'], ['pr', 'Pickup + rider', 'Buyers in your city'], ['rw', 'Rider + waybill', 'Your city and other states'],
      ['pw', 'Pickup + waybill', 'Pickup, or waybill to other states'], ['p', 'Pickup only', 'Buyers collect it from you'], ['r', 'Dispatch rider only', 'Delivered in your city'], ['w', 'Waybill only', 'Sent to other states'],
    ];
    return this.send(phone, { kind: 'list', text: '🚚 How can buyers get it? Pick every way you offer.', button: 'Delivery', sections: [{ title: 'Delivery', rows: opts.map(([k, t, d]) => ({ id: `${prefix}:${k}`, title: t, description: d })) }] });
  }
  private deliveryOf(k: string): Delivery[] | null {
    const map: Record<string, Delivery[]> = { all: ['pickup', 'rider', 'waybill'], pr: ['pickup', 'rider'], rw: ['rider', 'waybill'], pw: ['pickup', 'waybill'], p: ['pickup'], r: ['rider'], w: ['waybill'] };
    return map[k] ?? null;
  }
  private parseMoney(t: string): number | null {
    const s = t.toLowerCase().replace(/[,₦\s]|naira|ngn/g, '');
    const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!m) return null;
    const v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
    return v >= 1 ? Math.round(v * 100) : null;
  }
  private async lastPlace(userId: string): Promise<Place | null> {
    const r = (await this.m['o'].db.query(`SELECT area, city, state, lat, lng FROM market_listings WHERE seller_id=$1 AND city IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    return r ? { area: r.area, city: r.city, state: r.state, lat: r.lat ?? undefined, lng: r.lng ?? undefined } : null;
  }

  /** The listing form (or the chat steps) is done: check it, list it, show it live. */
  async finishListing(phone: string, user: User, d: Record<string, any>): Promise<unknown> {
    const photos: { bytes: Buffer }[] = [];
    for (const id of (d.photos ?? []).slice(0, 4)) { const b = await this.c.download(id); if (b) photos.push({ bytes: b }); }
    if (!photos.length && d.photoBytes) photos.push(...(d.photoBytes as Buffer[]).map((b) => ({ bytes: b })));
    const r = await this.m.create(user.id, {
      title: d.title, details: d.details ?? null, category: d.category, priceMinor: d.priceMinor, promoMinor: d.promoMinor ?? null, promoEnds: d.promoEnds ?? null,
      stock: d.stock ?? 1, delivery: d.delivery ?? ['pickup'], place: d.place ?? null, photos,
    });
    await this.c.save(phone, 'IDLE');
    if (!r.ok) return this.send(phone, { kind: 'buttons', text: `We couldn't list this: ${r.why}`, buttons: [btn('mk:new', 'Try again')] });
    const c = (await this.m.card(r.listing.id))!;
    return this.send(phone, {
      kind: 'buttons', art: this.art(c, null, { ribbon: 'Live in the market', tone: 'green', greyed: false }),
      text: `✅ *${c.title}* is live.\n${this.c.pageUrl(c.code)}`,
      buttons: [btn(`mk:share:${c.id}`, '📤 Share this item'), btn('mk:new', '➕ List another')],
    });
  }

  // ----- managing items -----

  async manage(phone: string, user: User, page = 0): Promise<unknown> {
    const mine = await this.m.mine(user.id);
    if (!mine.items.length) return this.myItems(phone, user);
    const dot: Record<string, string> = { LIVE: '🟢 Live', SOLD_OUT: '⚪ Sold out', PAUSED: '⏸ Paused', HIDDEN: '⏸ Being checked', EXPIRED: '⌛ Expired', REMOVED: '🔴 Removed' };
    const per = 8, items = mine.items.slice(page * per, page * per + per);
    const rows: ListRow[] = items.map((l) => ({ id: `mk:item:${l.id}`, title: cut(l.title, 24), description: cut(`${dot[l.status] ?? l.status} · ${this.money(nowPrice(l))}${l.status === 'LIVE' ? ` · ${l.stock} left` : ''}`, 72) }));
    if ((page + 1) * per < mine.items.length) rows.push({ id: `mk:manage:${page + 1}`, title: 'Next ➡️', description: `Items ${(page + 1) * per + 1}+` });
    if (page > 0) rows.push({ id: `mk:manage:${page - 1}`, title: '⬅️ Previous' });
    return this.send(phone, { kind: 'list', text: `📋 *Manage my items* · ${mine.items.length}`, button: 'My items', sections: [{ title: 'My items', rows }] });
  }

  async item(phone: string, user: User, id: number): Promise<unknown> {
    const c = await this.m.card(id);
    if (!c || c.seller_id !== user.id || c.status === 'DELETED') return this.manage(phone, user);
    const st = await this.m.itemStats(id);
    const word: Record<string, string> = { LIVE: '🟢 Live', SOLD_OUT: '⚪ Sold out', PAUSED: '⏸ Paused', HIDDEN: '⏸ Paused while our team looks at it', EXPIRED: '⌛ Expired', REMOVED: `🔴 Removed${c.status_reason ? `: ${c.status_reason}` : ''}` };
    const exp = new Date(c.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
    return this.send(phone, {
      kind: 'buttons', art: this.art(c, null),
      text: `*${c.title}*\n${this.priceLine(c)} · ${c.stock} left\n${word[c.status] ?? c.status}${c.status === 'LIVE' ? ` · until ${exp}` : ''}\n\n👀 ${st.seen + st.views} seen · ❤️ ${st.saves} saved · 🛒 ${st.orders} sold`,
      buttons: c.status === 'REMOVED' ? [btn('mk:manage', '📋 My items')] : [
        btn(`mk:chg:${id}`, '✏️ Change'), btn(`mk:share:${id}`, '📤 Share'),
        c.status === 'PAUSED' ? btn(`mk:act:${id}:resume`, '▶️ Resume') : c.status === 'EXPIRED' ? btn(`mk:act:${id}:renew`, '🔁 Renew') : btn(`mk:act:${id}:pause`, '⏸ Pause'),
      ],
    });
  }

  async change(phone: string, user: User, id: number): Promise<unknown> {
    const l = await this.m.get(id);
    if (!l || l.seller_id !== user.id) return this.manage(phone, user);
    return this.send(phone, { kind: 'list', text: `✏️ *${cut(l.title, 60)}*: what would you like to change?`, button: 'Change', sections: [{ title: 'Change', rows: [
      { id: `mk:e:${id}:price`, title: '💰 Price', description: this.money(l.price_minor) },
      { id: `mk:e:${id}:promo`, title: '🏷️ Promo price', description: onPromo(l) ? `Now ${this.money(l.promo_minor!)}` : 'Sell for less, for a while' },
      { id: `mk:e:${id}:stock`, title: '📦 How many', description: `${l.stock} now` },
      { id: `mk:e:${id}:deliv`, title: '🚚 Delivery', description: l.delivery.map((x) => DELIVERY_WORDS[x]).join(', ') },
      { id: `mk:act:${id}:renew`, title: '🔁 Renew', description: `Live for ${this.m.cfg().expireDays} more days` },
      { id: `mk:act:${id}:soldout`, title: '⚪ Mark sold out' },
      { id: `mk:act:${id}:delete`, title: '🗑️ Delete' },
    ] }] });
  }
  async editAsk(phone: string, user: User, id: number, what: string): Promise<unknown> {
    const st = { price: 'MK_E_PRICE', promo: 'MK_E_PROMO', stock: 'MK_E_STOCK', deliv: 'MK_E_DELIV' }[what];
    if (!st) return this.change(phone, user, id);
    await this.c.save(phone, st, { id });
    if (what === 'deliv') return this.deliveryPick(phone, 'mk:edel');
    return this.send(phone, { kind: 'text', noMenu: true, text: what === 'price' ? '💰 The new price, in naira?' : what === 'promo' ? '🏷️ The promo price, in naira? Buyers see the old price crossed out. (Type _stop_ to end a promo.)' : '📦 How many do you have now? (0 = sold out)' });
  }
  async applyEdit(phone: string, user: User, id: number, change: Parameters<Market['edit']>[2]): Promise<unknown> {
    const r = await this.m.edit(user.id, id, change);
    await this.c.save(phone, 'IDLE');
    if (!r.ok) return this.send(phone, { kind: 'buttons', text: r.why, buttons: [btn(`mk:item:${id}`, '⬅️ Back to item')] });
    if ('action' in change && change.action === 'delete') return this.send(phone, { kind: 'buttons', text: '🗑️ Deleted.', buttons: [btn('mk:manage', '📋 My items')] });
    if (r.backInStock) this.onBackInStock?.(r.listing);
    return this.item(phone, user, id);
  }
  /** Set by the app: tells buyers who saved an item that it's back (when that switch is on). */
  onBackInStock?: (l: Listing) => void;

  async share(phone: string, user: User, id: number): Promise<unknown> {
    const c = await this.m.card(id);
    if (!c || c.seller_id !== user.id) return this.manage(phone, user);
    // forwardable as it is: the card picture with the item, price and link under it
    return this.send(phone, { kind: 'text', noMenu: true, art: this.art(c, null), text: `*${c.title}* · ${onPromo(c) ? `~${this.money(c.price_minor)}~ ` : ''}*${this.money(c.now_minor)}*\n🛡️ Buy safely with Hoolam: your money is held until you're happy.\n${this.c.pageUrl(c.code)}` });
  }

  // ---------------------------------------------------------------------------------------------
  // messages to sellers (each with the item's picture)

  async notify(phone: string, l: Listing, kind: 'soldout' | 'expiring' | 'expired' | 'promoEnded' | 'hidden' | 'removed' | 'stopped', reason?: string | null): Promise<unknown> {
    const c = await this.m.card(l.id);
    if (!c) return;
    const day = new Date(l.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
    const m: Record<typeof kind, { ribbon: string; tone: 'green' | 'gold' | 'grey' | 'red'; text: string; buttons: Button[] }> = {
      soldout: { ribbon: 'Sold out', tone: 'grey', text: `⚪ *${c.title}* is sold out and hidden.`, buttons: [btn(`mk:e:${l.id}:stock`, '📦 Add more')] },
      expiring: { ribbon: `Hides ${day}`, tone: 'gold', text: `⌛ *${c.title}* hides on ${day}.`, buttons: [btn(`mk:act:${l.id}:renew`, '🔁 Renew')] },
      expired: { ribbon: 'Expired', tone: 'grey', text: `⌛ *${c.title}* is no longer showing.`, buttons: [btn(`mk:act:${l.id}:renew`, '🔁 Renew')] },
      promoEnded: { ribbon: 'Promo ended', tone: 'gold', text: `🏷️ Your promo on *${c.title}* has ended. It's back to ${this.money(c.price_minor)}.`, buttons: [btn(`mk:e:${l.id}:promo`, '🏷️ Run it again')] },
      hidden: { ribbon: 'Paused', tone: 'grey', text: `⏸ We've paused *${c.title}* while our team takes a look. We'll message you.`, buttons: [btn('mk:manage', '📋 My items')] },
      removed: { ribbon: 'Removed', tone: 'red', text: `🔴 We removed *${c.title}*${reason ? `: ${reason}` : ''}.\n\nOnly list items you can sell honestly and legally.`, buttons: [btn('mk:manage', '📋 My items')] },
      stopped: { ribbon: 'Removed', tone: 'red', text: `🔴 We removed *${c.title}*${reason ? `: ${reason}` : ''}.\n\nYou can't list for now because several items were removed. Talk to a rep to sort it out.`, buttons: [btn('menu:human', '🙋 Talk to a rep')] },
    };
    const x = m[kind];
    return this.send(phone, { kind: 'buttons', art: this.art(c, null, { ribbon: x.ribbon, tone: x.tone, greyed: kind !== 'expiring' && kind !== 'promoEnded' }), text: x.text, buttons: x.buttons });
  }

  // ---------------------------------------------------------------------------------------------
  // bringing people back (each behind its own switch in Features → Market; only to people who said yes)

  /** "Back in stock": to someone who saved it. */
  async backInStock(phone: string, l: Listing): Promise<unknown> {
    const c = await this.m.card(l.id);
    if (!c || c.status !== 'LIVE') return;
    return this.send(phone, { kind: 'buttons', art: this.art(c, null, { ribbon: 'Back in stock', tone: 'green', greyed: false }), text: `❤️ *${c.title}*, which you saved, is back. ${this.priceLine(c)}`, buttons: [btn(`mk:buy:${c.id}`, '🛡️ Buy safely'), btn(`mk:see:${c.id}`, 'See more')] });
  }

  /** "New from a seller you bought from" (at most once a week per person). */
  async newFromSeller(phone: string, items: Card[]): Promise<unknown> {
    if (!items.length) return;
    const s = items[0]!.seller_name;
    return this.send(phone, {
      kind: 'cards', text: `🆕 New from *${s}*, who you bought from before.`,
      cards: items.slice(0, 9).map((x) => ({ art: this.art(x, null), text: cut(`${x.title}\n${x.seller_name}`, 160), buttons: [btn(`mk:buy:${x.id}`, '🛡️ Buy safely'), btn(`mk:see:${x.id}`, 'See more')] })),
    });
  }

  /** Asked once, after someone's first completed order: may we tell them about items they'd like? */
  async askUpdates(phone: string): Promise<unknown> {
    return this.send(phone, { kind: 'buttons', text: '🔔 Want a message when an item you saved is back, or a seller you bought from adds something new? At most once a week.', buttons: [btn('mk:upd:yes', 'Yes, tell me'), btn('mk:upd:no', 'No, thanks')] });
  }
  async setUpdates(phone: string, user: User, ok: boolean): Promise<unknown> {
    await this.m.setBrowser(user.id, { updates_ok: ok, asked: true });
    return this.send(phone, { kind: 'text', text: ok ? '🔔 Done. Reply *stop updates* any time to stop.' : 'Okay. We won\'t send updates.' });
  }

  // ---------------------------------------------------------------------------------------------
  // the router: every "mk:" button and list reply

  async button(phone: string, user: User, id: string): Promise<unknown> {
    const [, a, x, y] = id.split(':');
    const n = Number(x);
    switch (a) {
      case 'loc': await this.c.save(phone, 'MK_WHERE'); return this.send(phone, { kind: 'askLocation', text: '📍 Tap *Send location* so we show sellers near you first.' });
      case 'typearea': await this.c.save(phone, 'MK_AREA'); return this.send(phone, { kind: 'text', text: '📍 Type your area and city, like _Woji, Port Harcourt_ or _Ikeja, Lagos_.', noMenu: true });
      case 'all': return this.setPlace(phone, user, null);
      case 'pl': {
        const s = await this.m['o'].db.query('SELECT data FROM chat_sessions WHERE phone=$1', [phone]);
        const p = (s.rows[0]?.data?.options ?? [])[n];
        return p ? this.setPlace(phone, user, p) : this.askWhere(phone);
      }
      case 'where': return this.askWhere(phone);
      case 'home': return this.home(phone, user);
      case 'cat': return this.results(phone, user, { cat: x, ring: startRing(this.placeOf((await this.m.browser(user.id)).place)), page: 0 });
      case 'new': return this.startListing(phone, user);
      case 'newest': return this.results(phone, user, { ring: startRing(this.placeOf((await this.m.browser(user.id)).place)), page: 0 });
      case 'next': return this.page(phone, user, 1);
      case 'prev': return this.page(phone, user, -1);
      case 'again': return this.page(phone, user, 'first');
      case 'back': return this.page(phone, user, 0);
      case 'wide': return this.widen(phone, user);
      case 'opts': return this.options(phone, user);
      case 'filter': return this.filter(phone, user);
      case 'f': return this.filterPick(phone, user, x ?? '', y);
      case 'clear': return this.clearFilter(phone, user);
      case 'saved': return this.showSaved(phone, user, 0);
      case 'see': return this.seeMore(phone, user, n);
      case 'more': return this.more(phone, user, n);
      case 'save': return this.save(phone, user, n);
      case 'rep': return this.report(phone, user, n);
      case 'rr': return this.report(phone, user, n, y ?? '4');
      case 'seller': return this.sellerItems(phone, user, x ?? '');
      case 'buy': return this.buy(phone, user, n);
      case 'qty': return this.buy(phone, user, n, Number(y));
      case 'go': return this.go(phone, user, n, Number(y) || 1);
      case 'bask': return this.addToBasket(phone, user, n, Number(y) || 1);
      case 'newbask': return this.addToBasket(phone, user, n, Number(y) || 1, true);
      case 'basket': return this.showBasket(phone, user);
      case 'buyall': return this.buyAll(phone, user);
      case 'empty': return this.emptyBasket(phone, user);
      case 'upd': return this.setUpdates(phone, user, x === 'yes');
      // sellers
      case 'items': return this.myItems(phone, user);
      case 'apply': return this.apply(phone, user);
      case 'applyskip': return this.apply(phone, user, null);
      case 'upgrade': return this.upgrade(phone, user);
      case 'upask': return this.upgrade(phone, user, true);
      case 'manage': return this.manage(phone, user, Number(x) || 0);
      case 'item': return this.item(phone, user, n);
      case 'chg': return this.change(phone, user, n);
      case 'e': return this.editAsk(phone, user, n, y ?? '');
      case 'act': return this.applyEdit(phone, user, n, { action: y as 'pause' | 'resume' | 'renew' | 'soldout' | 'delete' });
      case 'share': return this.share(phone, user, n);
    }
    return this.home(phone, user);
  }
}

export { DELIVERY };
