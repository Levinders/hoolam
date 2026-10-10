# Hoolam backend: Phase 1

Safe deals on WhatsApp. Hoolam holds the buyer's money until they're happy, then pays the seller.

This is the Phase 1 core loop for **Nigeria (NGN)**, with **Monnify (Moniepoint)** as the first payment partner:

1. A seller creates a deal in the WhatsApp chat (item, price, payout account) and gets a link.
2. The buyer opens the link and gets a one-time account number to transfer to.
3. Monnify tells us the money landed; we **re-check it with Monnify's API** before believing it.
4. The seller is told to ship. The buyer taps **I'm happy** or **Problem**.
5. Happy: the seller is paid to their bank. Problem: the money is frozen and a person decides.

Voice notes, riders and the 24-hour automatic release come in Phase 2.

## Try it in two minutes (no accounts needed)

Needs Node 20+.

```bash
npm install
npm run chat       # chat with Hoolam in your terminal, playing both seller and buyer
npm run simulate   # plays a whole deal automatically and prints the conversation
npm test           # 65 tests: pricing, ledger, payments, the full deal, disputes, payouts
```

In `npm run chat`, type `help` for the commands: `open` (buyer taps the seller's link), `pay` / `pay 5000`
(the transfer lands, in full or short), `1` `2` `3` to tap buttons, `payout fail|otp|ok`, and `admin refund|release`.

Both start a throwaway database automatically. No real money or real WhatsApp is involved.

## Test on your own phone (real WhatsApp, pretend money)

Follow [docs/WHATSAPP-TEST-SETUP.md](docs/WHATSAPP-TEST-SETUP.md): Supabase + Meta's free test number + Render, about 30 minutes.
With `ALLOW_SELF_DEAL=true`, one phone plays both seller and buyer, and replying "paid" pretends the transfer landed.

## Run the server

1. Create a Postgres database (Supabase works). Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `ADMIN_TOKEN`.
2. `npm run dev` (migrations run automatically on start).
3. Check `http://localhost:3000/health`.

With `PAYMENT_PROVIDER=fake` you can test payments locally: after a buyer taps **Pay now**,
`POST /dev/pay/HL-XXXXX` pretends the transfer arrived.

## Connect Monnify (sandbox first)

1. Sign up at monnify.com (needs your CAC registration) and open the **sandbox** dashboard.
2. Copy your **API key**, **secret key**, **contract code** and **wallet account number** into Render (hoolam → Environment):
   `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE`, `MONNIFY_WALLET_ACCOUNT`, `MONNIFY_BASE_URL=https://sandbox.monnify.com`,
   and set `PAYMENT_PROVIDER=monnify`. (`.env` for running it on your own computer.)
3. In the dashboard, set the webhook URL to `https://hoolam.onrender.com/webhook/payments` (Console → Settings → Payments shows it with a Copy button).
   **Console → Settings → Payments → Run check** then logs in, reads the wallet, can look up an account name and create a ₦100 test payment, without
   paying anything out. In the sandbox, deals are test deals (never on trust cards or in Money) and `ALLOW_SELF_DEAL` still works.
4. Check your keys first, with no database or WhatsApp needed: `npm run monnify:check`.
   It logs in, lists banks, creates a ₦100 test payment you pay with Monnify's bank simulator
   (https://websim.sdk.monnify.com/#/bankingapp), and can test a payout:
   `npm run monnify:check -- --payout 058 0123456789`.
5. Before going live: set `MONNIFY_REQUIRE_SIGNATURE=true`, only accept webhooks from Monnify's IP (`35.242.133.146`) at your host or firewall, and confirm the two endpoints marked *confirm in sandbox* in `src/payments/monnify.ts`.

**Payout approval:** Monnify can require an email OTP for each payout. Until they enable API payouts without it,
payouts wait in `PAYOUT_PENDING` and you approve them with `POST /admin/payouts/:reference/authorize {"otp":"…"}`.

> Monnify on its own is a payment gateway: money sits in your Monnify wallet. For real escrow you still need the
> **designated client-funds account** agreement with Moniepoint (or another licensed bank) and a lawyer's sign-off.

## Connect WhatsApp

1. Create a Meta app with the WhatsApp product and verify your business.
2. Fill in `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PUBLIC_NUMBER`, set `WHATSAPP_DRY_RUN=false`.
3. Webhook URL: `https://your-domain.com/webhook/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`. Subscribe to `messages`.
4. **Templates:** WhatsApp only allows free-form messages within 24 hours of the person's last message. Outside that window
   Hoolam sends a pre-approved **utility template** instead (`src/whatsapp/automation.ts`: `SELLER_ALERT`, `BUYER_ALERT`, `DEAL_TEMPLATES`).
   The server submits all 12 to Meta on start (needs `WHATSAPP_WABA_ID`), checks every 10 minutes until they're approved, and
   uses each one as soon as it is. Console → Settings → WhatsApp shows each template and its status. Until one is approved,
   that update is kept as `NEEDS_TEMPLATE` and shows in Needs action. A reworded template gets a new name and lists the
   old one in `replaces`: while Meta reviews the new wording, the old approved version keeps going out, so nothing stops. Templates also need a **payment method** on the
   WhatsApp Business account (Meta → WhatsApp Manager / Billing).

## Buyer starts the deal

A buyer fills in a three-page **WhatsApp form** (every answer required), or answers the same questions in the chat:

1. **The item**: name, description, category (`src/deals/categories.ts`), agreed price, the seller's WhatsApp.
2. **Delivery**: delivery with a fee, free delivery, or pickup; the fee if there is one; the date they need it.
3. **Photos**: 1 to 3, from the gallery or the camera (up to 25 MB each; shrunk to a 1600px JPEG on arrival).

**Delivery fee:** paid by the buyer on top of the price, held with it, and paid to the seller with it (the seller
arranges the rider). Hoolam's fee is on the item price only. A refund returns everything, delivery fee included.
Stored as `deals.delivery_fee_minor`; `buyer_pays = price + delivery + fee`, `seller_gets = price + delivery`.

Hoolam then:

1. Saves the deal as `AWAITING_SELLER`, with the photos kept as proof of what was promised.
2. Alerts the seller once with the approved template `hoolam_new_order_request` (**View order** / **Not me**), and gives the
   buyer a `View HL-…` link to forward too. "Not me" numbers are never alerted again (`contact_optouts`).
3. The seller sees the photos and taps **Accept** (adds a bank account if needed) or **Decline**.
4. The buyer is asked to pay. From there it's the normal deal. Unanswered deals expire after `SELLER_ACCEPT_HOURS` (48).

Form: `src/whatsapp/buy-flow.ts` (banner: `assets/buy-banner.png`). Template wording: `SELLER_ALERT` in
`src/whatsapp/automation.ts`. Both are created on Meta at startup when `WHATSAPP_WABA_ID` is set; see
[docs/WHATSAPP-TEST-SETUP.md](docs/WHATSAPP-TEST-SETUP.md) section F. Photos: `GET /admin/deals/HL-XXXXX` lists them.

## After the buyer pays: dispatch, handover code, rider paid

For orders a buyer starts (`started_by='BUYER'`):

1. **Paid** → the seller gets **Dispatch now** / **Can't fulfil** (template `hoolam_order_paid_dispatch`).
2. **Dispatch** (in the My orders form, or the chat): **pickup** (address), **rider** (name, phone, fee, drop-off,
   account) or **waybill** (driver's phone, fee, location, account). The account name is looked up with the bank and
   shown back before anything is saved (`bank_accounts.holder='COURIER'`, never anyone's default account).
3. The buyer gets the rider/driver details and a **4-digit handover code** (`deals.handover_code`). The seller is told:
   ask the receiver for the code. Five wrong tries lock it (Needs action).
4. **Correct code** → `handed_over_at`; the delivery fee moves `held:deal → payable:courier` and is paid out at once
   (payout kind `DELIVERY`). The buyer gets **I'm happy / Problem** and a window (Console → Settings → Timing →
   *Pay the seller automatically after*, `auto_release_minutes`, default 24 h). Silence → the sweep releases.
5. **Release** pays the seller everything still held minus Hoolam's fee (so minus the delivery fee already paid).
   If no code was entered but the buyer taps I'm happy, the rider is paid first, then the seller.
   **Refunds** return everything still held (a delivery fee already paid can't come back).
6. **Reminders** (sweep): the seller after `dispatch_remind_hours` (default 12) if not dispatched; the buyer once the
   expected date passes, with **Send reminder** / **Refund me** (template `hoolam_order_overdue`).

## My orders: a live WhatsApp form

"My orders" (menu, `/orders`) opens a form that loads live data from `POST /flows/endpoint`
(`src/whatsapp/orders-flow.ts`): **Pending / Completed / All**, 20 per page newest first, each order with its photos
and only the next step for that person (accept, dispatch, enter code, pay, show code, I'm happy, refund…). Dispatch
and the handover code also open straight into this form. Every action is the same code as the chat buttons.

- **Encryption:** WhatsApp encrypts every request. The server makes an RSA key once and keeps it in the database
  (`app_secrets`), registers the public half with Meta on start (log: `forms key: registered with Meta`), and creates
  the form with `endpoint_uri = PUBLIC_BASE_URL/flows/endpoint`. Optional: `FLOWS_PRIVATE_KEY` (PEM) on Render overrides
  the stored key. `WHATSAPP_ORDERS_FORM=false` turns the form off; the chat list and questions are used instead.
- **Who's who:** the form carries a signed token (`o1.<phone>.<mode>.<entry>.<code>.<exp>.<sig>`, 72 h).

## Private order page

`/o/HL-XXXXX?k=<view_token>`: a receipt-style page (photos, details, money, delivery, progress). The link is sent only
to the buyer and seller (order ready, paid, dispatched, and in the My orders form). Not indexed; never shows the
handover code.

## Seller starts the deal

**Whoever starts the deal pays Hoolam's fee; the other side pays a flat transaction fee** (bands by order total, set in
Console → Settings → Fees: "Seller transaction fee" and "Buyer transaction fee", default ₦500 / ₦1,000 / ₦1,500 /
₦2,000 / ₦2,500 at ₦100k steps). A buyer's deal: the buyer pays price + Hoolam fee, the seller receives the price
minus the seller's transaction fee. A seller's deal: the buyer pays price + the buyer's transaction fee, the seller
receives the price minus Hoolam's fee. Stored as `deals.txn_fee_minor` / `txn_fee_payer`; both fees land in
`revenue:fees` at release. Each person only sees their own fee (chat, forms, and their own order page link).
Refunds return everything still held, so a buyer's transaction fee comes back and the seller pays none.

1. The seller gives the item, price, up to 3 photos and (optionally) the buyer's WhatsApp, in the seller form or the chat.
2. The buyer is alerted once with the template `hoolam_order_payment_request` (**View order** / **Not me**); the seller also gets
   a `Pay HL-…` link to forward. The buyer sees the photos, then **Pay now**.
3. On a buyer's deal the seller can **✏️ Update price** (with a reason): the buyer gets the new price, Hoolam fee and total, and accepts or cancels.
4. After **I've sent it**, the seller can send a photo or a tracking note as proof of shipping. The buyer sees it; it's
   kept with the deal (`deal_photos.kind = 'SHIPPING'`, `deals.shipping_note`) for disputes.

## Trust card

A seller's record, counted from real deals paid through Hoolam (`src/trust.ts`), so it can't be faked:
deals completed, different buyers, typical shipping time, problems reported and how they ended, 👍/👎 from buyers,
and the bank-verified payout name. Test deals (pretend money) and self-deals never count; new sellers show
"🌱 New on Hoolam". Set `TRUST_COUNT_TEST_DEALS=true` only while testing.

- **Before paying:** one line above **Pay now** (`🛡️ Bayo · ✅ 48 deals · 👍 96%`) and a **🛡️ Seller's record** button.
- **🔍 Check a seller:** by WhatsApp number or deal code, then **🛒 Buy from them**.
- **🛡️ My trust card:** sellers see their card, set a shop name and city, and **share** a public page
  `/s/<name>` (or hide it). The page's **Buy safely** button opens WhatsApp with `Buy from @<name>`, which starts a
  buyer's deal already pointed at that seller.
- **After "I'm happy":** 👍 Great / 👎 Not great. A 👎 can add a private note (team only, in `/admin/attention`).
- Sellers see a short buyer record on deals too: `👤 Ada · 🛍️ 12 purchases · no problems reported`.


**Public page** (`/s/<name>`, e.g. `go.hoolam.com/s/bayo-kicks`): the seller's photo (tap to see it large), their
Instagram, TikTok, Facebook and website, the trust card numbers, how buying safely works, and one button that starts a
protected deal on WhatsApp. It uses the logo from Console → Settings → Brand. Sharing the link shows a card with the
seller's photo in it (`/s/<name>/share.jpg`).

Sellers set their photo and links on WhatsApp: **My trust card → Edit my page**. They can type links any way
(`@bayokicks`, `instagram.com/bayokicks`, `bayokicks.com`); Hoolam cleans them up and refuses anything odd.
Owners and admins can remove an unsuitable photo or link from the person's page in the console (with a reason, in the
audit trail). Try it locally: `npx tsx scripts/trust-demo.ts`, then open `http://localhost:4300/s/bayo-kicks`.

## The WhatsApp menu

People see **orders**, never "deals" (the code and database still say `deal`). There are two menus:

| Buying (everyone starts here) | Selling (after the seller setup) |
|---|---|
| 🛒 Buy something | 🏷️ Sell something |
| 🔑 I have an order code | 📋 My orders (what they sold) |
| 📋 My orders (what they bought) | 🛡️ My trust card |
| 🔍 Check a seller | 🏦 Payout account |
| **Help:** Report a problem · How it works · Talk to a rep · Switch to selling | **Help:** Report a problem · How it works · Talk to a rep · Switch to buying |

- **Which menu**: `users.menu_mode`, shown only once `users.seller_since` is set. It follows what they last did: paying
  with a code, starting a buy or tapping a buyer alert puts them on buying; selling or accepting an order puts them on
  selling. **Switch to …** (or `/switch`) moves between them at any time.
- **Becoming a seller** (once): "Sell something", "Switch to selling" or "My trust card" asks for a shop name (or
  **Use this name**: the WhatsApp name) and a city (**Skip** works). That sets `seller_since` and creates the trust
  card. Someone who accepts a buyer's order becomes a seller straight away, with no questions.
- **Report a problem**: a buyer picks a paid order and the money freezes. A seller picks an open order and writes to a
  rep; it lands in Support tagged `[Order HL-…]` and freezes nothing.
- **Welcome**: a brand-new chat gets the story in four lines and three buttons: **I'm buying** (buying menu),
  **I'm selling** (setup, then straight into the first sale) and **How it works**.
- **Editing**: `BUYER_MENU` and `SELLER_MENU` at the top of `src/whatsapp/messages.ts` (10 rows max, title up to 24
  characters, description up to 72); handle a new option in `openMenuItem` in `src/whatsapp/flow.ts`.
- **Ice breakers** (4 suggestions in a brand-new chat) and **`/` commands**: in `src/whatsapp/automation.ts`.
  They're sent to Meta every time the server starts (log line `whatsapp menu sync OK`). Turn that off with
  `WHATSAPP_SYNC_MENU=false`. If Meta refuses, set them by hand in WhatsApp Manager > Automations.

## Landing page (`site/`)

The public website: the home page (`site/index.html`), the legal pages (`site/legal/`) and `site/assets/`, served by Render as a **Static Site**:
free, on a CDN, and it never sleeps, so the first impression is instant even while the server is on the free plan.

- **Run from the console.** Fees, the deal limit, the WhatsApp number, the logo and every picture are set in
  Console → Settings. Each site build copies them in from the server (`GET /site.json`), so the page loads complete
  and instantly from Render's CDN, and the page also checks the server for anything newer once it's awake.
- **Images by position, not by name.** Spots are numbered top to bottom (Section 1 · Image 1 …, Section 3 · Step 4,
  Section 5 · Person 2), so the words on the page can change without renaming anything. Step 2 always shows the logo
  icon. A spot with no upload keeps its drawing.
- **Legal pages** at `/legal/`: Terms of service, Privacy policy (NDPA 2023), Holding agreement, If something goes
  wrong, Acceptable use, Where the money sits, Cookies, Delete your data. Each is a fragment in `site/legal/<page>.html`
  wrapped in `site/legal/_layout.html`; fees, limits and timings are filled in from the console at build time, so the
  pages always match what the bot charges. Change `LEGAL_EFFECTIVE` in `site/build.mjs` whenever their wording changes.
- **The company** (`COMPANY` in `site/build.mjs`): HOOLAM DIGITAL PLATFORM LTD, RC 9919417, and the registered address,
  exactly as on the CAC certificate. Meta's business verification checks the website against these.
- **Footer** (`site/partials/footer.*`), shared by every page. Email, phone and social links come from
  Console → Settings → Contact; a social left empty doesn't show.
- **For Meta** (WhatsApp app → App settings → Basic): Privacy policy URL `https://hoolam.com/legal/privacy/`,
  Terms of service URL `https://hoolam.com/legal/terms/`, User data deletion → instructions URL
  `https://hoolam.com/legal/delete-your-data/`.
- **The quotes section is hidden** (`<section class="voices" hidden>`) until there are real quotes from pilot users.
- The original Benin version is kept in `site/drafts/benin.html` (not published).
- Try it: `npm run build:site`, then open `dist-site/index.html`.

**Put it on Render** (once):
1. Render → **New → Static Site** → pick this repo.
2. Build command `node site/build.mjs`, publish directory `dist-site`.
3. Environment: `HOOLAM_APP_URL` only if the server isn't at `https://hoolam.onrender.com`.
4. **So console changes reach the site in about a minute:** static site → Settings → **Deploy Hook** → copy the URL.
   On the **server** (not the site), add it as `SITE_DEPLOY_HOOK`. After you upload an image or change a fee or the
   number, the server asks Render to rebuild the site (changes made close together count as one rebuild).
5. Every push to `site/` publishes the change by itself too.

**When you connect your domain**
1. Static site → Settings → Custom domains → add `yourdomain.com` (and `www`). Copy the records Render shows into
   your domain's DNS. Render adds HTTPS for free.
2. Optional: server → Custom domains → `app.yourdomain.com`; then set `HOOLAM_APP_URL` on the site and
   `PUBLIC_BASE_URL` on the server to that address.
3. Set `SITE_URL` = `https://yourdomain.com` on **both** services (link previews on WhatsApp, and the server's `/`
   forwards there).

## Addresses (one server, one job each)

All of these point at the same Render service (**hoolam**). Add each one under Render → hoolam → Settings →
Custom Domains when you need it, add the DNS record Render shows, then set the matching variable on **hoolam**.

| Address | For | Variable on hoolam |
|---|---|---|
| `hoolam.com` | The website (the **hoolam-landing-page** static site, not this server) | `SITE_URL=https://hoolam.com` |
| `console.hoolam.com` | Staff. The console only opens here; other addresses send staff to it | `CONSOLE_URL=https://console.hoolam.com` |
| `go.hoolam.com` | Buyers and sellers: trust pages `go.hoolam.com/s/bayo-kicks`, deal links | `PUBLIC_BASE_URL=https://go.hoolam.com` |
| `pay.hoolam.com` | Short payment links `pay.hoolam.com/HL-ABCDE` (opens WhatsApp to pay) | `PAY_URL=https://pay.hoolam.com` |
| `shop.` / `my.hoolam.com` | Kept for later. Add them as domains any time; for now they lead to the website | — |

Set `CONSOLE_URL` only after `console.hoolam.com` shows the padlock in Render, or the console will move to an
address that doesn't work yet. Meta and Monnify can keep calling `hoolam.onrender.com`.
On the free plan, `go.` and `pay.` links can take up to a minute to open the first time after the server sleeps.

## Hoolam Console (the team's control room)

A web app for staff at **`/console`** on the same server (`https://hoolam.onrender.com/console`). It uses the same
database, so there's nothing extra to host.

**What's in it**
- **Needs action**: problems, payouts waiting for an OTP, failed payouts, short payments, "Talk to a rep" messages,
  deals shipped but not confirmed, 👎 ratings, deals about to close. Most urgent first.
- **Deals**: search and filter every deal; open one to see its timeline, WhatsApp messages, money and photos.
  Release, refund, cancel, give the seller more time, message the buyer or seller, add internal notes.
- **Disputes**, **Money** (payouts and refunds, approve with OTP, retry, books check, CSV export for the accountant),
  **Buyers & sellers** (trust card, pause an account, set a deal limit per person), **Support** (reply on WhatsApp),
  **Insights** (money traded, fees, where deals stall, top sellers), **Settings** (fees, limits, timings, switches),
  **Team** (invite, roles, reset login), **Audit trail**.
- **Settings** (owners and admins only) has tabs: Fees (with a live calculator), Limits, Timing (with the deal timeline), WhatsApp
  (Hoolam's number, alerts, forms), Brand (logo and logo icon, used by the website and the console), Website images
  (every picture on the landing page, drag and drop, resized for phones automatically), and Change history.
- Search everything with **⌘K** / **Ctrl K**. Works on a phone too.

**Audit trail.** Every action (who, when, what, on which deal or person, and why) is saved. Money actions and
settings changes need a reason. The database refuses edits or deletes to the trail, even from the console.
Sign-ins are recorded too. Actions through the `ADMIN_TOKEN` API show up as "Admin token (API)".

**Sign-in.** Email + password + a 6-digit code from an authenticator app (Google Authenticator, Microsoft
Authenticator, 1Password…). 5 wrong tries locks the account for 15 minutes. Sessions end after 12 hours idle.

**First time**
1. Deploy, then open `/console`. It asks for a **setup key**: paste your `ADMIN_TOKEN` from Render's Environment tab.
2. Enter your name, email and a password (10+ characters, letters and a number).
3. Scan the QR code with your authenticator app and type the code. You're the **Owner**.
4. **Team → Invite someone**: pick a role, send them the link (works once, for 72 hours).

| Role | Can do |
|---|---|
| Owner | Everything: the team, fees, limits and Hoolam's WhatsApp number |
| Admin | Deals and disputes: release, refund, cancel, extend; pause accounts and set limits. Settings: timing, alerts and forms, logo and website images (sees fees, limits and the number, can't change them) |
| Finance | Approve and retry payouts, export for the accountant |
| Support | Reply to people, message buyers and sellers, add notes. Can't move money |

**Try it on your computer with pretend data:** `npm run build:console && npm run console:demo`, then open
`http://localhost:4000/console`. It prints the login and the current 6-digit code (or add the printed secret to your
authenticator app). Work on the look with `npm run console:dev` (hot reload; it talks to the server on port 3000).

Code: `src/console/` (API, sign-in, audit), `src/settings.ts` (live settings), `console/` (the React app).

## Admin API (scripts and emergencies)

The console does all of this with a screen and an audit trail. These routes remain for scripts.

All need `Authorization: Bearer <ADMIN_TOKEN>`.

| Route | What it does |
|---|---|
| `GET /admin/attention` | Problems, stuck payouts, quiet buyers, messages needing templates |
| `GET /admin/deals?status=DISPUTED` | List deals |
| `GET /admin/deals/HL-XXXXX` | Everything about one deal: history, payments, payouts, ledger |
| `POST /admin/deals/HL-XXXXX/release` | Pay the seller (after reviewing a problem) |
| `POST /admin/deals/HL-XXXXX/refund` | Refund the buyer in full |
| `POST /admin/payouts/:ref/authorize` | Approve a payout with Monnify's OTP |
| `POST /admin/payouts/:ref/retry` | Retry a failed payout (never pays twice) |
| `GET /admin/messages?status=FAILED` | What Hoolam tried to send, and WhatsApp's error if it failed |
| `GET /admin/ledger/balances` | Totals per ledger account |
| `GET /admin/support` | Messages from "Talk to a rep" (add `?status=CLOSED` for old ones) |
| `POST /admin/messages/send` `{"phone":"+234…","text":"…"}` | Reply to someone as Hoolam (within 24 hours of their last message) |
| `POST /admin/support/:id/close` | Mark a "Talk to a rep" message as handled |
| `POST /admin/whatsapp/sync-menu` | Re-send the ice breakers and `/` commands to Meta |

## How it's built

- **Node + TypeScript, Fastify, Postgres.** Schema in `db/migrations/`.
- **Money is integers in kobo**, always with a currency code. Benin (XOF) plugs into the same model.
- **Double-entry ledger** (`ledger_entries`): every movement is balanced, and the database itself refuses an unbalanced one.
- **Every status change is checked** against the allowed moves (`src/deals/states.ts`) and logged in `deal_events`.
- **Webhooks are stored first, deduplicated, then processed**, with retries for anything that fails.
- **Payments are swappable**: `src/payments/provider.ts` is the contract. Kuda, Safe Haven, or FedaPay/KKiaPay for Benin is one new file.
- **Pricing** (`src/pricing.ts`) uses the same rule as the landing page: % with a minimum, a cap, rounded to the nearest ₦100. Numbers are placeholders.
- **Limits:** deals are capped at ₦50,000 before identity checks. Change it, fees and timings live in Console → Settings (env values are the starting defaults).

| Path | |
|---|---|
| `src/deals/service.ts` | The deal logic: create, pay, ship, release, refund, payouts |
| `src/whatsapp/flow.ts` | The conversation |
| `src/whatsapp/messages.ts` | Every message we send, in one place |
| `src/payments/monnify.ts` | Monnify integration |
| `src/app.ts` | HTTP routes, webhooks, admin, background retries |

## Not in Phase 1 yet

Voice notes (Whisper), riders and doorstep rejection splits, the 24-hour automatic release, identity checks (NIN/BVN),
seller reputation, daily reconciliation against Monnify's settlement report, and WhatsApp template sending.
