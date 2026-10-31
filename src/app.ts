import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { DealError, DealService, isVerified, viewKey, type Deal } from './deals/service.js';
import { FakeProvider } from './payments/fake.js';
import type { PaymentProvider } from './payments/provider.js';
import { pendingEvents, processEvent, storeEvent, type Handler } from './webhooks.js';
import { FakeKycChecker, KycService, NoKycChecker, PremblyChecker, type KycChecker } from './kyc.js';
import { buyFlowJson, sellFlowJson } from './whatsapp/buy-flow.js';
import { kycFlowJson } from './whatsapp/kyc-flow.js';
import { ALL_TEMPLATES, ensureAmbApplyFlow, ensureAmbDetailsFlow, ensureSignInTemplate, SIGN_IN_CODE, ensureBuyEditFlow, ensureBuyFlow, ensureKycFlow, ensureOrderFlow, ensureOrdersFlow, ensureSellEditFlow, ensureLiveFlow, ensureSellFlow, ensureStaticFlow, ensureTemplate, fetchTemplateStatuses, registerFlowsKey, syncAutomation } from './whatsapp/automation.js';
import { decryptRequest, encryptResponse, FlowDecryptError, flowKeys, type FlowKeys } from './whatsapp/flow-crypto.js';
import { OrdersFlow, ordersFlowJson, signToken, type Entry } from './whatsapp/orders-flow.js';
import { FormRegistry, type FormKey, type FormUse } from './whatsapp/forms.js';
import { COMPANY } from './receipt.js';
import { Media } from './whatsapp/media.js';
import { isBot, Trust } from './trust.js';
import { CampaignLinks } from './links.js';
import { Ambassadors } from './ambassadors.js';
import { Market, type Listing } from './market/market.js';
import { Activity } from './activity.js';
import { Sources } from './sources.js';
import { readToken } from './whatsapp/orders-flow.js';
import { readPayoutToken } from './whatsapp/more-forms.js';
import { itemPage } from './item-page.js';
import { pageFormJson, pageFormName, payoutFormJson, payoutFormName, problemFormJson, problemFormName, rateFormJson, rateFormName } from './whatsapp/more-forms.js';
import { editItemFormJson, editItemFormName, listFormJson, listFormName, marketOrderFormJson, marketOrderFormName } from './market/market-forms.js';
import { categoryTitle } from './deals/categories.js';
import { AmbassadorDetailsFlow } from './whatsapp/amb-flow.js';
import { registerAmbassadorRoutes } from './amb-routes.js';
import { Settings } from './settings.js';
import { MediaError, SiteMedia } from './site-media.js';
import { homeVersions } from './site-versions.js';
import { SiteSync } from './site-sync.js';
import { registerConsoleApi } from './console/api.js';
import { LiveChat } from './livechat.js';
import { registerLiveChatRoutes } from './livechat-routes.js';
import { registerConsoleStatic } from './console/static.js';
import { StaffAuth } from './console/staff.js';
import { audit, type Actor } from './console/audit.js';
import { buyWhatsApp, notFoundPage, sellerPage } from './public-page.js';
import { orderPage } from './order-page.js';
import sharp from 'sharp';
import { sellerShareImage } from './share-image.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Messenger } from './whatsapp/client.js';
import { configureMessages, msg } from './whatsapp/messages.js';
import { ChatArt } from './chat-art/index.js';
import { setMarkSource } from './brand-mark.js';
import { SiteShow } from './site-show.js';
import { ART, stepOf } from './chat-art/build.js';
import { localPhone } from './phone.js';
import { formatMoney } from './money.js';
import { Conversation } from './whatsapp/flow.js';
import { parseInbound, parseStatuses, verifyMetaSignature, type Inbound } from './whatsapp/inbound.js';

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }

export interface AppDeps { config: Config; db: Db; provider: PaymentProvider; log?: (line: string) => void }

export function buildApp({ config: c, db, provider, log = console.log }: AppDeps) {
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1_000_000, trustProxy: true });
  const messenger = new Messenger(db, {
    dryRun: c.WHATSAPP_DRY_RUN, token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, log,
  });
  for (const t of ALL_TEMPLATES) if (t.replaces) messenger.setTemplateReplaces(t.name, t.replaces, { params: t.replacesParams, buttons: t.replacesButtons });
  for (const t of ALL_TEMPLATES) if (t.headerImage) messenger.setTemplateImageHeader(t.name);
  const media = new Media({ dryRun: c.WHATSAPP_DRY_RUN, token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION });
  const testMode = c.ALLOW_SELF_DEAL && provider.sandbox;
  // real ID checks with pretend money: the pretend bank's account names can't match a real ID, so that match waits for real payments
  const skipAccountMatch = c.KYC === 'prembly' && c.PAYMENT_PROVIDER === 'fake';
  const trust = new Trust(db, c.TRUST_COUNT_TEST_DEALS, skipAccountMatch);
  const settings = new Settings(db, c);
  trust.statsOn = () => settings.get<boolean>('feature_seller_stats') === true; // Console → Settings → Features
  trust.videoOn = () => settings.get<boolean>('feature_seller_video') === true; // Console → Settings → Features → Seller videos
  const links = new CampaignLinks(db); // hoolam.com/<name> campaign links (Console → Settings → Links)
  // messages mention reply times and use Hoolam's number as the example: always the console's current values
  configureMessages({ repReplyMinutes: () => settings.repReplyMinutes(), problemReplyHours: () => settings.problemReplyHours(), hoolamNumber: () => settings.waNumber(),
    menuOrderCode: () => settings.get<boolean>('feature_menu_order_code') === true, menuCheckSeller: () => settings.get<boolean>('feature_menu_check_seller') === true, marketOn: () => settings.market().on });
  const siteMedia = new SiteMedia(db);
  // every picture Hoolam draws uses the uploaded logo icon (Settings → Brand), or the drawn mark when there is none
  setMarkSource(() => siteMedia.get('mark').catch(() => null));
  // the chat's pictures, voice notes, videos and stickers (Console → Settings → WhatsApp → Chat pictures and voice)
  /** Where people check an order is real (shown on new order alerts): hoolam.com/check */
  const checkText = `${(() => { try { return new URL(c.SITE_URL ?? '').host.replace(/^www\./, ''); } catch { return 'hoolam.com'; } })() || 'hoolam.com'}/check`;
  const chatArt = new ChatArt(db, {
    media, dryRun: c.WHATSAPP_DRY_RUN, log,
    live: {
      number: () => localPhone(settings.waNumber()) || null,
      ambShares: () => { const a = ambassadors.cfg(); return { seller: `${a.sellerPct}%`, buyer: `${a.buyerPct}%`, bonus: formatMoney(a.bonusMinor, c.CURRENCY) }; },
    },
  });
  messenger.setArt(chatArt);
  // the chat's pictures and voice notes on the website, and live numbers from real orders
  const siteShow = new SiteShow(db, chatArt, settings, c.CURRENCY === 'NGN' ? 100 : 1);
  const siteSync = new SiteSync(c.SITE_DEPLOY_HOOK, log);
  // ID checks: Prembly (live keys), pretend checks with pretend money, or off
  const checker: KycChecker = c.KYC === 'prembly'
    ? new PremblyChecker({ apiKey: c.PREMBLY_X_API_KEY, appId: c.PREMBLY_APP_ID || undefined, baseUrl: c.PREMBLY_BASE_URL, bvnPath: c.PREMBLY_BVN_PATH, ninPath: c.PREMBLY_NIN_PATH, log })
    : c.KYC === 'fake' ? new FakeKycChecker() : new NoKycChecker();
  const formSecret = c.WHATSAPP_APP_SECRET || c.ADMIN_TOKEN;
  const kyc = new KycService(db, checker, log, { skipAccountMatch, idSecret: formSecret });
  // the ambassador programme (Console → Settings → Features → Ambassadors)
  const ambassadors = new Ambassadors({
    db, settings, messenger, currency: c.CURRENCY, countTest: c.TRUST_COUNT_TEST_DEALS, siteUrl: c.SITE_URL || 'https://hoolam.com',
    publicBaseUrl: c.PUBLIC_BASE_URL, secret: formSecret, onSiteChange: () => siteSync.changed(), log,
  });
  if (skipAccountMatch) log('ID checks are real but money is pretend: payout account names are not matched to the ID until real payments are on');
  /** What each person does in the chat (Console → a person → Activity). */
  const activity = new Activity(db, log);
  /** Where each person came from (Console → a person → Source). */
  const sources = new Sources(db, log);
  // the Hoolam market (Features → Market): listing needs the seller's ID check and payout account
  const market = new Market({
    db, settings, currency: c.CURRENCY, testMode, log,
    verified: async (id) => !deals.kycOn || isVerified((await db.query('SELECT kyc_status, kyc_verified_at FROM users WHERE id=$1', [id])).rows[0]),
    hasBank: async (id) => !!(await db.query('SELECT 1 FROM bank_accounts WHERE user_id=$1 LIMIT 1', [id])).rowCount,
  });
  const phoneOf = async (id: string) => (await db.query('SELECT phone FROM users WHERE id=$1', [id])).rows[0]?.phone as string | undefined;
  /** Each seller hears when an item sells out (with its picture); savers hear when it's back (if that switch is on). */
  const marketSoldOut = async (ls: Listing[]) => { for (const l of ls) { const p = await phoneOf(l.seller_id); if (p && chat.mkt) await chat.mkt.notify(p, l, 'soldout').catch((e) => log(`market: ${(e as Error).message}`)); } };
  const marketBack = async (ls: Listing[]) => { if (market.cfg().backInStock) for (const l of ls) await backInStock(l).catch((e) => log(`market back in stock: ${(e as Error).message}`)); };
  const deals = new DealService({
    db, provider, messenger, media, trust, settings, kyc, currency: c.CURRENCY, maxDealMinor: c.MAX_DEAL_MINOR, waNumber: () => settings.waNumber(), payBase: c.PAY_URL,
    acceptHours: c.SELLER_ACCEPT_HOURS, testMode, orderPageBase: c.PUBLIC_BASE_URL, ambassadors, log,
    marketFees: () => settings.market().fees,
    market: { onPaid: async (id) => marketSoldOut(await market.onPaid(id)), onRefund: async (id) => marketBack(await market.onRefund(id)), outOfStock: (id) => market.outOfStock(id) },
    // new order alerts: the item photo in the Hoolam frame, with "Check it's real: hoolam.com/check"
    alertCard: (a) => chatArt.image(ART.orderRequest({ to: a.to, who: a.who, item: a.deal.item, amount: a.amount, code: a.deal.code, check: checkText, dealId: a.deal.id })),
  });
  // Every WhatsApp form, once it exists on Meta (see setupMeta), sent in the state Meta reports. A form WhatsApp
  // refuses rests for 30 minutes on its own; meanwhile the chat asks the same questions. Console → Settings → WhatsApp shows them.
  const forms = new FormRegistry(30, Date.now, log);
  if (c.WHATSAPP_DRY_RUN) for (const k of ['buy', 'buyEdit', 'sell', 'sellEdit', 'kyc', 'orders', 'order', 'ambApply', 'ambDetails', 'mkList', 'mkEdit', 'mkOrder', 'payout', 'problem', 'page', 'rate'] as FormKey[]) forms.off(k, 'WhatsApp is in dry run (WHATSAPP_DRY_RUN)');
  /** A form to send, if the console switch is on and the form is ready. */
  const formFor = (key: FormKey): FormUse | null => (settings.formsEnabled() ? forms.use(key) : null);
  /** WhatsApp refused a form we sent: rest that one form, with Meta's reason (saved with the failed message). */
  const formRefused = async (key: FormKey, phone: string) => {
    const r = await db.query(`SELECT error FROM outbound_messages WHERE phone=$1 AND status='FAILED' ORDER BY id DESC LIMIT 1`, [phone]).catch(() => null);
    forms.refused(key, r?.rows[0]?.error ?? null);
  };
  const backupForms = { list: false, one: false }; // true when Meta refused the main forms and the backups are in use
  let keys: FlowKeys | null = null;
  const setChatState = async (phone: string, state: string, data: Record<string, unknown>) => {
    await db.query(`INSERT INTO chat_sessions (phone, state, data) VALUES ($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET state=$2, data=$3, updated_at=now()`, [phone, state, JSON.stringify(data)]);
  };
  const orders = new OrdersFlow({
    db, deals, provider, currency: c.CURRENCY, secret: formSecret, setChatState, log, media, art: chatArt,
    // the buyer's order before it's sent: read from the chat, and Send / Edit / Start again work exactly like the chat buttons
    buyPreview: (phone) => chat.buyPreview(phone),
    buyAction: (phone, action, side) => chat.handle({ id: `form-${Date.now()}`, phone, name: null, type: 'button', text: '', buttonId: `${side}:${action}`, mediaId: null }),
    hoolamNumber: () => settings.waNumber(),
    backupForms: () => backupForms,
    openOrder: (user, code, screen) => openOrders(user.phone, user, { screen, code }),
    startKyc: (user, why, next) => chat.startKycFor(user, why, next),
  });
  const openOrders = async (phone: string, user: { menu_mode?: string; seller_since?: Date | null }, at: { screen: Entry; code?: string; mode?: 'buyer' | 'seller'; item?: string; totalMinor?: number; fresh?: boolean }): Promise<boolean> => {
    const key: FormKey = at.screen === 'orders' ? 'orders' : 'order';
    const form = formFor(key);
    if (!form) return false;
    const mode = at.mode ?? (at.screen === 'dispatch' || at.screen === 'code' ? 'seller' : user.seller_since && user.menu_mode === 'seller' ? 'seller' : 'buyer');
    const titles: Record<Exclude<Entry, 'preview'>, [string, string]> = {
      orders: ['📋 My orders', mode === 'seller' ? 'Everything you\'re selling: what needs you first, then the rest.' : 'Everything you\'re buying, and where your money is.'],
      order: at.mode === 'seller' ? ['🛒 New order for you', `Order *${at.code}*: see the photos and details, then accept, update the price or decline.`]
        : at.fresh ? ['🛍️ New order for you', `Order *${at.code}*: see the photos and details, then accept and pay, or decline. Your money stays with Hoolam until you're happy.`]
        : ['📋 Your order', `Order *${at.code}*: details, photos and the next step.`],
      dispatch: ['🚚 Dispatch', `Order ${at.code}: pickup, rider or waybill. It takes a minute.`],
      code: ['🔑 Handover code', `Order ${at.code}: enter the receiver's 4-digit code.`],
    };
    if (at.screen === 'preview') {
      const total = { minor: at.totalMinor ?? 0, currency: c.CURRENCY };
      const token = signToken(formSecret, phone, at.mode === 'seller' ? 'seller' : 'buyer', 'preview', '-', 24);
      const q = at.mode === 'seller' ? deals.previewDeal(total.minor, 'seller', Number.MAX_SAFE_INTEGER) : null;
      const status = await messenger.send(phone, q
        ? msg.sellReview(form.flowId, form.mode, token, at.item ?? '', deals.sellerSum({ price_minor: q.priceMinor, seller_gets_minor: q.sellerGetsMinor, fee_payer: 'SELLER' }))
        : msg.buyReview(form.flowId, form.mode, token, at.item ?? '', total));
      if (status === 'FAILED') await formRefused(key, phone);
      return status !== 'FAILED';
    }
    const [header, text] = titles[at.screen as Exclude<Entry, 'preview'>];
    const status = await messenger.send(phone, {
      kind: 'form', header, text, cta: at.screen === 'dispatch' ? 'Dispatch now' : at.screen === 'code' ? 'Enter code' : at.screen === 'order' ? 'View order' : 'Open my orders',
      flowId: form.flowId, mode: form.mode, screen: at.screen === 'orders' ? 'FILTER' : 'ORDER', live: true,
      flowToken: signToken(formSecret, phone, mode, at.screen, at.code ?? '-'),
    });
    if (status === 'FAILED') await formRefused(key, phone);
    return status !== 'FAILED';
  };

  const chat = new Conversation({
    db, deals, provider, messenger, currency: c.CURRENCY, testMode, log, trust, publicBaseUrl: c.PUBLIC_BASE_URL, media,
    buyForm: () => formFor('buy'), sellForm: () => formFor('sell'),
    buyEditForm: () => formFor('buyEdit'), sellEditForm: () => formFor('sellEdit'),
    onFormRefused: (key, phone) => formRefused(key, phone), // only that form rests, then it's tried again
    ordersForm: { open: openOrders },
    kyc, kycForm: () => formFor('kyc'),
    // Hoolam's contact card, once on someone's first message (so they know it's really us)
    contactCard: () => {
      const phone = settings.waNumber();
      if (!/^\d{8,15}$/.test(phone)) return null;
      return { name: 'Hoolam', phone, org: COMPANY.legalName, email: settings.contact().email || undefined, url: (c.SITE_URL || 'https://hoolam.com').replace(/\/$/, '') };
    },
    hoolamNumber: () => settings.waNumber(),
    activity, sources, market, marketForm: (k) => formFor(k), extraForm: (k) => formFor(k), problemHours: () => settings.problemReplyHours(), itemUrl: (code) => `${c.PUBLIC_BASE_URL.replace(/\/$/, '')}/i/${code}`,
    ambassadors, ambApplyForm: () => formFor('ambApply'), ambDetailsForm: () => formFor('ambDetails'),
    onAmbFormRefused: (key, phone) => formRefused(key, phone), formSecret, siteUrl: c.SITE_URL || 'https://hoolam.com',
  });
  if (chat.mkt) chat.mkt.onBackInStock = (l) => void marketBack([l]);
  /** "Back in stock" to people who saved it and said yes to updates (Features → Market → Back in stock). */
  async function backInStock(l: Listing) {
    if (!chat.mkt) return;
    for (const w of await market.waitingFor(l.id)) {
      await chat.mkt.backInStock(w.phone, l);
      await market.told(w.user_id, l.id);
    }
  }
  const ambDetails = new AmbassadorDetailsFlow(ambassadors, formSecret, log);

  // Keep the exact bytes of every JSON body: webhook signatures are computed over them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });

  // ---------- handlers used by both the live webhook and the retry worker ----------
  const handlers: Record<string, Handler> = {
    whatsapp: async (m: Inbound) => { await chat.handle(m); return 'done'; },
    payments: async (ev: { kind: string; providerReference?: string; reference?: string }) => {
      if (ev.kind === 'collection' && ev.providerReference) {
        const r = await deals.handleCollection(ev.providerReference);
        return r === 'pending' ? 'retry' : 'done';
      }
      if (ev.kind === 'payout' && ev.reference) {
        const check = await provider.checkPayout(ev.reference);
        await deals.applyPayoutResult(ev.reference, check);
        return check.status === 'SUBMITTED' ? 'retry' : 'done';
      }
      return 'done';
    },
  };

  const runSoon = (source: string, id: number) => setImmediate(() => { void processEvent(db, id, handlers[source]!, log); });

  // ---------- health ----------
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, provider: provider.name, whatsapp: c.WHATSAPP_DRY_RUN ? 'dry-run' : 'live', testMode };
  });

  // ---------- for the landing page (a separate static site) ----------
  // Live fees, deal limit and WhatsApp number, so the site's calculator always matches the bot.
  app.get('/site.json', async (_req, reply) => {
    const p = settings.pricing();
    const unit = c.CURRENCY === 'NGN' ? 100 : 1;
    return reply.header('access-control-allow-origin', '*').header('cache-control', 'public, max-age=120').send({
      currency: c.CURRENCY, whatsapp: settings.waNumber(),
      fees: { rate: p.ratePercent, min: p.min, max: p.max, roundTo: p.roundTo },
      txn: settings.txnFees(), // flat transaction fee bands (naira): seller's when the buyer starts, buyer's when the seller starts
      maxDeal: settings.maxDealMinor() / unit,
      maxDealVerified: settings.maxDealVerifiedMinor() / unit, // once someone has checked their ID (BVN or NIN)
      contact: settings.contact(),
      timing: { acceptHours: settings.acceptHours(), nudgeHours: settings.nudgeHours(), flagHours: settings.flagHours(), unpaidHours: settings.unpaidCloseHours(), autoReleaseMinutes: settings.autoReleaseMinutes(), repReplyMinutes: settings.repReplyMinutes(), problemReplyHours: settings.problemReplyHours() },
      // logo and pictures set in Console → Settings: slot → { url, v }. Missing slots keep the website's drawings.
      // `images` are the live home page version's (and the legal pages'); `versions` has every version's, for previews.
      homeVersion: settings.homeVersion(),
      images: siteMedia.forVersion(c.PUBLIC_BASE_URL, settings.homeVersion()),
      versions: Object.fromEntries(homeVersions().map((v) => [v.version, { date: v.date, images: siteMedia.forVersion(c.PUBLIC_BASE_URL, v.version) }])),
      links: await links.forSite(), // campaign links: the website builds hoolam.com/<slug> for each
      // the ambassador programme: whether it's on (menu link, the page), the rates shown on hoolam.com/ambassadors, and each link (hoolam.com/a/<name>)
      ambassadors: (() => { const a = ambassadors.cfg(); return { on: a.on, applyWeb: a.applyWeb, sellerPct: a.sellerPct, buyerPct: a.buyerPct, bonus: a.bonusMinor / unit, bonusOrders: a.bonusOrders, payoutDay: a.payoutDay, payoutMin: a.payoutMinMinor / unit, terms: a.terms, api: c.PUBLIC_BASE_URL.replace(/\/+$/, '') }; })(),
      ambassadorLinks: ambassadors.on() ? await ambassadors.forSite() : [],
      about: { founder: settings.get<boolean>('feature_about_founder') }, // About: Who's behind Hoolam (Settings → Features)
      // the chat's pictures and voice notes the website shows, and the live numbers (each only once it reaches its minimum)
      show: await siteShow.forSite(c.PUBLIC_BASE_URL).catch((e) => { log(`site show: ${(e as Error).message}`); return null; }),
    });
  });
  // the chat's pictures as the website shows them (Ivana and Mama Bella's order), with every replacement made in the console
  app.get('/site/art/:id', async (req, reply) => {
    const p = await siteShow.picture((req.params as { id: string }).id);
    if (!p) return reply.code(404).type('text/plain').send('No picture');
    const versioned = (req.query as { v?: string }).v === p.v;
    return reply.header('access-control-allow-origin', '*').header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300').type(p.mime).send(p.bytes);
  });
  // a voice note the website plays (uploaded in Console → Settings → WhatsApp)
  app.get('/site/voice/:id', async (req, reply) => {
    const v = await siteShow.voice((req.params as { id: string }).id);
    if (!v) return reply.code(404).type('text/plain').send('No voice note');
    return reply.header('access-control-allow-origin', '*').header('x-content-type-options', 'nosniff').header('cache-control', 'public, max-age=3600').type(v.mime).send(v.bytes);
  });
  // the live numbers on the website, fresher than the copy made when it was built
  app.get('/site/proof.json', async (_req, reply) => {
    return reply.header('access-control-allow-origin', '*').header('cache-control', 'public, max-age=300').send(await siteShow.proof());
  });
  // hoolam.com/check: is this a real Hoolam order? Only what's safe to show anyone holding the code (no names, numbers
  // or addresses), and at most 20 checks per 10 minutes from one address, so codes can't be guessed in a loop.
  const checks = new Map<string, { n: number; at: number }>();
  app.get('/check/:code', async (req, reply) => {
    reply.header('access-control-allow-origin', '*').header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    const now = Date.now(), ip = String(req.ip ?? '');
    const seen = checks.get(ip);
    if (seen && now - seen.at < 600_000 && seen.n >= 20) return reply.code(429).send({ error: 'Too many checks. Try again in a few minutes.' });
    if (!seen || now - seen.at >= 600_000) checks.set(ip, { n: 1, at: now }); else seen.n++;
    if (checks.size > 5000) for (const [k, v] of checks) if (now - v.at >= 600_000) checks.delete(k);
    const code = String((req.params as { code: string }).code).replace(/\.json$/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HL/, '');
    const d = /^[A-Z2-9]{5}$/.test(code) ? await deals.findByCode(`HL-${code}`) : null;
    if (!d) return reply.send({ found: false });
    const step = d.status === 'SHIPPED' && d.handed_over_at ? 5 : stepOf(d.status);
    const words: Record<string, string> = {
      AWAITING_SELLER: 'Waiting for the seller to accept. Nothing is paid yet.', AWAITING_BUYER: 'Waiting for the buyer to accept. Nothing is paid yet.',
      AWAITING_PAYMENT: 'Accepted. Waiting for the buyer to pay Hoolam.', FUNDED: 'Paid. The money is held by Hoolam.', SHIPPED: d.handed_over_at ? 'Delivered. The buyer is checking it.' : 'On the way. The money is held by Hoolam.',
      RELEASING: 'Done. The seller is being paid.', PAYOUT_PENDING: 'Done. The seller is being paid.', COMPLETED: 'Done. The seller was paid.',
      DISPUTED: 'A problem was reported. The money is frozen while Hoolam sorts it out.', REFUNDING: 'Refunding the buyer.', REFUNDED: 'The buyer was refunded.',
      CANCELLED: 'Cancelled. No money moved.', EXPIRED: 'Closed. No money moved.',
    };
    return reply.send({ found: true, code: d.code, item: d.item, price: formatMoney(d.price_minor, d.currency), started: d.created_at, step, status: words[d.status] ?? d.status });
  });
  // a campaign link's page on the website counts the tap here (navigator.sendBeacon), then moves the visitor on
  app.post('/l/:slug/tap', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (/^[a-z0-9-]{2,40}$/.test(slug) && !isBot(req.headers['user-agent'])) await links.tap(slug).catch((e) => log(`link tap: ${(e as Error).message}`));
    return reply.header('access-control-allow-origin', '*').code(204).send();
  });
  registerAmbassadorRoutes(app, { ambassadors, markUrl: () => siteMedia.url(c.PUBLIC_BASE_URL.replace(/\/+$/, ''), 'mark'), waNumber: () => settings.waNumber(), secure: c.PUBLIC_BASE_URL.startsWith('https://'), log });
  // Logo and website pictures uploaded in the console. Versioned URLs (?v=) are cached for a year.
  app.get('/media/:slot', async (req, reply) => {
    const { slot } = req.params as { slot: string };
    const m = await siteMedia.get(slot).catch((e) => { if (e instanceof MediaError) return null; throw e; });
    if (!m) return reply.code(404).type('text/plain').send('No image');
    const versioned = (req.query as { v?: string }).v === siteMedia.current()[slot];
    reply.header('access-control-allow-origin', '*').header('x-content-type-options', 'nosniff')
      .header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    if (m.mime === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    return reply.type(m.mime).send(m.bytes);
  });
  // "Chat on WhatsApp" for links that don't know the number
  app.get('/chat', async (req, reply) => {
    const text = String((req.query as { text?: string }).text ?? 'Hi Hoolam').slice(0, 200);
    return reply.redirect(`https://wa.me/${settings.waNumber()}?text=${encodeURIComponent(text)}`);
  });
  // The server's own address sends visitors to the landing page, once it has one
  // Each address has one job. console.<domain>: staff. Everything else (go., pay., shop., my.): buyers and sellers.
  const consoleHost = c.CONSOLE_URL ? new URL(c.CONSOLE_URL).hostname : null;
  const isConsoleHost = (h: string) => (consoleHost ? h === consoleHost : h.startsWith('console.'));
  if (consoleHost) {
    // the console only opens on its own address; elsewhere it moves there (pages) or doesn't exist (API)
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/console') || isConsoleHost(String(req.hostname ?? '').split(':')[0]!)) return;
      if (req.url.startsWith('/console/api')) return reply.code(404).send({ error: 'Not found' });
      return reply.redirect(`${c.CONSOLE_URL!.replace(/\/+$/, '')}${req.url}`, 301);
    });
  }
  // short links for buyers and sellers: /HL-ABCDE (pay) and /v/HL-ABCDE (see a deal) open the WhatsApp chat
  const CODE = /^HL-[A-Z2-9]{5}$/i;
  const missing = (kind: 'seller' | 'order' | 'other') => notFoundPage({ kind, waNumber: settings.waNumber(), markUrl: siteMedia.url(base, 'mark'), siteUrl: c.SITE_URL ?? null });
  const toChat = (text: string) => `https://wa.me/${settings.waNumber()}?text=${encodeURIComponent(text)}`;
  app.get('/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!CODE.test(code)) return reply.code(404).type('text/html').send(missing('other'));
    return reply.header('cache-control', 'no-store').redirect(toChat(`Pay ${code.toUpperCase()}`));
  });
  app.get('/v/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!CODE.test(code)) return reply.code(404).type('text/html').send(missing('other'));
    return reply.header('cache-control', 'no-store').redirect(toChat(`View ${code.toUpperCase()}`));
  });
  // ---------- the private order page (link sent only to the buyer and the seller) ----------
  /** The order for a page link, and whose link it is (each side sees their own fee; the bare token is neutral). */
  const orderView = async (code: string, key: unknown): Promise<{ d: Deal; viewer: 'buyer' | 'seller' | null } | null> => {
    if (!CODE.test(code) || typeof key !== 'string' || key.length < 10) return null;
    const d = await deals.findByCode(code.toUpperCase());
    if (!d?.view_token) return null;
    const same = (x: string) => { const a = Buffer.from(x), b = Buffer.from(key); return a.length === b.length && timingSafeEqual(a, b); };
    if (same(viewKey(d.view_token, 'buyer'))) return { d, viewer: 'buyer' };
    if (same(viewKey(d.view_token, 'seller'))) return { d, viewer: 'seller' };
    return same(d.view_token) ? { d, viewer: null } : null;
  };
  const orderFor = async (code: string, key: unknown) => (await orderView(code, key))?.d ?? null;
  app.get('/o/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const k = (req.query as { k?: string }).k;
    const v = await orderView(code, k);
    if (!v) return reply.code(404).type('text/html').send(missing('order'));
    const d = v.d;
    const photos = await db.query(`SELECT id FROM deal_photos WHERE deal_id=$1 AND kind='ITEM' AND bytes IS NOT NULL ORDER BY id LIMIT 3`, [d.id]);
    const name = async (id: string | null) => id ? (await db.query('SELECT COALESCE(business_name, display_name) AS n FROM users WHERE id=$1', [id])).rows[0]?.n ?? null : null;
    return reply.type('text/html').header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex').send(orderPage(d, {
      photoIds: photos.rows.map((r) => r.id), photoUrl: (id) => `/o/${d.code}/p/${id}.jpg?k=${encodeURIComponent(String(k))}`,
      chatUrl: toChat('menu'), viewUrl: toChat(`View ${d.code}`), payUrl: toChat(`Pay ${d.code}`),
      markUrl: siteMedia.url(base, 'mark'), sellerName: await name(d.seller_id), buyerName: await name(d.buyer_id), viewer: v.viewer,
      artBase: base, autoReleaseMinutes: settings.autoReleaseMinutes(), problemReplyHours: settings.problemReplyHours(),
      sellerTrust: v.viewer === 'buyer' && d.seller_id ? await (async () => {
        const t = await trust.seller(d.seller_id!);
        if (!t) return null;
        const bits = [t.verified ? 'Verified seller' : null, t.isNew ? 'New on Hoolam' : null,
          t.completed ? `${t.completed} order${t.completed === 1 ? '' : 's'} completed` : null,
          t.rated >= 5 ? `${Math.round((100 * t.happy) / t.rated)}% happy` : null].filter(Boolean);
        return { line: [t.name, ...bits].join(' · '), url: t.isPublic && t.slug ? `${base}/s/${t.slug}` : null };
      })() : null,
      receipts: v.viewer ? (await deals.receiptsFor(d.id, v.viewer)).map((r, i) => ({ label: r.label, url: `/o/${d.code}/r/${i}.jpg?k=${encodeURIComponent(String(k))}` })) : [],
    }));
  });
  // a receipt picture for one side of the order (the link's key says which side)
  app.get('/o/:code/r/:n', async (req, reply) => {
    const { code, n } = req.params as { code: string; n: string };
    const v = await orderView(code, (req.query as { k?: string }).k);
    const i = Number(String(n).replace(/\.jpg$/, ''));
    if (!v?.viewer || !Number.isInteger(i)) return reply.code(404).type('text/plain').send('Not found');
    const r = (await deals.receiptsFor(v.d.id, v.viewer))[i];
    const img = r ? await deals.receiptImage(v.d.id, r.kind, r.payoutId) : null;
    if (!img) return reply.code(404).type('text/plain').send('Not found');
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=300').header('x-robots-tag', 'noindex').header('x-content-type-options', 'nosniff').send(img);
  });
  app.get('/o/:code/p/:id', async (req, reply) => {
    const { code, id } = req.params as { code: string; id: string };
    const d = await orderFor(code, (req.query as { k?: string }).k);
    const pid = Number(String(id).replace(/\.jpg$/, ''));
    if (!d || !Number.isInteger(pid)) return reply.code(404).type('text/plain').send('Not found');
    const r = await db.query(`SELECT bytes FROM deal_photos WHERE id=$1 AND deal_id=$2 AND bytes IS NOT NULL`, [pid, d.id]);
    if (!r.rows[0]) return reply.code(404).type('text/plain').send('Not found');
    const jpg = await sharp(r.rows[0].bytes).rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff').send(jpg);
  });

  app.get('/', async (req, reply) => {
    if (isConsoleHost(String(req.hostname ?? '').split(':')[0]!)) return reply.redirect('/console/');
    return c.SITE_URL ? reply.redirect(c.SITE_URL) : reply.type('text/plain').send('Hoolam is running.');
  });

  // ---------- search engines ----------
  // Only sellers' public pages are for search (and AI tools), on their own address (PUBLIC_BASE_URL, e.g. go.hoolam.com).
  // The console's address stays out of search entirely; a seller page opened there moves to the public address.
  const publicHost = (() => { try { return new URL(c.PUBLIC_BASE_URL).hostname; } catch { return ''; } })();
  const onConsole = (req: { hostname?: string }) => { const h = String(req.hostname ?? '').split(':')[0]!; return isConsoleHost(h) && h !== publicHost; };
  app.addHook('onRequest', async (req, reply) => {
    if ((req.url.startsWith('/s/') || req.url.startsWith('/i/')) && onConsole(req)) return reply.redirect(`${c.PUBLIC_BASE_URL.replace(/\/+$/, '')}${req.url}`, 301);
  });
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain').header('cache-control', 'public, max-age=3600')
    .send(onConsole(req) ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /s/\nAllow: /i/\nDisallow: /i/*/buy\nAllow: /media/\nAllow: /favicon.svg\nAllow: /sitemap.xml\nDisallow: /\n\nSitemap: ${c.PUBLIC_BASE_URL.replace(/\/+$/, '')}/sitemap.xml\n`));
  app.get('/sitemap.xml', async (req, reply) => {
    if (onConsole(req)) return reply.code(404).type('text/plain').send('Not found');
    const b = c.PUBLIC_BASE_URL.replace(/\/+$/, '');
    // each page with the date it last changed (new orders, a new photo) and the seller's photo, when they have one
    const rows = (await db.query(`SELECT u.profile_slug AS slug, p.sha256 AS photo,
        GREATEST(u.created_at, p.updated_at, (SELECT max(d.updated_at) FROM deals d WHERE d.seller_id=u.id)) AS at
      FROM users u LEFT JOIN user_photos p ON p.user_id=u.id
      WHERE u.profile_public AND u.profile_slug IS NOT NULL ORDER BY u.profile_slug LIMIT 50000`)).rows;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${rows.map((r) => {
      const page = `${b}/s/${encodeURIComponent(r.slug)}`;
      const img = r.photo ? `<image:image><image:loc>${page}/photo.webp?v=${String(r.photo).slice(0, 12)}</image:loc></image:image>` : '';
      return `  <url><loc>${page}</loc><lastmod>${new Date(r.at).toISOString().slice(0, 10)}</lastmod>${img}</url>`;
    }).concat(market.on() ? (await db.query(`SELECT code, updated_at FROM market_listings WHERE status='LIVE' AND stock > 0 AND NOT is_test ORDER BY created_at DESC LIMIT 40000`)).rows.map((r) =>
      `  <url><loc>${b}/i/${encodeURIComponent(r.code)}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod><image:image><image:loc>${b}/i/${encodeURIComponent(r.code)}/1.jpg</image:loc></image:image></url>`) : []).join('\n')}\n</urlset>\n`;
    return reply.type('application/xml').header('cache-control', 'public, max-age=3600').send(xml);
  });

  // ---------- public seller pages ----------
  const shareImage = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'share.png'));
  const favicon = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'assets', 'favicon.svg'));
  app.get('/favicon.svg', async (_req, reply) => reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(favicon));
  app.get('/share.png', async (_req, reply) => reply.type('image/png').header('cache-control', 'public, max-age=86400').send(shareImage));
  const base = c.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const publicSeller = async (slug: string) => {
    const id = await trust.findSeller({ slug });
    return id ? { id, t: await trust.seller(id) } : null;
  };
  // a seller's photo on their page
  app.get('/s/:slug/photo.webp', async (req, reply) => {
    const s = await publicSeller((req.params as { slug: string }).slug);
    const p = s ? await trust.photo(s.id) : null;
    if (!p) return reply.code(404).type('text/plain').send('No photo');
    const v = (req.query as { v?: string }).v;
    return reply.type(p.mime).header('x-content-type-options', 'nosniff')
      .header('cache-control', v === p.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300').send(p.bytes);
  });
  // "Buy" and social links on a seller's page: counted for the seller, then straight on to WhatsApp / their page
  app.get('/s/:slug/buy', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const id = await trust.findSeller({ slug });
    if (id && !isBot(req.headers['user-agent'])) await trust.recordBuy(id, visitorCode(req)).catch((e) => log(`seller page stats: ${(e as Error).message}`));
    return reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').redirect(buyWhatsApp(settings.waNumber(), slug.toLowerCase()), 302);
  });
  app.get('/s/:slug/go/:kind', async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    const id = await trust.findSeller({ slug });
    const t = id ? await trust.seller(id) : null;
    const link = t?.socials.find((x) => x.kind === kind);
    if (!id || !link) return reply.code(404).type('text/html').send(missing('seller'));
    if (!isBot(req.headers['user-agent'])) await trust.recordSocial(id).catch((e) => log(`seller page stats: ${(e as Error).message}`));
    return reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').redirect(link.url, 302);
  });
  // the picture shown when a seller's link is shared: their trust card with today's numbers (else their photo in the Hoolam card)
  const shareCards = new Map<string, Buffer>();
  app.get('/s/:slug/share.jpg', async (req, reply) => {
    const s = await publicSeller((req.params as { slug: string }).slug);
    if (!s?.t) return reply.redirect('/share.png');
    try {
      const key = JSON.stringify([s.id, s.t.photoVersion, s.t.completed, s.t.buyers, s.t.happy, s.t.rated, s.t.verified, s.t.isNew, s.t.name, s.t.city, siteMedia.current().mark ?? '']);
      let img = shareCards.get(key);
      if (!img) {
        img = (await chatArt.render(ART.trust(s.t, s.id))).bytes;
        if (shareCards.size > 300) shareCards.clear();
        shareCards.set(key, img);
      }
      return reply.type('image/jpeg').header('cache-control', 'public, max-age=3600').send(img);
    } catch (e) { log(`seller share card: ${(e as Error).message}`); }
    const markV = siteMedia.current().mark ?? '';
    const markFile = markV ? await siteMedia.get('mark') : null;
    const photo = s.t.photoVersion ? await trust.photo(s.id) : null;
    const img = await sellerShareImage(`${s.id}:${s.t.photoVersion ?? '-'}:${markV}`, photo?.bytes ?? null, markFile?.bytes ?? null);
    return reply.type('image/jpeg').header('cache-control', 'public, max-age=3600').send(img);
  });
  // a one-way code for "this browser on this network today", so a visitor counts once a day; the IP itself is never stored
  const visitorCode = (req: { ip?: string; headers: Record<string, unknown> }) =>
    createHash('sha256').update(`${req.ip ?? ''}|${String(req.headers['user-agent'] ?? '')}|${new Date().toISOString().slice(0, 10)}|${formSecret}`).digest('hex').slice(0, 32);
  // the seller's video (Seller videos on, checked by Hoolam). Phones ask for it in pieces (Range), so it plays straight away.
  app.get('/s/:slug/video.mp4', async (req, reply) => {
    const s = await publicSeller((req.params as { slug: string }).slug);
    const v = s ? await trust.liveVideo(s.id) : null;
    if (!v) return reply.code(404).type('text/plain').send('No video');
    const total = v.bytes.length;
    reply.header('accept-ranges', 'bytes').header('x-content-type-options', 'nosniff').header('x-robots-tag', 'noindex')
      .header('cache-control', (req.query as { v?: string }).v === v.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300').type(v.mime);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!m) return reply.header('content-length', total).send(v.bytes);
    let start = m[1] ? Number(m[1]) : total - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : total - 1;
    if (!m[1]) end = total - 1;
    if (start < 0) start = 0;
    if (start >= total || end < start) return reply.code(416).header('content-range', `bytes */${total}`).send();
    end = Math.min(end, total - 1);
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${total}`).header('content-length', end - start + 1).send(v.bytes.subarray(start, end + 1));
  });
  // a photo of an item the seller delivered (only theirs, only when they chose to show them)
  app.get('/s/:slug/delivered/:file', async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const id = Number(/^(\d+)\.webp$/.exec(file)?.[1] ?? NaN);
    const s = Number.isFinite(id) ? await publicSeller(slug) : null;
    const img = s ? await trust.deliveredPhoto(s.id, id) : null;
    if (!img) return reply.code(404).type('text/plain').send('No photo');
    return reply.type('image/webp').header('x-content-type-options', 'nosniff').header('cache-control', 'public, max-age=86400').send(img);
  });
  app.get('/s/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const id = await trust.findSeller({ slug });
    if (id && !isBot(req.headers['user-agent'])) await trust.recordView(id, visitorCode(req)).catch((e) => log(`seller page stats: ${(e as Error).message}`));
    const t = id ? await trust.seller(id) : null;
    if (!t) return reply.code(404).type('text/html').send(missing('seller'));
    const money = (minor: number) => formatMoney(minor, c.CURRENCY).replace(/\.00$/, '');
    const items = market.on() ? (await market.search({ place: null, ring: 3, sellerId: id!, page: 0, pageSize: 12 }).catch(() => null))?.cards ?? [] : [];
    return reply.type('text/html').header('cache-control', 'public, max-age=300')
      .send(sellerPage(t, {
        slug: slug.toLowerCase(), waNumber: settings.waNumber(), baseUrl: base, siteUrl: c.SITE_URL ?? null,
        markUrl: siteMedia.url(base, 'mark'),
        feeFrom: formatMoney(settings.pricing().min * (c.CURRENCY === "NGN" ? 100 : 1), c.CURRENCY),
        artBase: base,
        items: items.map((x) => ({ url: `${base}/i/${x.code}`, img: `${base}/i/${x.code}/1.jpg`, title: x.title, price: money(x.now_minor), was: x.on_promo ? money(Number(x.price_minor)) : null })),
        itemsMore: items.length >= 12 ? `https://wa.me/${settings.waNumber().replace(/\D/g, '')}?text=${encodeURIComponent('Browse the market')}` : null,
        gaId: c.GA_MEASUREMENT_ID === 'off' ? null : (c.GA_MEASUREMENT_ID || 'G-J2YB5ZF1NE'),
      }));
  });

  // ---------- market item pages: go.hoolam.com/i/<code> ----------
  const itemCards = new Map<string, Buffer>();
  const liveItem = async (code: string) => {
    if (!market.on()) return null;
    const card = await market.card(code);
    return card && !['DELETED', 'REMOVED'].includes(card.status) ? card : null;
  };
  app.get('/i/:code', async (req, reply) => {
    const c0 = await liveItem((req.params as { code: string }).code);
    if (!c0) return reply.code(404).type('text/html').send(missing('other'));
    if (!isBot(req.headers['user-agent'])) await market.bump(c0.id, 'views').catch(() => {});
    const t = await trust.seller(c0.seller_id);
    const publicSlug = c0.seller_slug && (await trust.findSeller({ slug: c0.seller_slug })) === c0.seller_id ? c0.seller_slug : null;
    const more = (await market.search({ place: null, ring: 3, sellerId: c0.seller_id, page: 0, pageSize: 7 })).cards.filter((x) => x.id !== c0.id).slice(0, 6);
    const money = (minor: number) => formatMoney(minor, c.CURRENCY).replace(/\.00$/, '');
    return reply.type('text/html').header('cache-control', 'public, max-age=120').send(itemPage({
      code: c0.code, title: c0.title, details: c0.details, category: categoryTitle(c0.category),
      priceMinor: Number(c0.price_minor), nowMinor: c0.now_minor, onPromo: c0.on_promo, offPct: c0.off_pct ?? 0, promoEnds: c0.promo_ends ? new Date(c0.promo_ends) : null,
      stock: c0.stock, live: c0.status === 'LIVE', soldOut: c0.status === 'SOLD_OUT' || c0.stock === 0, delivery: c0.delivery,
      area: c0.area, city: c0.city, state: c0.state, photos: c0.photos, updatedAt: new Date(c0.updated_at),
      seller: { name: c0.seller_name, verified: c0.seller_verified, orders: t?.completed ?? c0.seller_orders, happyPct: t && t.rated >= 5 ? Math.round((100 * t.happy) / t.rated) : null, slug: publicSlug, photo: c0.seller_photo, since: t?.since ?? new Date() },
      more: more.map((x) => ({ code: x.code, title: x.title, price: money(x.now_minor), was: x.on_promo ? money(x.price_minor) : null })),
    }, { baseUrl: base, siteUrl: c.SITE_URL ?? null, markUrl: siteMedia.url(base, 'mark'), artBase: base, money, sellerPhotoUrl: c0.seller_photo ? `${base}/i/${c0.code}/seller.jpg` : null }));
  });
  app.get('/i/:code/:n.jpg', async (req, reply) => {
    const { code, n } = req.params as { code: string; n: string };
    const c0 = await liveItem(code);
    if (!c0) return reply.code(404).type('text/plain').send('Not found');
    if (n === 'seller') {
      const p = await trust.photo(c0.seller_id);
      return p ? reply.type(p.mime).header('cache-control', 'public, max-age=3600').header('x-content-type-options', 'nosniff').send(p.bytes) : reply.code(404).type('text/plain').send('No photo');
    }
    if (n === 'card') {
      const key = `${c0.id}:${c0.updated_at}:${c0.stock}:${c0.status}`;
      let img = itemCards.get(key);
      if (!img) {
        const sold = c0.status !== 'LIVE' || c0.stock === 0;
        const money = (minor: number) => formatMoney(minor, c.CURRENCY).replace(/\.00$/, '');
        img = (await chatArt.render(ART.marketItem({
          listingId: c0.id, sellerId: c0.seller_id, title: c0.title, price: money(c0.now_minor), was: c0.on_promo ? money(c0.price_minor) : null, offPct: c0.on_promo ? c0.off_pct : null,
          verified: c0.seller_verified, where: [c0.area, c0.city].filter(Boolean).join(', ') || 'Nigeria', seller: c0.seller_name,
          record: c0.seller_orders ? `${c0.seller_orders} orders completed` : 'New on Hoolam', ribbon: sold ? 'Sold out' : null, tone: sold ? 'grey' : 'gold', greyed: sold,
        }))).bytes;
        if (itemCards.size > 300) itemCards.clear();
        itemCards.set(key, img);
      }
      return reply.type('image/jpeg').header('cache-control', 'public, max-age=600').send(img);
    }
    const b = await market.photo(c0.id, Math.max(0, Number(n) - 1) || 0);
    if (!b) return reply.code(404).type('text/plain').send('No photo');
    return reply.type('image/jpeg').header('cache-control', 'public, max-age=86400').header('x-content-type-options', 'nosniff').send(b);
  });
  /** "Buy safely on WhatsApp": Hoolam's chat opens on this item ("?ad=" carries an ad's name; "?more=1" opens the market). */
  app.get('/i/:code/buy', async (req, reply) => {
    const { code } = req.params as { code: string };
    const q = req.query as { ad?: string; more?: string };
    const ad = q.ad && /^[a-z0-9-]{1,30}$/i.test(q.ad) ? ` (ad ${q.ad.toLowerCase()})` : '';
    const text = q.more ? 'Browse the market' : `Hi Hoolam, I want to buy this: ${code.toLowerCase()}${ad}`;
    return reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').redirect(`https://wa.me/${settings.waNumber().replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, 302);
  });

  // ---------- WhatsApp ----------
  app.get('/webhook/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === c.WHATSAPP_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    return reply.code(403).send('forbidden');
  });

  app.post('/webhook/whatsapp', async (req, reply) => {
    const unsignedAllowed = c.WHATSAPP_DRY_RUN && !c.WHATSAPP_APP_SECRET;
    if (!unsignedAllowed && !verifyMetaSignature(req.rawBody ?? '', header(req, 'x-hub-signature-256'), c.WHATSAPP_APP_SECRET)) {
      log('whatsapp webhook REJECTED: bad signature. Check WHATSAPP_APP_SECRET matches Meta > App settings > Basic');
      return reply.code(401).send('bad signature');
    }
    const inbound = parseInbound(req.body);
    if (!inbound.length) {
      // "read" receipts: the other side has seen an order alert → tell the person waiting (once)
      for (const st of parseStatuses(req.body)) if (st.status === 'read') await deals.seenByMessage(st.id).catch((e) => log(`seen: ${(e as Error).message}`));
    }
    for (const m of inbound) {
      log(`whatsapp in: …${m.phone.slice(-4)} ${m.type}${m.buttonId ? ' ' + m.buttonId : ''}`);
      const id = await storeEvent(db, 'whatsapp', m.id, m);
      // blue ticks and "typing…" straight away, while the reply is prepared
      if (id && m.type !== 'welcome') void messenger.markReadTyping(m.id);
      if (id) runSoon('whatsapp', id);
    }
    return reply.code(200).send('ok'); // answer fast; work happens after
  });

  // ---------- the live forms' endpoint (encrypted by WhatsApp; see whatsapp/flow-crypto.ts) ----------
  app.post('/flows/endpoint', async (req, reply) => {
    if (c.WHATSAPP_APP_SECRET && !verifyMetaSignature(req.rawBody ?? '', header(req, 'x-hub-signature-256'), c.WHATSAPP_APP_SECRET)) {
      log('forms endpoint REJECTED: bad signature');
      return reply.code(432).send('bad signature');
    }
    keys ??= await flowKeys(db, c.FLOWS_PRIVATE_KEY);
    let dec;
    try { dec = decryptRequest(req.body as Record<string, string>, keys.privateKeyPem); }
    catch (e) {
      log(`forms endpoint: can't decrypt (${(e as Error).message}). Meta will refresh the key.`);
      return reply.code(e instanceof FlowDecryptError ? 421 : 400).send('cannot decrypt');
    }
    const tok = String((dec.body as { flow_token?: string }).flow_token ?? '');
    // opening a live form counts as activity ("Opened My orders", "Opened the payout account form")
    if ((dec.body as { action?: string }).action === 'INIT') {
      const t = tok.startsWith('o1.') ? readToken(formSecret, tok) : null;
      const who = t?.phone ?? (tok.startsWith('pb1.') ? readPayoutToken(formSecret, tok) : null);
      const u = who ? (await db.query('SELECT id FROM users WHERE phone=$1', [who])).rows[0] : null;
      if (u && who) await activity.record({ userId: u.id, phone: who, kind: 'screen', title: t ? (t.code ? `Opened order ${t.code} in a form` : 'Opened My orders') : 'Opened the payout account form', detail: t?.code ? { code: t.code } : {} });
    }
    const answer = tok.startsWith('a1.') ? await ambDetails.handle(dec.body) : tok.startsWith('pb1.') ? await chat.payoutFormRequest(dec.body as never) : await orders.handle(dec.body);
    return reply.type('text/plain').send(encryptResponse(answer, dec.aesKey, dec.iv));
  });

  // ---------- payment provider ----------
  app.post('/webhook/payments', async (req, reply) => {
    const ev = provider.parseWebhook(req.rawBody ?? '', req.headers);
    if (!ev) {
      log(`payments webhook REJECTED (${req.headers['monnify-signature'] ? 'signature does not match MONNIFY_SECRET_KEY' : 'unsigned, or not an event we use'})`);
      return reply.code(401).send('rejected');
    }
    const id = await storeEvent(db, 'payments', ev.eventKey, ev);
    if (id) runSoon('payments', id);
    return reply.code(200).send('ok');
  });

  // ---------- local testing only: pretend the buyer paid ----------
  if (provider instanceof FakeProvider) {
    app.post('/dev/pay/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const r = await db.query(
        `SELECT pi.provider_reference FROM payment_intents pi JOIN deals d ON d.id=pi.deal_id WHERE d.code=$1 ORDER BY pi.created_at DESC LIMIT 1`, [code.toUpperCase()]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'No payment requested for this deal yet' });
      const amount = (req.body as { amountMinor?: number } | undefined)?.amountMinor;
      provider.pay(r.rows[0].provider_reference, amount);
      const ev = provider.parseWebhook(provider.webhookFor(r.rows[0].provider_reference))!;
      const id = await storeEvent(db, 'payments', ev.eventKey + ':' + Date.now(), ev);
      if (id) await processEvent(db, id, handlers.payments!, log);
      return { ok: true };
    });
  }

  // ---------- admin (Bearer ADMIN_TOKEN) ----------
  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      const got = Buffer.from(header(req, 'authorization') ?? '');
      const want = Buffer.from(`Bearer ${c.ADMIN_TOKEN}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
    });

    admin.get('/deals', async (req) => {
      const status = (req.query as { status?: string }).status;
      const r = await db.query(
        `SELECT d.code, d.item, d.status, d.started_by, d.buyer_pays_minor, d.seller_gets_minor, d.currency, s.phone AS seller, b.phone AS buyer, d.updated_at
         FROM deals d LEFT JOIN users s ON s.id=d.seller_id LEFT JOIN users b ON b.id=d.buyer_id
         ${status ? 'WHERE d.status=$1' : ''} ORDER BY d.updated_at DESC LIMIT 100`, status ? [status] : []);
      return r.rows;
    });

    // Everything a person needs to look at today.
    admin.get('/attention', async () => {
      const deals = await db.query(
        `SELECT DISTINCT ON (d.id) d.code, d.status, d.updated_at, e.note
         FROM deals d LEFT JOIN deal_events e ON e.deal_id=d.id AND e.note LIKE 'NEEDS_ATTENTION%'
         WHERE d.status IN ('DISPUTED','PAYOUT_PENDING')
            OR (d.status='SHIPPED' AND d.shipped_at < now() - make_interval(hours => $1))
            OR e.id IS NOT NULL
         ORDER BY d.id, e.id DESC`, [settings.flagHours()]);
      const templates = await db.query(`SELECT phone, body, created_at FROM outbound_messages WHERE status='NEEDS_TEMPLATE' AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 50`);
      const stuck = await db.query(`SELECT id, source, event_key, attempts, last_error FROM webhook_events WHERE processed_at IS NULL AND attempts >= 3 ORDER BY id DESC LIMIT 50`);
      const support = await db.query(`SELECT id, phone, message, created_at FROM support_requests WHERE status='OPEN' ORDER BY id LIMIT 50`);
      const unhappy = await db.query(
        `SELECT d.code, r.comment, r.created_at FROM deal_ratings r JOIN deals d ON d.id=r.deal_id WHERE NOT r.happy AND r.created_at > now() - interval '14 days' ORDER BY r.created_at DESC LIMIT 50`);
      return { deals: deals.rows, supportRequests: support.rows, unhappyBuyers: unhappy.rows, messagesNeedingTemplates: templates.rows, stuckWebhooks: stuck.rows };
    });

    admin.get('/deals/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const d = await db.query('SELECT * FROM deals WHERE code=$1', [code.toUpperCase()]);
      if (!d.rows[0]) return reply.code(404).send({ error: 'not found' });
      const id = d.rows[0].id;
      const [events, payments, payouts, ledger, disputes] = await Promise.all([
        db.query('SELECT * FROM deal_events WHERE deal_id=$1 ORDER BY id', [id]),
        db.query('SELECT * FROM payment_intents WHERE deal_id=$1 ORDER BY created_at', [id]),
        db.query('SELECT * FROM payouts WHERE deal_id=$1 ORDER BY created_at', [id]),
        db.query('SELECT account, amount_minor, memo, created_at FROM ledger_entries WHERE deal_id=$1 ORDER BY id', [id]),
        db.query('SELECT * FROM disputes WHERE deal_id=$1 ORDER BY created_at', [id]),
      ]);
      const photos = (await deals.photosFor(id)).map((p) => ({ ...p, url: `/admin/deals/${d.rows[0].code}/photos/${p.id}` }));
      return { deal: d.rows[0], photos, events: events.rows, payments: payments.rows, payouts: payouts.rows, ledger: ledger.rows, disputes: disputes.rows };
    });
    // The photos the buyer sent: proof of what was promised.
    admin.get('/deals/:code/photos/:id', async (req, reply) => {
      const { code, id } = req.params as { code: string; id: string };
      const r = await db.query(
        'SELECT p.mime_type, p.bytes FROM deal_photos p JOIN deals d ON d.id=p.deal_id WHERE d.code=$1 AND p.id=$2', [code.toUpperCase(), id]);
      if (!r.rows[0]?.bytes) return reply.code(404).send({ error: 'no photo' });
      return reply.type(r.rows[0].mime_type).send(r.rows[0].bytes);
    });

    const tokenActor: Actor = { staffId: null, name: 'Admin token (API)', role: 'SYSTEM' };
    admin.post('/deals/:code/release', async (req) => {
      const code = (req.params as { code: string }).code.toUpperCase();
      const note = (req.body as { note?: string })?.note ?? 'Released after review';
      await deals.adminRelease(code, note);
      await audit(db, { ...tokenActor, ip: req.ip }, { action: 'deal.release', targetType: 'deal', targetId: code, reason: note });
      return { ok: true };
    });
    admin.post('/deals/:code/refund', async (req) => {
      const code = (req.params as { code: string }).code.toUpperCase();
      const note = (req.body as { note?: string })?.note ?? 'Refunded after review';
      await deals.adminRefund(code, note);
      await audit(db, { ...tokenActor, ip: req.ip }, { action: 'deal.refund', targetType: 'deal', targetId: code, reason: note });
      return { ok: true };
    });
    admin.post('/payouts/:reference/authorize', async (req, reply) => {
      const otp = (req.body as { otp?: string })?.otp;
      if (!otp) return reply.code(400).send({ error: 'otp required' });
      return deals.authorizePayout((req.params as { reference: string }).reference, otp);
    });
    admin.post('/payouts/:reference/retry', async (req) => {
      await deals.retryPayout((req.params as { reference: string }).reference);
      return { ok: true };
    });
    admin.get('/messages', async (req) => {
      const status = (req.query as { status?: string }).status;
      const r = await db.query(
        `SELECT id, phone, kind, status, error, body->>'text' AS text, created_at FROM outbound_messages
         ${status ? 'WHERE status=$1' : ''} ORDER BY id DESC LIMIT 50`, status ? [status] : []);
      return r.rows;
    });
    // "Talk to a person": read the messages, answer them, close them.
    admin.get('/support', async (req) => {
      const status = (req.query as { status?: string }).status ?? 'OPEN';
      const r = await db.query('SELECT id, phone, message, status, created_at, closed_at FROM support_requests WHERE status=$1 ORDER BY id DESC LIMIT 100', [status.toUpperCase()]);
      return r.rows;
    });
    admin.post('/support/:id/close', async (req, reply) => {
      const r = await db.query(`UPDATE support_requests SET status='CLOSED', closed_at=now() WHERE id=$1 AND status='OPEN' RETURNING id`, [(req.params as { id: string }).id]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'no open request with that id' });
      return { ok: true };
    });
    // Reply to someone as Hoolam (only works within 24 hours of their last message).
    admin.post('/messages/send', async (req, reply) => {
      const { phone, text } = (req.body ?? {}) as { phone?: string; text?: string };
      if (!phone || !text) return reply.code(400).send({ error: 'phone and text required' });
      const to = phone.startsWith('+') ? phone : '+' + phone.replace(/\D/g, '');
      await messenger.send(to, { kind: 'buttons', text, buttons: [{ id: 'menu:open', title: 'Main menu' }] });
      const r = await db.query('SELECT status, error FROM outbound_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [to]);
      return r.rows[0] ?? { status: 'unknown' };
    });
    // Re-send the ice breakers and slash commands to Meta.
    admin.post('/whatsapp/sync-menu', async (_req, reply) => {
      if (c.WHATSAPP_DRY_RUN) return reply.code(400).send({ error: 'WhatsApp is in dry-run mode' });
      await setupMeta();
      return { ok: true, forms: forms.list() };
    });
    admin.get('/trust/:phone', async (req, reply) => {
      const phone = '+' + (req.params as { phone: string }).phone.replace(/\D/g, '');
      const u = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (!u.rows[0]) return reply.code(404).send({ error: 'unknown phone' });
      return { seller: await trust.seller(u.rows[0].id), buyer: await trust.buyer(u.rows[0].id) };
    });
    admin.get('/ledger/balances', async () => {
      const r = await db.query('SELECT account, currency, SUM(amount_minor)::bigint AS balance_minor FROM ledger_entries GROUP BY account, currency ORDER BY account');
      return r.rows;
    });
  }, { prefix: '/admin' });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DealError) return reply.code(409).send({ error: err.reason, message: err.message });
    const e = err as Error & { statusCode?: number };
    log(`error: ${e.stack ?? e.message}`);
    const code = e.statusCode ?? 500;
    return reply.code(code).send({ error: code < 500 ? e.message : 'internal error' });
  });

  const syncMenu = () => syncAutomation({ token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, log });

  /** Asks Meta again which templates are approved (approval comes hours after the server starts). */
  async function refreshTemplates(): Promise<void> {
    if (c.WHATSAPP_DRY_RUN || !c.WHATSAPP_WABA_ID) return;
    const st = await fetchTemplateStatuses({ token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, wabaId: c.WHATSAPP_WABA_ID, log });
    if (!st) return;
    messenger.setTemplateStatus(SIGN_IN_CODE.name, st[SIGN_IN_CODE.name] ?? null);
    for (const t of ALL_TEMPLATES) {
      const before = messenger.templateStatus(t.name);
      messenger.setTemplateStatus(t.name, st[t.name] ?? null);
      if (st[t.name] && st[t.name] !== before) log(`template ${t.name}: ${st[t.name]}`);
      if (t.replaces) messenger.setTemplateStatus(t.replaces, st[t.replaces] ?? null);
    }
  }

  /** On start (live mode): the menu extras, the seller alert template and the buyer's form. Never throws. */
  async function setupMeta(): Promise<void> {
    if (c.WHATSAPP_DRY_RUN) return;
    try {
      if (c.WHATSAPP_SYNC_MENU) await syncMenu();
      if (!c.WHATSAPP_WABA_ID) {
        log('buyer form + seller alerts need WHATSAPP_WABA_ID in Render. Buyers answer in the chat until then.');
        for (const k of ['buy', 'buyEdit', 'sell', 'sellEdit', 'kyc', 'orders', 'order', 'ambApply', 'ambDetails', 'mkList', 'mkEdit', 'mkOrder', 'payout', 'problem', 'page', 'rate'] as FormKey[]) forms.off(k, 'Needs WHATSAPP_WABA_ID on Render');
        return;
      }
      const o = { token: c.WHATSAPP_TOKEN, phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID, graphVersion: c.WHATSAPP_GRAPH_VERSION, wabaId: c.WHATSAPP_WABA_ID, log };
      /** Meta's answer for one form goes into the registry (ready with its state, or failed with the reason). */
      const into = (key: FormKey, backup = false) => ({ ...o, report: (r: { name: string; id: string | null; status: string | null; error: string | null }) => {
        if (r.id && r.status) forms.ready(key, { flowId: r.id, name: r.name, status: r.status, backup, note: r.error });
        else forms.failed(key, r.error ?? 'Unknown problem', r.name);
      } });
      // the alerts and the deal updates used outside WhatsApp's 24-hour window (submitted once; used after Meta approves)
      for (const t of ALL_TEMPLATES) messenger.setTemplateStatus(t.name, await ensureTemplate(o, t, t.label));
      messenger.setTemplateStatus(SIGN_IN_CODE.name, await ensureSignInTemplate(o)); // ambassadors' sign-in codes
      // reworded templates: keep using the earlier approved version until Meta approves the new wording
      await refreshTemplates();
      if (c.WHATSAPP_BUY_FORM) {
        // the forms carry their pictures (Console → Chat pictures → Form: …); a new picture makes a new form version
        const start = await chatArt.formImage({ picture: 'form-start' }, 900);
        const why = await chatArt.formImage({ picture: 'form-id' }, 900);
        await ensureBuyFlow(into('buy'), buyFlowJson(undefined, start));
        await ensureBuyEditFlow(into('buyEdit'));
        await ensureSellFlow(into('sell'), sellFlowJson(undefined, start));
        await ensureSellEditFlow(into('sellEdit'));
        await ensureKycFlow(into('kyc'), kycFlowJson(why));
        await ensureAmbApplyFlow(into('ambApply'));
        // the market's forms: list an item, edit an item, delivery for a market order (the chat asks the same when they can't be used)
        { const j = listFormJson(); await ensureStaticFlow(into('mkList'), j, listFormName(j), 'market list form'); }
        { const j = editItemFormJson(); await ensureStaticFlow(into('mkEdit'), j, editItemFormName(j), 'market edit form'); }
        { const j = marketOrderFormJson(); await ensureStaticFlow(into('mkOrder'), j, marketOrderFormName(j), 'market order form'); }
        // report a problem, my page (and the seller setup), rating
        { const j = problemFormJson(); await ensureStaticFlow(into('problem'), j, problemFormName(j), 'problem form'); }
        { const j = pageFormJson(); await ensureStaticFlow(into('page'), j, pageFormName(j), 'my page form'); }
        { const j = rateFormJson(); await ensureStaticFlow(into('rate'), j, rateFormName(j), 'rating form'); }
      } else for (const k of ['buy', 'buyEdit', 'sell', 'sellEdit', 'kyc', 'ambApply', 'mkList', 'mkEdit', 'mkOrder', 'problem', 'page', 'rate'] as FormKey[]) forms.off(k, 'Switched off on Render (WHATSAPP_BUY_FORM=false)');
      if (c.WHATSAPP_ORDERS_FORM && c.PUBLIC_BASE_URL) {
        keys ??= await flowKeys(db, c.FLOWS_PRIVATE_KEY);
        log(`forms key: ${keys.source === 'env' ? 'from FLOWS_PRIVATE_KEY' : keys.source === 'new' ? 'made a new one (kept in the database)' : 'loaded from the database'}`);
        if (await registerFlowsKey(o, keys.publicKeyPem)) {
          const endpoint = `${c.PUBLIC_BASE_URL.replace(/\/$/, '')}/flows/endpoint`;
          // if Meta refuses a newer form feature, fall back to the plain version so My orders keeps working
          const ex = localPhone(settings.waNumber()) || undefined; // Hoolam's number as the example in phone hints
          let id = await ensureOrdersFlow(into('orders'), endpoint, ordersFlowJson('FILTER', false, ex));
          if (!id) { id = await ensureOrdersFlow(into('orders', true), endpoint, ordersFlowJson('FILTER', true, ex)); backupForms.list = !!id; if (id) log('orders form: using the backup version'); }
          let one = await ensureOrderFlow(into('order'), endpoint, ordersFlowJson('ORDER', false, ex));
          if (!one) { one = await ensureOrderFlow(into('order', true), endpoint, ordersFlowJson('ORDER', true, ex)); backupForms.one = !!one; if (one) log('order form: using the backup version'); }
          await ensureAmbDetailsFlow(into('ambDetails'), endpoint);
          { const j = payoutFormJson(); await ensureLiveFlow(into('payout'), j, payoutFormName(endpoint, j), 'payout account form', endpoint); }
        } else for (const k of ['orders', 'order', 'ambDetails', 'payout'] as FormKey[]) forms.failed(k, 'Meta didn\'t accept the forms key, so the live forms can\'t start (see the Render log)');
      } else for (const k of ['orders', 'order', 'ambDetails', 'payout'] as FormKey[]) forms.off(k, 'Switched off on Render (WHATSAPP_ORDERS_FORM=false) or no PUBLIC_BASE_URL');
    } catch (e) {
      log(`WhatsApp setup failed: ${(e as Error).message}`);
    }
  }

  // ---------- the staff console (/console) ----------
  // live chat on the website, answered from the console's support widget
  const liveChat = new LiveChat({ db, settings, messenger, currency: c.CURRENCY, siteUrl: c.SITE_URL || 'https://hoolam.com', log });
  registerLiveChatRoutes(app, liveChat, db, log);
  const staffAuth = new StaffAuth(db, { setupToken: c.ADMIN_TOKEN, baseUrl: c.PUBLIC_BASE_URL, twoStep: () => settings.get<boolean>('two_step_login') === true });
  const waLink = (text: string) => `https://wa.me/${settings.waNumber().replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
  const itemUrl = (code: string) => `${c.PUBLIC_BASE_URL.replace(/\/$/, '')}/i/${code}`;
  const tellSeller = async (userId: string, fn: (phone: string) => Promise<unknown>) => { const p = await phoneOf(userId); if (p) await fn(p); };
  const marketConsole = {
    m: market, itemUrl,
    adUrl: (code: string, ad: string) => waLink(`Hi Hoolam, I want to buy this: ${code} (ad ${ad})`),
    tell: {
      removed: (l: Listing, reason: string, stopped: boolean) => tellSeller(l.seller_id, (p) => chat.mkt!.notify(p, l, stopped ? 'stopped' : 'removed', reason)),
      decided: (id: string, ok: boolean, reason: string | null) => tellSeller(id, (p) => chat.mkt!.decided(p, ok, reason)),
      upgraded: (id: string, ok: boolean, items: number) => tellSeller(id, (p) => chat.mkt!.upgraded(p, ok, items)),
      allowed: (id: string) => tellSeller(id, (p) => chat.mkt!.allowedAgain(p)),
    },
  };
  registerConsoleApi(app, { config: c, db, deals, trust, links, ambassadors, market: marketConsole, activity, sources, chatArt, siteShow, settings, kyc, forms, chat: liveChat, retryForms: async () => { forms.wake(); await setupMeta(); }, messenger, provider, auth: staffAuth, siteMedia, siteSync, log, refreshTemplates: () => refreshTemplates() });
  registerConsoleStatic(app, log);

  /** Background work: retry webhooks that failed, check slow payouts, nudge and expire. */
  async function tick(kind: 'fast' | 'slow') {
    if (kind === 'fast') {
      for (const source of ['payments', 'whatsapp']) {
        for (const id of await pendingEvents(db, source)) await processEvent(db, id, handlers[source]!, log);
      }
      await deals.pollPayouts();
      const lc = await liveChat.sweep().catch((e) => { log(`live chat sweep: ${(e as Error).message}`); return null; });
      if (lc?.notified) log(`live chat: told ${lc.notified} visitor(s) on WhatsApp about a rep's reply`);
    } else {
      if (ALL_TEMPLATES.some((t) => messenger.templateStatus(t.name) !== 'APPROVED')) await refreshTemplates().catch((e) => log(`templates: ${(e as Error).message}`));
      const r = await deals.sweep({ nudgeAfterHours: settings.nudgeHours() });
      if (r.nudged || r.expired) log(`sweep: nudged ${r.nudged}, expired ${r.expired}`);
      await trust.purgeSeen().catch((e) => log(`seller page stats: ${(e as Error).message}`)); // the one-way visitor codes last 2 days
      await marketJobs().catch((e) => log(`market: ${(e as Error).message}`));
      await activity.purge().catch((e) => log(`activity: ${(e as Error).message}`));
      // ambassadors: term notices and rollovers, the monthly payouts, month-end summaries
      const a = await ambassadors.sweep().catch((e) => { log(`ambassadors: ${(e as Error).message}`); return null; });
      if (a && (a.notices || a.rolled || a.payouts || a.summaries)) log(`ambassadors: ${a.notices} notice(s), ${a.rolled} term(s) renewed, ${a.payouts} payout(s) made, ${a.summaries} summary(ies)`);
    }
  }

  /** The market's regular work: "hides soon" and expired notices, promos that ended, and the bring-back messages (each off unless switched on). */
  async function marketJobs() {
    const cfg = market.cfg();
    if (!cfg.on || !chat.mkt) return;
    const mk = chat.mkt;
    const tell = async (l: Listing, kind: 'expiring' | 'expired' | 'promoEnded') => { const p = await phoneOf(l.seller_id); if (p) await mk.notify(p, l, kind).catch((e) => log(`market notice: ${(e as Error).message}`)); };
    const due = await market.expiryDue();
    for (const l of due.warn) await tell(l, 'expiring');
    for (const l of due.expired) await tell(l, 'expired');
    for (const l of await market.promosEnded()) await tell(l, 'promoEnded');
    if (cfg.backInStock || cfg.newFromSellers) {
      for (const b of await market.toAskUpdates()) { await mk.askUpdates(b.phone); await market.setBrowser(b.user_id, { asked: true }); }
    }
    if (cfg.newFromSellers) {
      for (const [sellerId, ids] of await market.newBySeller()) {
        const cards = (await Promise.all(ids.slice(0, 9).map((id) => market.card(id)))).filter((x): x is NonNullable<typeof x> => !!x);
        for (const b of await market.pastBuyers(sellerId)) { await mk.newFromSeller(b.phone, cards); await market.newsSent(b.user_id); }
      }
    }
  }

  const load = async () => { await settings.load(); await siteMedia.load(); };
  app.addHook('onClose', async () => siteSync.stop());
  return {
    app, load, deals, chat, market, liveChat, messenger, trust, links, ambassadors, settings, kyc, checker, siteMedia, siteSync, staffAuth, tick, syncMenu, setupMeta, orders, formSecret,
    forms,
    setBuyForm: (f: FormUse | null) => forms.set('buy', f), setSellForm: (f: FormUse | null) => forms.set('sell', f),
    setOrdersForm: (f: FormUse | null) => forms.set('orders', f), setOrderForm: (f: FormUse | null) => forms.set('order', f), backupForms,
  };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
