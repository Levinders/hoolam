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

## Admin (Phase 1 runs with a human in the loop)

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
- **Limits:** deals are capped at ₦50,000 before identity checks (`MAX_DEAL_MINOR`).

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
