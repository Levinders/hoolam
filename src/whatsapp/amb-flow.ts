import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AMB_CHANNELS, AMB_KNOWS, AMB_REACH, AmbassadorError, amsg, dayText, firstOf, monthKey, monthLabel, NG_STATES, type Ambassadors } from '../ambassadors.js';
import type { User } from '../deals/service.js';
import type { Outbound, SendStatus } from './client.js';
import type { KycNext } from './flow.js';
import { ART, CLIP } from '../chat-art/build.js';

/**
 * THE AMBASSADOR PROGRAMME IN WHATSAPP
 *   - "🤝 Become an ambassador" (last row of both menus): the application form (4 short steps), or the website when
 *     the form can't be used.
 *   - After approval, setup one step at a time: ID check, where we pay them, their term, their link name, a photo.
 *   - "🤝 Ambassador" once active: this month, their people, their link and term; Share my link; Details (a live form
 *     with a month picker); the web dashboard.
 *   - Term notices: Renew / Switch term / End.
 *   - Someone new arriving with "Tobi sent me (TOBI)" is linked to Tobi; others are asked once, before their first order.
 */

/** What the chat lends the ambassador screens (all from Conversation). */
export interface AmbChatContext {
  save(phone: string, state: string, data?: Record<string, any>): Promise<void>;
  send(phone: string, m: Outbound): Promise<SendStatus>;
  startKyc(phone: string, user: User, next: KycNext): Promise<unknown>;
  /** Ask for their payout account, then tap `then` when it's saved. */
  askBank(phone: string, then: string): Promise<unknown>;
  menu(phone: string, user: User): Promise<unknown>;
  /** Carry on to Buy something / Sell something (after the one-time question). */
  continueTo(phone: string, user: User, item: 'buy' | 'sell'): Promise<unknown>;
  download(mediaId: string): Promise<Buffer | null>;
  applyForm(): { flowId: string; mode: 'draft' | 'published' } | null;
  detailsForm(): { flowId: string; mode: 'draft' | 'published' } | null;
  formRefused(key: 'ambApply' | 'ambDetails', phone: string): Promise<void> | void;
  secret: string;
  siteUrl: string;
  log?: (l: string) => void;
}

/** "Hi Hoolam, I want to buy safely. Tobi sent me (TOBI)" → "tobi". */
export const SENT_ME_RE = /sent me\s*\(([a-z0-9-]{2,30})\)/i;
const PERF = 'Your share grows when you bring more active sellers and buyers, whatever term you pick.';

export class AmbassadorChat {
  constructor(private readonly a: Ambassadors, private readonly c: AmbChatContext) {}

  private m(minor: number) { return this.a.money(minor); }

  /** "🤝 Ambassador" / "🤝 Become an ambassador" from the menu. */
  async open(phone: string, user: User): Promise<unknown> {
    await this.c.save(phone, 'IDLE');
    const st = await this.a.standing(user.id);
    if (!this.a.on() && st.kind !== 'active' && st.kind !== 'paused') return this.c.menu(phone, user);
    switch (st.kind) {
      case 'none': case 'declined': return this.intro(phone);
      case 'pending': return this.c.send(phone, { kind: 'buttons', text: '⏳ *Your application is being reviewed.*\n\nWe reply on WhatsApp within 24 hours. Thank you for your patience.', buttons: [{ id: 'menu:open', title: 'Main menu' }] });
      case 'setup': return this.setup(phone, user);
      default: return this.screen(phone, user);
    }
  }

  /** What the programme is, then Apply. */
  private async intro(phone: string): Promise<unknown> {
    const cfg = this.a.cfg();
    const bonus = cfg.bonusMinor ? `\n💰 *${this.m(cfg.bonusMinor)} bonus* for each new seller, once they complete ${cfg.bonusOrders} orders` : '';
    return this.c.send(phone, {
      kind: 'buttons',
      art: ART.picture('amb-intro'),
      text: `🤝 *Become a Hoolam ambassador*\n\nBring sellers and buyers to Hoolam and earn from every order they complete:\n\n🏷️ *${pct(cfg.sellerPct)}* of what Hoolam earns on orders from sellers you bring\n🛒 *${pct(cfg.buyerPct)}* on orders from buyers you bring${bonus}\n🏦 Paid to your bank every month\n\n${PERF}\n\nIt takes about 2 minutes to apply. We reply within 24 hours.`,
      buttons: [{ id: 'amb:apply', title: 'Apply now' }, { id: 'menu:open', title: 'Main menu' }],
    });
  }

  /** The application: the WhatsApp form, or the website form. */
  async apply(phone: string, user: User): Promise<unknown> {
    const st = await this.a.standing(user.id);
    if (st.kind === 'pending' || st.kind === 'setup' || st.kind === 'active' || st.kind === 'paused') return this.open(phone, user);
    const cfg = this.a.cfg();
    const web = `${this.c.siteUrl.replace(/\/+$/, '')}/ambassadors/#apply`;
    const form = cfg.applyWhatsApp ? this.c.applyForm() : null;
    if (form) {
      const status = await this.c.send(phone, {
        kind: 'form', header: '🤝 Ambassador application', text: '4 short steps: about you, where you are, your reach, then check and send.\n\nWe reply within 24 hours.',
        cta: 'Apply now', flowId: form.flowId, mode: form.mode, flowToken: 'amb-apply', screen: 'ABOUT', data: { name: user.display_name ?? '' },
      });
      if (status !== 'FAILED') return;
      await this.c.formRefused('ambApply', phone);
    }
    if (!cfg.applyWeb) return this.c.send(phone, { kind: 'text', text: 'Applications are closed for now. Please check back soon.' });
    return this.c.send(phone, { kind: 'text', text: `🤝 Apply here, it takes about 2 minutes:\n${web}\n\nWe reply on WhatsApp within 24 hours.` });
  }

  /** The application form was sent. */
  async formSubmitted(phone: string, user: User, f: Record<string, any>): Promise<unknown> {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []);
    try {
      const r = await this.a.apply({
        fullName: String(f.name ?? ''), phone, email: f.email || null, state: f.state ?? null, city: f.city ?? null, community: f.community || null,
        knows: list(f.knows), channels: list(f.channels), handle: f.handle || null, reach: f.reach ?? null,
        sellsOnline: f.sells === 'yes' ? true : f.sells === 'no' ? false : null, why: f.why || null,
      }, 'whatsapp', user.id);
      return this.c.send(phone, { kind: 'buttons', text: r.already ? '⏳ We already have your application. We reply within 24 hours.' : '✅ *Application sent.*\n\nWe\'ll reply on WhatsApp within 24 hours.', buttons: [{ id: 'menu:open', title: 'Main menu' }] });
    } catch (e) {
      if (!(e instanceof AmbassadorError)) throw e;
      return this.c.send(phone, { kind: 'buttons', text: `😕 ${e.message}`, buttons: [{ id: 'amb:apply', title: 'Try again' }] });
    }
  }

  // ---------- setup, one step at a time ----------
  async setup(phone: string, user: User): Promise<unknown> {
    const amb = await this.a.get(user.id);
    if (!amb) return this.open(phone, user);
    if (amb.status !== 'SETUP') return this.screen(phone, user);
    const step = await this.a.setupStep(user.id);
    if (step === 'kyc') return this.c.startKyc(phone, user, { kind: 'button', id: 'amb:setup' });
    if (step === 'bank') {
      await this.c.send(phone, { kind: 'text', text: '🏦 *Where we pay you*\n\nYour earnings go to a bank account in your own name, once a month.', noMenu: true });
      return this.c.askBank(phone, 'amb:setup');
    }
    if (step === 'term') return this.askTerm(phone, false);
    if (step === 'name') {
      await this.c.save(phone, 'AMB_NAME');
      return this.c.send(phone, { kind: 'text', text: '🔗 *Your link*\n\nType the name for your link, like *tobi* or *tobi-unilag*.\n\nYour link will be hoolam.com/a/your-name. It\'s yours for good: nobody else can ever use it.', noMenu: true });
    }
    // every step done: a photo (optional), then they're live
    return this.askPhoto(phone, true);
  }

  private async askTerm(phone: string, switching: boolean): Promise<unknown> {
    const terms = this.a.cfg().terms;
    return this.c.send(phone, {
      kind: 'buttons',
      text: `🗓️ *${switching ? 'Switch your term' : 'Choose your term'}*\n\nHow long would you like to be an ambassador before you renew? It rolls over by itself, and we remind you ${this.a.cfg().noticeDays} days before it ends.${switching ? '\n\nA switch starts from your next term.' : ''}\n\n${PERF}`,
      buttons: terms.map((n) => ({ id: `amb:term:${n}`, title: `${n} months` })),
    });
  }

  private async askPhoto(phone: string, setup: boolean): Promise<unknown> {
    await this.c.save(phone, 'AMB_PHOTO', { setup });
    return this.c.send(phone, {
      kind: 'buttons',
      art: ART.picture('photo-tips'),
      text: `📸 *Add your photo${setup ? ' (optional)' : ''}*\n\nSend a clear photo of your face. It shows on your link with your first name, so people know it's you.\n\nBy sending it, you agree your photo and first name show on your link.`,
      buttons: setup ? [{ id: 'amb:nophoto', title: 'Skip for now' }] : [{ id: 'amb:screen', title: 'Cancel' }],
    });
  }

  /** Typed answers while we wait for something (AMB_NAME, AMB_PHOTO, AMB_ASK). */
  async typed(phone: string, user: User, state: string, data: Record<string, any>, m: { type: string; text: string; mediaId: string | null }): Promise<unknown> {
    if (state === 'AMB_NAME') {
      try { await this.a.claimName(user.id, m.text); }
      catch (e) {
        if (!(e instanceof AmbassadorError)) throw e;
        return this.c.send(phone, { kind: 'text', text: `😕 ${e.message}`, noMenu: true });
      }
      const amb = await this.a.get(user.id);
      await this.c.send(phone, { kind: 'text', text: `✅ Your link: *${this.a.linkText(amb!.slug!)}*`, noMenu: true });
      return this.setup(phone, user);
    }
    if (state === 'AMB_PHOTO') {
      if (m.type !== 'image' || !m.mediaId) {
        if (/^(skip|later|no|cancel)$/i.test(m.text.trim())) return data.setup ? this.button(phone, user, 'nophoto') : this.screen(phone, user);
        return this.c.send(phone, { kind: 'text', text: 'Please send a photo (📎 → Photo), or tap Skip.', noMenu: true });
      }
      const bytes = await this.c.download(m.mediaId).catch(() => null);
      if (!bytes) return this.c.send(phone, { kind: 'text', text: 'We couldn\'t get that photo. Please send it again.', noMenu: true });
      try { await this.a.setPhoto(user.id, bytes); }
      catch (e) { return this.c.send(phone, { kind: 'text', text: `😕 ${(e as Error).message}`, noMenu: true }); }
      await this.c.save(phone, 'IDLE');
      if (data.setup) return this.live(phone, user);
      return this.c.send(phone, { kind: 'buttons', text: '✅ Photo saved. It shows on your link in about 2 minutes.', buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }] });
    }
    if (state === 'AMB_ASK') {
      const next: 'buy' | 'sell' = data.next === 'sell' ? 'sell' : 'buy';
      await this.a.markAsked(user.id);
      await this.c.save(phone, 'IDLE');
      const r = await this.a.attribute(user, m.text, 'code');
      if (r === 'ok') { const a = await this.a.bySlug(m.text); await this.c.send(phone, { kind: 'text', text: `✅ Thanks! We've noted that ${a?.firstName ?? 'they'} sent you.`, noMenu: true }); }
      else if (r === 'unknown') await this.c.send(phone, { kind: 'text', text: 'We couldn\'t find that ambassador, so we\'ll carry on.', noMenu: true });
      return this.c.continueTo(phone, user, next);
    }
    return this.c.menu(phone, user);
  }

  /** Before someone's very first order: "Did an ambassador send you?" (once). Returns true when asked. */
  async maybeAsk(phone: string, user: User, next: 'buy' | 'sell'): Promise<boolean> {
    if (!(await this.a.shouldAsk(user.id))) return false;
    await this.c.save(phone, 'AMB_ASK', { next });
    await this.c.send(phone, {
      kind: 'buttons',
      text: '🤝 Quick one: did a *Hoolam ambassador* send you?\n\nType their name (the part after hoolam.com/a/), or tap Skip.',
      buttons: [{ id: `amb:skip:${next}`, title: 'Skip' }],
    });
    return true;
  }

  /** Someone new arrived with "… sent me (TOBI)". */
  async arrived(user: User, slug: string): Promise<void> {
    const r = await this.a.attribute(user, slug, 'link');
    if (r === 'ok' || r === 'not-new') await this.a.markAsked(user.id);
  }

  /** Taps on amb:… buttons. */
  async button(phone: string, user: User, what: string, arg?: string): Promise<unknown> {
    switch (what) {
      case 'apply': return this.apply(phone, user);
      case 'setup': return this.setup(phone, user);
      case 'screen': await this.c.save(phone, 'IDLE'); return this.open(phone, user);
      case 'term': {
        const amb = await this.a.get(user.id);
        try { await this.a.setTerm(user.id, Number(arg)); }
        catch (e) { if (e instanceof AmbassadorError) return this.c.send(phone, { kind: 'text', text: e.message }); throw e; }
        if (amb?.status === 'SETUP') return this.setup(phone, user);
        const now = await this.a.get(user.id);
        return this.c.send(phone, { kind: 'buttons', text: now?.next_term_months ? `✅ From your next term (after ${dayText(new Date(now.term_ends_at!))}), it's *${now.next_term_months} months*.` : `✅ You'll stay on *${now?.term_months} months*.`, buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }] });
      }
      case 'switch': return this.askTerm(phone, true);
      case 'renew': {
        await this.a.renew(user.id);
        const now = await this.a.get(user.id);
        return this.c.send(phone, { kind: 'buttons', text: `✅ Renewed. Your *${now?.term_months}-month* term rolls over on ${now?.term_ends_at ? dayText(new Date(now.term_ends_at)) : 'its end date'}.`, buttons: [{ id: 'menu:amb', title: '🤝 Ambassador' }] });
      }
      case 'end':
        return this.c.send(phone, { kind: 'buttons', text: '⚠️ *End your ambassador term now?*\n\nYou stop earning from today. Everything you\'ve earned is paid to your account, whatever the amount.', buttons: [{ id: 'amb:endyes', title: 'Yes, end it' }, { id: 'menu:amb', title: 'Keep going' }] });
      case 'endyes': await this.a.end(user.id, 'Ended by the ambassador'); return;
      case 'nophoto': await this.c.save(phone, 'IDLE'); return this.live(phone, user);
      case 'photo': return this.askPhoto(phone, false);
      case 'share': return this.share(phone, user);
      case 'details': return this.details(phone, user);
      case 'web': return this.c.send(phone, { kind: 'text', text: `🌐 *Your dashboard on the web*\n\n${this.a.dashboardUrl()}\n\nSign in with this WhatsApp number. We send you a code here.` });
      case 'signout': await this.a.signOutAll(user.id); return this.c.send(phone, { kind: 'text', text: '🔐 Done. Everyone is signed out of your ambassador dashboard. Sign in again with a new code any time.' });
      case 'skip': {
        await this.a.markAsked(user.id);
        await this.c.save(phone, 'IDLE');
        return this.c.continueTo(phone, user, arg === 'sell' ? 'sell' : 'buy');
      }
    }
    return this.open(phone, user);
  }

  /** Setup done: active, and here's how it works. */
  private async live(phone: string, user: User): Promise<unknown> {
    await this.a.activateIfReady(user.id);
    const o = await this.a.overview(user.id);
    if (!o || o.status !== 'ACTIVE') return this.setup(phone, user);
    const cfg = this.a.cfg();
    return this.c.send(phone, {
      kind: 'buttons',
      art: ART.ambWelcome(o.firstName || '', o.linkText ?? null),
      text: `🎉 *You're live, ${o.firstName || 'ambassador'}!*\n\nYour link: *${o.linkText}*\n\n*How you earn*\n🏷️ ${pct(o.pct.seller)} of what Hoolam earns on orders from sellers you bring\n🛒 ${pct(o.pct.buyer)} on orders from buyers you bring` +
        (cfg.bonusMinor ? `\n💰 ${this.m(cfg.bonusMinor)} for each new seller, once they complete ${cfg.bonusOrders} orders` : '') +
        `\n🏦 Paid on the ${ordinal(cfg.payoutDay)} of every month, from ${this.m(cfg.payoutMinMinor)}\n\n${PERF}\n\n🚫 Never collect money for Hoolam or ask anyone for a PIN or code. All money goes through Hoolam only.`,
      buttons: [{ id: 'amb:share', title: '🔗 Share my link' }, { id: 'menu:amb', title: '🤝 Ambassador' }],
    });
  }

  /** The main screen for an active (or paused) ambassador. */
  async screen(phone: string, user: User): Promise<unknown> {
    const o = await this.a.overview(user.id);
    if (!o) return this.open(phone, user);
    if (o.status === 'SETUP') return this.setup(phone, user);
    const s = o.summary;
    const head = o.status === 'PAUSED' ? '⏸️ *Paused for now*: new orders don\'t earn.\n\n' : o.status === 'ENDED' ? '👋 *Your term has ended.*\n\n' : '';
    const near = o.people.sellers.filter((x) => !x.bonus && x.orders > 0 && x.toBonus > 0).length;
    const text = `🤝 *${o.firstName || 'You'}, Hoolam ambassador*\n\n${head}` +
      `💰 *This month:* ${this.m(s.earned)}\n✅ *Paid so far:* ${this.m(o.totals.paidMinor)}\n` +
      (o.status === 'ENDED' ? (o.totals.owedMinor ? `📅 *Still to pay:* ${this.m(o.totals.owedMinor)}\n` : '') : `📅 *Next payout:* ${dayText(new Date(o.next.date + 'T12:00:00Z'))} · ${this.m(o.totals.owedMinor)}${o.next.belowMin ? ` (from ${this.m(o.next.minMinor)})` : ''}\n`) +
      (o.totals.pendingMinor ? `⏳ *On the way:* ${this.m(o.totals.pendingMinor)} from ${o.totals.pendingOrders} order${o.totals.pendingOrders === 1 ? '' : 's'} in progress\n` : '') +
      `\n👥 *Your people*\n🏷️ Sellers: *${o.people.sellers.length}* (${o.people.activeSellers} active)\n🛒 Buyers: *${o.people.buyers.length}*\n` +
      (near ? `⏳ ${near} seller${near === 1 ? '' : 's'} close to your ${this.m(o.bonus.amountMinor)} bonus\n` : '') +
      (o.linkText && o.status !== 'ENDED' ? `\n🔗 ${o.linkText}\n` : '') +
      (o.term && o.status !== 'ENDED' ? `🗓️ Term: ${o.term} months · renews ${o.termEnds ? dayText(new Date(o.termEnds)) : ''}${o.nextTerm ? ` (then ${o.nextTerm} months)` : ''}\n` : '') +
      (o.status === 'ACTIVE' ? `\n${PERF}` : '');
    return this.c.send(phone, {
      kind: 'buttons', text: text.trim(),
      buttons: o.status === 'ENDED' ? [{ id: 'amb:details', title: '📊 Details' }, { id: 'amb:web', title: '🌐 Web dashboard' }]
        : [{ id: 'amb:share', title: '🔗 Share my link' }, { id: 'amb:details', title: '📊 Details' }, { id: 'amb:web', title: '🌐 Web dashboard' }],
    });
  }

  /** A message they can forward to their status, groups and chats. */
  private async share(phone: string, user: User): Promise<unknown> {
    const amb = await this.a.get(user.id);
    if (!amb?.slug || amb.status !== 'ACTIVE') return this.open(phone, user);
    await this.c.send(phone, { kind: 'text', text: '👇 Forward the next message (the picture and its words) to your WhatsApp status, groups and chats.', noMenu: true });
    return this.c.send(phone, {
      kind: 'text', noMenu: true,
      art: ART.ambShare(firstOf(user.display_name) || '', this.a.linkText(amb.slug), amb.area ?? null, user.id), clips: CLIP.ambShare,
      text: `Buying or selling on WhatsApp? Use Hoolam 🛡️\nYour money is held safely until you get what you ordered. No more "pay first and pray".\n\nStart here 👉 ${this.a.linkUrl(amb.slug)}`,
    });
  }

  /** Details: the live form with a month picker, or this month in the chat. */
  private async details(phone: string, user: User): Promise<unknown> {
    const form = this.c.detailsForm();
    if (form) {
      const status = await this.c.send(phone, {
        kind: 'form', header: '📊 Your earnings', text: 'Any month: every naira, your people and your account.', cta: 'Open details',
        flowId: form.flowId, mode: form.mode, screen: 'MONTH', live: true, flowToken: detailsToken(this.c.secret, phone),
      });
      if (status !== 'FAILED') return;
      await this.c.formRefused('ambDetails', phone);
    }
    const o = await this.a.overview(user.id);
    if (!o) return this.open(phone, user);
    return this.c.send(phone, { kind: 'text', text: `${detailsText(this.a, o).slice(0, 3500)}\n\n🌐 Other months: ${this.a.dashboardUrl()}` });
  }
}

/** One month as text: the summary, then each earning with its maths. */
export function detailsText(a: Ambassadors, o: NonNullable<Awaited<ReturnType<Ambassadors['overview']>>>): string {
  const s = o.summary;
  const lines = o.lines.map((l) => {
    const when = new Date(l.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
    const maths = l.kind === 'BONUS' ? `${o.bonus.orders}-order bonus` : `${pct(l.percent ?? 0)} of ${a.money(l.revenueMinor)}`;
    const status = l.status === 'HELD' ? ` · on hold: ${l.holdReason}` : l.status === 'VOID' ? ' · cancelled' : l.paid ? ' · paid' : '';
    return `• ${when} · ${l.who} · ${l.code}\n   ${maths} = *${a.money(l.amountMinor)}*${status}`;
  });
  return `📊 *${o.monthLabel}*\n\n💰 Earned: *${a.money(s.earned)}*\n🏷️ From sellers: ${a.money(s.fromSellers)}\n🛒 From buyers: ${a.money(s.fromBuyers)}\n🎁 Bonuses: ${a.money(s.bonuses)}` +
    (s.held ? `\n⏸️ On hold: ${a.money(s.held)} (the team is checking)` : '') +
    `\n\n${lines.length ? lines.join('\n') : 'No earnings yet this month.'}`;
}

const pct = (n: number) => `${Number(n.toFixed(2)).toString()}%`;
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// ---------------------------------------------------------------------------------------------
// The form token for "Details": who opened it. Signed, so nobody can open someone else's earnings.
// ---------------------------------------------------------------------------------------------
export function detailsToken(secret: string, phone: string, ttlHours = 72): string {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const body = `a1.${phone.replace(/\D/g, '')}.${exp}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22)}`;
}
export function readDetailsToken(secret: string, token: string): string | null {
  const p = String(token ?? '').split('.');
  if (p.length !== 4 || p[0] !== 'a1') return null;
  const body = p.slice(0, 3).join('.');
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22)), got = Buffer.from(p[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(p[2]) * 1000 < Date.now()) return null;
  return '+' + p[1];
}

// ---------------------------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------------------------
const ex = (v: unknown) => ({ type: typeof v === 'boolean' ? 'boolean' : 'string', __example__: v });
const exArr = (v: string[]) => ({ type: 'array', items: { type: 'string' }, __example__: v });
const exList = (v: Record<string, string>[]) => ({ type: 'array', items: { type: 'object', properties: Object.fromEntries(Object.keys(v[0]!).map((k) => [k, { type: 'string' }])) }, __example__: v });
const opts = (o: Record<string, string>) => Object.entries(o).map(([id, title]) => ({ id, title }));

/** The application: 4 short screens (static: the answers arrive in the webhook when they tap Send). */
export function ambApplyFlowJson() {
  const carry = (names: string[]) => Object.fromEntries(names.map((n) => [n, `\${data.${n}}`]));
  return {
    version: '7.3',
    screens: [
      {
        id: 'ABOUT', title: 'About you (1 of 4)', data: { name: ex('Tobi Adeyemi') },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'f', 'init-values': { name: '${data.name}' },
          children: [
            { type: 'TextSubheading', text: 'Become a Hoolam ambassador' },
            { type: 'TextBody', text: 'Bring sellers and buyers to Hoolam and earn from every order they complete. Paid monthly.' },
            { type: 'TextInput', name: 'name', label: 'Full name', required: true, 'min-chars': 3, 'max-chars': 80 },
            { type: 'TextInput', name: 'email', label: 'Email (optional)', 'input-type': 'email', required: false },
            { type: 'Footer', label: 'Next', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'WHERE' }, payload: { name: '${form.name}', email: '${form.email}' } } },
          ],
        }] },
      },
      {
        id: 'WHERE', title: 'Where you are (2 of 4)', data: { name: ex('Tobi Adeyemi'), email: ex('') },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'f',
          children: [
            { type: 'Dropdown', name: 'state', label: 'State', required: true, 'data-source': NG_STATES.map((s) => ({ id: s, title: s })) },
            { type: 'TextInput', name: 'city', label: 'City or area', required: true, 'max-chars': 60, 'helper-text': 'For example: Yaba, Lagos' },
            { type: 'TextInput', name: 'community', label: 'Campus, market or community (optional)', required: false, 'max-chars': 80, 'helper-text': 'For example: UNILAG, Balogun Market' },
            { type: 'Footer', label: 'Next', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'REACH' }, payload: { ...carry(['name', 'email']), state: '${form.state}', city: '${form.city}', community: '${form.community}' } } },
          ],
        }] },
      },
      {
        id: 'REACH', title: 'Your reach (3 of 4)', data: { name: ex('Tobi Adeyemi'), email: ex(''), state: ex('Lagos'), city: ex('Yaba'), community: ex('UNILAG') },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'f',
          children: [
            { type: 'CheckboxGroup', name: 'knows', label: 'Who do you know well?', required: true, 'data-source': opts(AMB_KNOWS) },
            { type: 'CheckboxGroup', name: 'channels', label: 'Where will you share Hoolam?', required: true, 'data-source': opts(AMB_CHANNELS) },
            { type: 'TextInput', name: 'handle', label: 'Your main social handle (optional)', required: false, 'max-chars': 60, 'helper-text': 'For example: @tobi.styles' },
            { type: 'RadioButtonsGroup', name: 'reach', label: 'Roughly how many people can you reach?', required: true, 'data-source': opts(AMB_REACH) },
            { type: 'RadioButtonsGroup', name: 'sells', label: 'Do you sell online yourself?', required: true, 'data-source': [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }] },
            { type: 'Footer', label: 'Next', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'CHECK' }, payload: { ...carry(['name', 'email', 'state', 'city', 'community']), knows: '${form.knows}', channels: '${form.channels}', handle: '${form.handle}', reach: '${form.reach}', sells: '${form.sells}' } } },
          ],
        }] },
      },
      {
        id: 'CHECK', title: 'Check and send (4 of 4)', terminal: true,
        data: { name: ex('Tobi Adeyemi'), email: ex(''), state: ex('Lagos'), city: ex('Yaba'), community: ex('UNILAG'), knows: exArr(['vendors']), channels: exArr(['status']), handle: ex(''), reach: ex('500_2000'), sells: ex('no') },
        layout: { type: 'SingleColumnLayout', children: [{
          type: 'Form', name: 'f',
          children: [
            { type: 'TextCaption', text: 'Your name' }, { type: 'TextBody', text: '${data.name}', 'font-weight': 'bold' },
            { type: 'TextCaption', text: 'Where you are' }, { type: 'TextBody', text: '${data.city}' }, { type: 'TextBody', text: '${data.state}' },
            { type: 'TextCaption', text: 'Something to fix? Use the back arrow at the top.' },
            { type: 'TextArea', name: 'why', label: 'Why do you want to join? (optional)', required: false, 'max-length': 600 },
            { type: 'OptIn', name: 'agree', label: 'I agree to the Ambassador agreement', required: true, 'on-click-action': { name: 'open_url', url: 'https://hoolam.com/legal/ambassadors/' } },
            { type: 'Footer', label: 'Send application', 'on-click-action': { name: 'complete', payload: { ...carry(['name', 'email', 'state', 'city', 'community', 'knows', 'channels', 'handle', 'reach', 'sells']), why: '${form.why}', agree: '${form.agree}' } } },
          ],
        }] },
      },
    ],
  };
}
export const ambApplyFlowName = (json: object = ambApplyFlowJson()) => 'hoolam_amb_apply_' + createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 8);

/** Details: a live form (our endpoint fills it): any month's earnings, their people, their account. */
export function ambDetailsFlowJson() {
  return {
    version: '7.3',
    data_api_version: '3.0',
    routing_model: { MONTH: ['PEOPLE', 'ACCOUNT'] },
    screens: [
      {
        id: 'MONTH', title: 'Your earnings',
        data: { months: exList([{ id: '2026-10', title: 'October 2026' }]), month: ex('2026-10'), headline: ex('₦8,450 earned'), summary: ex('From sellers ₦7,000 · buyers ₦450 · bonuses ₦1,000'), lines: ex('• 12 Oct · Mama Bella · HL-4821\n   20% of ₦1,050 = ₦210') },
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'Dropdown', name: 'month', label: 'Month', required: true, 'data-source': '${data.months}', 'init-value': '${data.month}', 'on-select-action': { name: 'data_exchange', payload: { op: 'month', month: '${form.month}' } } },
          { type: 'TextHeading', text: '${data.headline}' },
          { type: 'TextBody', text: '${data.summary}' },
          { type: 'TextBody', text: '${data.lines}' },
          { type: 'EmbeddedLink', text: 'Your account and term', 'on-click-action': { name: 'data_exchange', payload: { op: 'account' } } },
          { type: 'Footer', label: 'Your people', 'on-click-action': { name: 'data_exchange', payload: { op: 'people' } } },
        ] },
      },
      {
        id: 'PEOPLE', title: 'Your people', terminal: true,
        data: { heading: ex('12 sellers (7 active) · 31 buyers'), sellers: ex('Mama Bella Shoes · 9 orders · active'), buyers: ex('Chidi · 4 orders') },
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'TextSubheading', text: '${data.heading}' },
          { type: 'TextCaption', text: 'Sellers' }, { type: 'TextBody', text: '${data.sellers}' },
          { type: 'TextCaption', text: 'Buyers' }, { type: 'TextBody', text: '${data.buyers}' },
          { type: 'Footer', label: 'Done', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      },
      {
        id: 'ACCOUNT', title: 'Your account', terminal: true,
        data: { account: ex('Link: hoolam.com/a/tobi') },
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'TextBody', text: '${data.account}' },
          { type: 'TextCaption', text: 'To switch or end your term, change your photo or payout account, go back to the chat or use your web dashboard.' },
          { type: 'Footer', label: 'Done', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      },
    ],
  };
}

/** Answers the Details form (through the encrypted endpoint in app.ts). Never throws. */
export class AmbassadorDetailsFlow {
  constructor(private readonly a: Ambassadors, private readonly secret: string, private readonly log?: (l: string) => void) {}

  async handle(req: { action?: string; screen?: string; data?: Record<string, any>; flow_token?: string }): Promise<Record<string, unknown>> {
    if (req.action === 'ping') return { data: { status: 'active' } };
    if (req.data?.error || req.data?.error_message) { this.log?.(`ambassador details form: WhatsApp REJECTED our answer: ${JSON.stringify(req.data).slice(0, 300)}`); return { data: { acknowledged: true } }; }
    const phone = readDetailsToken(this.secret, req.flow_token ?? '');
    const u = phone ? (await this.a.db.query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0] : null;
    const wrap = (screen: string, data: Record<string, unknown>) => ({ version: '3.0', screen, data });
    const expired = wrap('MONTH', { months: [{ id: monthKey(), title: monthLabel(monthKey()) }], month: monthKey(), headline: '⌛ This has expired', summary: 'Open Details again from the Ambassador screen in the chat.', lines: ' ' });
    if (!u) return expired;
    try {
      const op = req.action === 'INIT' ? 'month' : String(req.data?.op ?? 'month');
      if (op === 'people') {
        const o = (await this.a.overview(u.id))!;
        const seller = (s: typeof o.people.sellers[number]) => `• ${s.name} · ${s.orders} order${s.orders === 1 ? '' : 's'}${s.active ? ' · active' : ''}${!s.bonus && s.toBonus > 0 && s.orders > 0 ? ` · ${s.toBonus} more for your bonus` : s.bonus ? ' · bonus earned' : ''}`;
        return wrap('PEOPLE', {
          heading: `${o.people.sellers.length} seller${o.people.sellers.length === 1 ? '' : 's'} (${o.people.activeSellers} active) · ${o.people.buyers.length} buyer${o.people.buyers.length === 1 ? '' : 's'}`,
          sellers: o.people.sellers.slice(0, 60).map(seller).join('\n') || 'No sellers yet. Share your link with people who sell online.',
          buyers: o.people.buyers.slice(0, 60).map((b) => `• ${b.name} · ${b.orders} order${b.orders === 1 ? '' : 's'}`).join('\n') || 'No buyers yet.',
        });
      }
      if (op === 'account') {
        const o = (await this.a.overview(u.id))!;
        return wrap('ACCOUNT', { account: [
          o.linkText ? `🔗 Link: ${o.linkText}` : null,
          `🏷️ Your share on sellers: ${o.pct.seller}%`, `🛒 Your share on buyers: ${o.pct.buyer}%`,
          o.term ? `🗓️ Term: ${o.term} months, renews ${o.termEnds ? dayText(new Date(o.termEnds)) : ''}${o.nextTerm ? ` (then ${o.nextTerm} months)` : ''}` : null,
          o.bank ? `🏦 Paid to: ${o.bank.name} ••••${o.bank.last4}` : '🏦 No payout account yet',
          `📸 Photo: ${o.photo ? 'added' : 'not added'}`,
        ].filter(Boolean).join('\n') });
      }
      const o = (await this.a.overview(u.id, String(req.data?.month ?? monthKey())))!;
      const s = o.summary;
      const lines = o.lines.slice(0, 80).map((l) => {
        const when = new Date(l.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
        const maths = l.kind === 'BONUS' ? `${o.bonus.orders}-order bonus` : `${l.percent}% of ${this.a.money(l.revenueMinor)}`;
        return `• ${when} · ${l.who} · ${l.code}\n   ${maths} = ${this.a.money(l.amountMinor)}${l.status === 'HELD' ? ` (on hold: ${l.holdReason})` : l.status === 'VOID' ? ' (cancelled)' : l.paid ? ' (paid)' : ''}`;
      });
      return wrap('MONTH', {
        months: o.months.map((k) => ({ id: k, title: monthLabel(k) })), month: o.month,
        headline: `${this.a.money(s.earned)} earned`,
        summary: `From sellers ${this.a.money(s.fromSellers)} · buyers ${this.a.money(s.fromBuyers)} · bonuses ${this.a.money(s.bonuses)}${s.held ? ` · on hold ${this.a.money(s.held)}` : ''}`,
        lines: lines.join('\n') || 'No earnings this month.',
      });
    } catch (e) {
      this.log?.(`ambassador details form error: ${(e as Error).stack ?? e}`);
      return expired;
    }
  }
}
