import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
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

  // Payments
  PAYMENT_PROVIDER: z.enum(['monnify', 'fake']).default('fake'),
  MONNIFY_BASE_URL: z.string().default('https://sandbox.monnify.com'),
  MONNIFY_API_KEY: z.string().default(''),
  MONNIFY_SECRET_KEY: z.string().default(''),
  MONNIFY_CONTRACT_CODE: z.string().default(''),
  MONNIFY_WALLET_ACCOUNT: z.string().default(''),     // source account for payouts
  MONNIFY_REQUIRE_SIGNATURE: bool.default(false),     // sandbox webhooks are unsigned; set true in production

  // Testing: lets one phone play both seller and buyer. Only allowed with the fake payment provider.
  ALLOW_SELF_DEAL: bool.default(false),

  // Deals
  CURRENCY: z.enum(['NGN', 'XOF']).default('NGN'),
  MAX_DEAL_MINOR: z.coerce.number().default(50_000_00), // Phase 1 cap per deal, before KYC: ₦50,000
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(40),
  SELLER_ACCEPT_HOURS: z.coerce.number().default(48),   // a seller has this long to accept a buyer's deal
  NUDGE_AFTER_HOURS: z.coerce.number().default(24),     // remind the buyer to confirm
  FLAG_AFTER_HOURS: z.coerce.number().default(72),      // put the deal in front of a human
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  if (c.PAYMENT_PROVIDER === 'monnify' && (!c.MONNIFY_API_KEY || !c.MONNIFY_SECRET_KEY || !c.MONNIFY_CONTRACT_CODE)) {
    throw new Error('PAYMENT_PROVIDER=monnify needs MONNIFY_API_KEY, MONNIFY_SECRET_KEY and MONNIFY_CONTRACT_CODE');
  }
  if (!c.WHATSAPP_DRY_RUN && (!c.WHATSAPP_TOKEN || !c.WHATSAPP_PHONE_NUMBER_ID || !c.WHATSAPP_APP_SECRET)) {
    throw new Error('WHATSAPP_DRY_RUN=false needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET');
  }
  if (c.ALLOW_SELF_DEAL && c.PAYMENT_PROVIDER !== 'fake') {
    throw new Error('ALLOW_SELF_DEAL only works with PAYMENT_PROVIDER=fake');
  }
  return c;
}
