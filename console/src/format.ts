/** Money is stored in kobo (minor units). */
export function money(minor: number | string | null | undefined, currency = 'NGN', opts: { sign?: boolean } = {}): string {
  const n = Number(minor ?? 0);
  const major = currency === 'NGN' ? n / 100 : n;
  const abs = Math.abs(major).toLocaleString('en-NG', { maximumFractionDigits: Number.isInteger(major) ? 0 : 2, minimumFractionDigits: 0 });
  const s = currency === 'NGN' ? `₦${abs}` : `${abs} CFA`;
  return (major < 0 ? '−' : opts.sign && major > 0 ? '+' : '') + s;
}

/** Short, compact money for chart axes: ₦1.2m, ₦45k. */
export function moneyShort(minor: number, currency = 'NGN'): string {
  const major = currency === 'NGN' ? minor / 100 : minor;
  const p = currency === 'NGN' ? '₦' : '';
  if (Math.abs(major) >= 1_000_000) return `${p}${(major / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (Math.abs(major) >= 1_000) return `${p}${Math.round(major / 1_000)}k`;
  return `${p}${Math.round(major)}`;
}

export function dateTime(at: string | Date | null | undefined): string {
  if (!at) return '';
  return new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dateOnly(at: string | Date | null | undefined): string {
  if (!at) return '';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "just now", "12 min ago", "3 h ago", "yesterday 14:02", "4 Oct". Full time in the title attribute. */
export function ago(at: string | Date | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} days`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return `yesterday ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} days ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function hours(h: number | null | undefined): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

export function initials(name: string | null | undefined): string {
  const p = (name ?? '?').trim().split(/\s+/);
  return ((p[0]?.[0] ?? '?') + (p[1]?.[0] ?? '')).toUpperCase();
}

/** Phone numbers as people write them: +2348031234567 → 08031234567. Other countries keep their code. */
export function phone(p: string | null | undefined): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  return /^234\d{10}$/.test(d) ? '0' + d.slice(3) : p;
}

export function maskPhone(p: string | null | undefined): string {
  if (!p) return '';
  return p.length > 8 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7, -4).replace(/./g, '•')} ${p.slice(-4)}` : p;
}

export const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

export type Tone = 'teal' | 'gold' | 'green' | 'red' | 'grey';
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  AWAITING_SELLER: { label: 'Waiting for seller', tone: 'gold' },
  AWAITING_BUYER: { label: 'Waiting for buyer to accept', tone: 'gold' },
  AWAITING_PAYMENT: { label: 'Waiting for payment', tone: 'gold' },
  FUNDED: { label: 'Paid, money held', tone: 'teal' },
  SHIPPED: { label: 'On the way', tone: 'teal' },
  RELEASING: { label: 'Paying seller', tone: 'teal' },
  PAYOUT_PENDING: { label: 'Payout pending', tone: 'gold' },
  COMPLETED: { label: 'Completed', tone: 'green' },
  DISPUTED: { label: 'Problem reported', tone: 'red' },
  REFUNDING: { label: 'Refunding', tone: 'gold' },
  REFUNDED: { label: 'Refunded', tone: 'grey' },
  CANCELLED: { label: 'Cancelled', tone: 'grey' },
  EXPIRED: { label: 'Expired', tone: 'grey' },
};

export const PAYOUT: Record<string, { label: string; tone: Tone }> = {
  CREATED: { label: 'Queued', tone: 'grey' },
  SUBMITTED: { label: 'Sending', tone: 'teal' },
  NEEDS_AUTHORIZATION: { label: 'Needs OTP', tone: 'gold' },
  SUCCESS: { label: 'Paid', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  REVERSED: { label: 'Reversed', tone: 'red' },
};

/** Plain words for audit-trail actions. */
export const ACTIONS: Record<string, string> = {
  'ambassador.approve': 'Approved an ambassador application',
  'market.keep': 'Kept a market item after a look',
  'market.keep_all': 'Kept market items after a look',
  'market.remove': 'Removed a market item',
  'market.seller_approve': 'Let a seller list in the market',
  'market.seller_decline': 'Declined a seller for the market',
  'market.seller_stop': 'Stopped a seller listing in the market',
  'market.seller_allow': 'Let a seller list in the market again',
  'market.seller_limit': 'Set a seller\'s market item limit',
  'market.upgrade_done': 'Confirmed a seller\'s paid market upgrade',
  'market.upgrade_decline': 'Declined a market upgrade',
  'market.ad_link': 'Made a market ad link',
  'ambassador.decline': 'Declined an ambassador application',
  'ambassador.invite': 'Invited an ambassador',
  'ambassador.pause': 'Paused an ambassador',
  'ambassador.resume': 'Resumed an ambassador',
  'ambassador.end': 'Ended an ambassador',
  'ambassador.share': 'Set an ambassador\'s share',
  'ambassador.name': 'Changed an ambassador\'s link name',
  'ambassador.photo.remove': 'Removed an ambassador\'s photo',
  'ambassador.payout.paid': 'Marked an ambassador payout as paid',
  'ambassador.payout.run': 'Made the ambassador payouts for a month',
  'ambassador.earning.approve': 'Approved a held ambassador earning',
  'ambassador.earning.void': 'Cancelled a held ambassador earning',
  'deal.release': 'Released money to the seller',
  'deal.refund': 'Refunded the buyer',
  'deal.cancel': 'Cancelled the order',
  'deal.extend': 'Gave the seller more time',
  'deal.message': 'Messaged on WhatsApp',
  'deal.note': 'Added a note',
  'payout.authorize': 'Approved a payout with OTP',
  'payout.retry': 'Retried a payout',
  'money.export': 'Exported orders (CSV)',
  'support.reply': 'Replied to a support message',
  'person.message': 'Messaged them as Hoolam support',
  'support.close': 'Closed a support message',
  'support.reopen': 'Reopened a support message',
  'user.pause': 'Paused an account',
  'user.unpause': 'Unpaused an account',
  'user.cap': 'Changed an order limit',
  'user.kyc.approve': 'Approved their ID',
  'whatsapp.forms.retry': 'Tried the WhatsApp forms again',
  'user.kyc.remove': 'Removed their ID verification',
  'user.kyc.clear': 'Cleared their ID review',
  'user.kyc.decline': 'Declined their flagged ID',
  'settings.update': 'Changed settings',
  'media.upload': 'Uploaded an image',
  'chat_media.upload': 'Replaced a chat picture or voice note',
  'chat_media.remove': 'Put a chat picture or voice note back to default',
  'user.photo.remove': 'Removed a seller\'s photo',
  'user.social': 'Changed a seller\'s link',
  'review.hide': 'Hid a buyer\'s words from a seller\'s page',
  'review.show': 'Showed a buyer\'s words again',
  'seller_video.approve': 'Approved a seller\'s video',
  'seller_video.reject': 'Turned down a seller\'s video',
  'seller_video.remove': 'Took down a seller\'s video',
  'media.remove': 'Removed an image',
  'site.refresh': 'Refreshed the website',
  'site.version.live': 'Changed the live home page',
  'staff.invite': 'Invited a team member',
  'staff.invite_accepted': 'Joined the team',
  'staff.role': 'Changed a role',
  'staff.deactivate': 'Deactivated a team member',
  'staff.reactivate': 'Reactivated a team member',
  'staff.reset_login': 'Reset someone\'s login',
  'inbox.handled': 'Marked an item as handled',
  'console.setup': 'Set up the console',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in (password)',
  'auth.code_failed': 'Failed sign-in (code)',
  'auth.two_step_enabled': 'Set up two-step sign-in',
};

/** Where a person came from (Buyers & sellers → Source). */
export const SOURCES: Record<string, string> = {
  ad: 'Facebook or Instagram ad', post: 'Facebook or Instagram post', campaign: 'Campaign link', website: 'Website',
  ambassador: 'Ambassador', order: 'Someone\'s order', seller_page: 'A seller\'s page', market: 'Market item', market_ad: 'Market ad link',
  direct: 'Messaged Hoolam directly', unknown: 'Not recorded',
};
/** The source in a few words: "Instagram ad “Black Friday”", "Bayo Kicks' order HL-7K2QF". */
export function sourceText(source: string | null | undefined, d: Record<string, any> | null | undefined): string {
  const x = d ?? {};
  switch (source) {
    case 'ad': return `${x.where ?? 'Facebook or Instagram'} ad${x.headline ? ` “${x.headline}”` : ''}`;
    case 'post': return `${x.where ?? 'Facebook or Instagram'} post${x.headline ? ` “${x.headline}”` : ''}`;
    case 'campaign': return `Link hoolam.com/${x.slug}`;
    case 'website': return `Website${x.page && x.page !== 'home' ? ` · ${String(x.page).replace(/-/g, ' ')}` : ' · home page'}`;
    case 'ambassador': return `Ambassador ${x.byName ?? x.slug ?? ''}`.trim() + (x.via === 'code' ? ' (typed their name)' : x.via === 'team' ? ' (added by the team)' : '');
    case 'order': return `${x.byName ? `${x.byName}'s` : 'Someone\'s'} order ${x.code ?? ''}`.trim();
    case 'seller_page': return `${x.byName ?? 'A seller'}'s page (@${x.slug})`;
    case 'market': return `Market item${x.title ? ` “${x.title}”` : ''}`;
    case 'market_ad': return `Market ad “${x.ad}”${x.title ? ` · ${x.title}` : ''}`;
    case 'direct': return 'Messaged Hoolam directly';
    default: return 'Not recorded (joined before sources were tracked)';
  }
}
