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

export function maskPhone(p: string | null | undefined): string {
  if (!p) return '';
  return p.length > 8 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7, -4).replace(/./g, '•')} ${p.slice(-4)}` : p;
}

export const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

export type Tone = 'teal' | 'gold' | 'green' | 'red' | 'grey';
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  AWAITING_SELLER: { label: 'Waiting for seller', tone: 'gold' },
  AWAITING_BUYER: { label: 'Waiting for buyer', tone: 'gold' },
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
  'deal.release': 'Released money to the seller',
  'deal.refund': 'Refunded the buyer',
  'deal.cancel': 'Cancelled the deal',
  'deal.extend': 'Gave the seller more time',
  'deal.message': 'Messaged on WhatsApp',
  'deal.note': 'Added a note',
  'payout.authorize': 'Approved a payout with OTP',
  'payout.retry': 'Retried a payout',
  'money.export': 'Exported deals (CSV)',
  'support.reply': 'Replied to a support message',
  'support.close': 'Closed a support message',
  'support.reopen': 'Reopened a support message',
  'user.pause': 'Paused an account',
  'user.unpause': 'Unpaused an account',
  'user.cap': 'Changed a deal limit',
  'settings.update': 'Changed settings',
  'media.upload': 'Uploaded an image',
  'media.remove': 'Removed an image',
  'site.refresh': 'Refreshed the website',
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
