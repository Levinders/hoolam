import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  SITE_URL: z.string().optional(),
  CONSOLE_URL: z.string().optional(),                   // e.g. https://console.hoolam.com: the console only opens there
  PAY_URL: z.string().optional(),                       // e.g. https://pay.hoolam.com: short payment links (pay.hoolam.com/HL-ABCDE)
  SITE_DEPLOY_HOOK: z.string().optional(),              // Render deploy hook of the landing page: rebuilt after logo, picture, fee or number changes                      // the landing page (e.g. https://hoolam.ng); the server's / sends visitors there
  PUBLIC_BASE_URL: z.string().optional(),               // where public seller pages live; on Render this is filled in automatically
  RENDER_EXTERNAL_URL: z.string().optional(),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),

  // WhatsApp Cloud API
  WHATSAPP_DRY_RUN: bool.default(true),               // true = log messages instead of sending
  WHATSAPP_VERIFY_TOKEN: z.string().default('change-me'),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_PUBLIC_NUMBER: z.string().default('2340000000000'), // digits only, used in wa.me links
  WHATSAPP_GRAPH_VERSION: z.string().default('v26.0'),
  WHATSAPP_SYNC_MENU: bool.default(true),             // on start, send ice breakers + commands to Meta (live mode only)
  WHATSAPP_WABA_ID: z.string().default(''),           // WhatsApp Business Account ID: needed to create the buyer form and seller alert
  WHATSAPP_BUY_FORM: bool.default(true),              // offer buyers the WhatsApp form (falls back to chat questions if unavailable)
  WHATSAPP_FORM_MODE: z.enum(['draft', 'published']).default('draft'), // 'published' once your business is verified by Meta
  WHATSAPP_ORDERS_FORM: bool.default(true),           // "My orders" as a live WhatsApp form (needs the encrypted forms endpoint)
  FLOWS_PRIVATE_KEY: z.string().optional(),           // optional: the forms endpoint's private key (PEM). If unset, the server makes one and keeps it in the database

  // Payments
  PAYMENT_PROVIDER: z.enum(['monnify', 'fake']).default('fake'),
  MONNIFY_BASE_URL: z.string().default('https://sandbox.monnify.com'),
  MONNIFY_API_KEY: z.string().default(''),
  MONNIFY_SECRET_KEY: z.string().default(''),
  MONNIFY_CONTRACT_CODE: z.string().default(''),
  MONNIFY_WALLET_ACCOUNT: z.string().default(''),     // source account for payouts
  MONNIFY_REQUIRE_SIGNATURE: bool.default(false),     // sandbox webhooks are unsigned; set true in production

  // ID checks (KYC): BVN or NIN, once per person. 'prembly' when PREMBLY_X_API_KEY is set; 'fake' (pretend checks) with
  // pretend money; otherwise 'off' (then nobody can go above the no-ID limit unless staff raise it for them).
  KYC_PROVIDER: z.enum(['prembly', 'fake', 'off']).optional(),
  PREMBLY_X_API_KEY: z.string().default(''),          // Prembly → API keys: the secret key (sent as x-api-key)
  PREMBLY_APP_ID: z.string().default(''),             // Prembly → API keys: the app ID (sent as app-id)
  PREMBLY_BASE_URL: z.string().default('https://api.prembly.com'),
  PREMBLY_BVN_PATH: z.string().default('/identitypass/verification/bvn'), // from the Prembly dashboard (API integrations)
  PREMBLY_NIN_PATH: z.string().default('/identitypass/verification/nin'), // the same pattern (the dashboard shows no NIN example)

  // Testing: lets one phone play both seller and buyer. Only allowed with the fake payment provider.
  ALLOW_SELF_DEAL: bool.default(false),

  // Deals
  CURRENCY: z.enum(['NGN', 'XOF']).default('NGN'),
  MAX_DEAL_MINOR: z.coerce.number().default(50_000_00), // Phase 1 cap per deal, before KYC: ₦50,000
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(40),
  SELLER_ACCEPT_HOURS: z.coerce.number().default(48),   // a seller has this long to accept a buyer's deal
  TRUST_COUNT_TEST_DEALS: bool.default(false),          // true only while testing with pretend money, so trust cards show numbers
  NUDGE_AFTER_HOURS: z.coerce.number().default(24),     // remind the buyer to confirm
  FLAG_AFTER_HOURS: z.coerce.number().default(72),      // put the deal in front of a human
});

export type Config = z.infer<typeof schema> & { PUBLIC_BASE_URL: string; KYC: 'prembly' | 'fake' | 'off' };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const d = parsed.data;
  const KYC = d.KYC_PROVIDER ?? (d.PREMBLY_X_API_KEY ? 'prembly' : d.PAYMENT_PROVIDER === 'fake' ? 'fake' : 'off');
  const c = { ...d, KYC, PUBLIC_BASE_URL: d.PUBLIC_BASE_URL || d.RENDER_EXTERNAL_URL || 'http://localhost:3000' };
  if (c.KYC === 'prembly' && !c.PREMBLY_X_API_KEY) throw new Error('KYC_PROVIDER=prembly needs PREMBLY_X_API_KEY');
  if (c.KYC === 'fake' && c.PAYMENT_PROVIDER !== 'fake') throw new Error('KYC_PROVIDER=fake (pretend ID checks) only works with pretend money (PAYMENT_PROVIDER=fake).');
  if (c.PAYMENT_PROVIDER === 'monnify' && (!c.MONNIFY_API_KEY || !c.MONNIFY_SECRET_KEY || !c.MONNIFY_CONTRACT_CODE)) {
    throw new Error('PAYMENT_PROVIDER=monnify needs MONNIFY_API_KEY, MONNIFY_SECRET_KEY and MONNIFY_CONTRACT_CODE');
  }
  if (!c.WHATSAPP_DRY_RUN && (!c.WHATSAPP_TOKEN || !c.WHATSAPP_PHONE_NUMBER_ID || !c.WHATSAPP_APP_SECRET)) {
    throw new Error('WHATSAPP_DRY_RUN=false needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET');
  }
  if (c.ALLOW_SELF_DEAL && c.PAYMENT_PROVIDER !== 'fake' && !/sandbox/i.test(c.MONNIFY_BASE_URL)) {
    throw new Error('ALLOW_SELF_DEAL only works with pretend money or the Monnify sandbox. Remove it before using live keys.');
  }
  return c;
}
