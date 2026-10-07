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
2. Copy your **API key**, **secret key**, **contract code** and **wallet account number** into `.env`, set `PAYMENT_PROVIDER=monnify`.
3. In the dashboard, set the webhook URL to `https://your-domain.com/webhook/payments`.
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
   we record the message as `NEEDS_TEMPLATE` (see `/admin/attention`). Submit these **utility** templates to Meta:
   - `payment_received_seller`: "The buyer has paid for deal {{1}}. Your {{2}} is held safely by Hoolam. Ship the item now."
   - `item_on_the_way`: "Your item for deal {{1}} is on the way. When it arrives, tell us if you're happy."
   - `confirm_reminder`: "Has your item for deal {{1}} arrived? Your money is still safe with us."
   - `seller_paid`: "You've been paid. {{1}} has been sent to your {{2}} account for deal {{3}}."
   - `refund_sent`: "Your refund of {{1}} for deal {{2}} has been sent to your {{3}} account."

## Buyer starts the deal

A buyer describes what they're buying (item, agreed price, up to 3 photos, the seller's WhatsApp, an optional
arrival date) in a **WhatsApp form**, or answers the same questions in the chat. Hoolam then:

1. Saves the deal as `AWAITING_SELLER`, with the photos kept as proof of what was promised.
2. Alerts the seller once with the approved template `hoolam_order_request` (**View deal** / **Not me**), and gives the
   buyer a `View HL-…` link to forward too. "Not me" numbers are never alerted again (`contact_optouts`).
3. The seller sees the photos and taps **Accept** (adds a bank account if needed) or **Decline**.
4. The buyer is asked to pay. From there it's the normal deal. Unanswered deals expire after `SELLER_ACCEPT_HOURS` (48).

Form: `src/whatsapp/buy-flow.ts` (banner: `assets/buy-banner.png`). Template wording: `SELLER_ALERT` in
`src/whatsapp/automation.ts`. Both are created on Meta at startup when `WHATSAPP_WABA_ID` is set; see
[docs/WHATSAPP-TEST-SETUP.md](docs/WHATSAPP-TEST-SETUP.md) section F. Photos: `GET /admin/deals/HL-XXXXX` lists them.

## Seller starts the deal

**Whoever starts the deal pays Hoolam's fee.** A seller's deal: the buyer pays just the price, the seller receives
the price minus the fee. A buyer's deal: the buyer pays price + fee, the seller receives the full price.

1. The seller gives the item, price, up to 3 photos and (optionally) the buyer's WhatsApp, in the seller form or the chat.
2. The buyer is alerted once with the template `hoolam_payment_request` (**View deal** / **Not me**); the seller also gets
   a `Pay HL-…` link to forward. The buyer sees the photos, then **Pay now**.
3. On a buyer's deal the seller can **✏️ Change price**: the buyer gets the new total and accepts or cancels.
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

## The WhatsApp menu

People never face an empty chat:

- **Main menu**: "hi", "menu", any unknown text, or the **Main menu** button under finished steps shows a list
  behind an **Open menu** button. Edit the options in `MENU` at the top of `src/whatsapp/messages.ts`
  (10 options max, title up to 24 characters, description up to 72), then handle a new option in
  `openMenuItem` in `src/whatsapp/flow.ts`.
- **Ice breakers** (4 suggestions in a brand-new chat) and **`/` commands**: in `src/whatsapp/automation.ts`.
  They're sent to Meta every time the server starts (log line `whatsapp menu sync OK`). Turn that off with
  `WHATSAPP_SYNC_MENU=false`. If Meta refuses, set them by hand in WhatsApp Manager > Automations.
- **Welcome**: when someone opens the chat for the first time, WhatsApp tells us and we send the menu.

## Landing page (`site/`)

The public website. One HTML file (`site/index.html`) plus `site/assets/`, served by Render as a **Static Site**:
free, on a CDN, and it never sleeps, so the first impression is instant even while the server is on the free plan.

- **Run from the console.** Fees, the deal limit, the WhatsApp number, the logo and every picture are set in
  Console → Settings. Each site build copies them in from the server (`GET /site.json`), so the page loads complete
  and instantly from Render's CDN, and the page also checks the server for anything newer once it's awake.
- **Images by position, not by name.** Spots are numbered top to bottom (Section 1 · Image 1 …, Section 3 · Step 4,
  Section 5 · Person 2), so the words on the page can change without renaming anything. Step 2 always shows the logo
  icon. A spot with no upload keeps its drawing.
- **Still placeholders** (marked on the page): bank partner, registration and licence numbers, guarantee terms,
  data protection registration, Terms, Privacy, company details, and the three quotes. Fill these in before you share
  the link widely. The quotes must come from real people.
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
- **Needs action**: problems, payouts waiting for an OTP, failed payouts, short payments, "Talk to a person" messages,
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
| `GET /admin/support` | Messages from "Talk to a person" (add `?status=CLOSED` for old ones) |
| `POST /admin/messages/send` `{"phone":"+234…","text":"…"}` | Reply to someone as Hoolam (within 24 hours of their last message) |
| `POST /admin/support/:id/close` | Mark a "Talk to a person" message as handled |
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
