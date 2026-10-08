/**
 * A seller's links: Instagram, TikTok, Facebook and their own website or store.
 * Sellers type them any way they like (@name, name, a full link); we keep one clean form and refuse anything odd.
 */
export type SocialKind = 'instagram' | 'tiktok' | 'facebook' | 'website';
export const SOCIAL_KINDS: SocialKind[] = ['instagram', 'tiktok', 'facebook', 'website'];
export const SOCIAL_NAMES: Record<SocialKind, string> = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', website: 'Website or store' };

export interface SocialLink { kind: SocialKind; value: string; url: string; label: string }

const stripUrl = (s: string) => s.trim().replace(/^https?:\/\//i, '').replace(/^(www\.|m\.|web\.)/i, '');

/** Returns the stored value, or an error message in plain words. */
export function parseSocial(kind: SocialKind, input: string): { value: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'That was empty.' };
  if (raw.length > 200) return { error: 'That link is too long.' };
  if (/\s/.test(raw)) return { error: 'Send just the name or the link, with no spaces.' };
  if (/[<>"'`\\]|javascript:|data:/i.test(raw)) return { error: 'That doesn\'t look like a link.' };
  if (kind === 'instagram') {
    const s = stripUrl(raw).replace(/^instagram\.com\//i, '').replace(/^instagr\.am\//i, '').replace(/^@/, '').split(/[/?#]/)[0]!;
    if (!/^[A-Za-z0-9._]{1,30}$/.test(s) || /^\.|\.$|\.\./.test(s)) return { error: 'That isn\'t an Instagram username. Send it like @bayokicks.' };
    return { value: s.toLowerCase() };
  }
  if (kind === 'tiktok') {
    const s = stripUrl(raw).replace(/^(vm\.)?tiktok\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]!;
    if (!/^[A-Za-z0-9._]{2,24}$/.test(s) || /\.$/.test(s)) return { error: 'That isn\'t a TikTok username. Send it like @bayokicks.' };
    return { value: s.toLowerCase() };
  }
  if (kind === 'facebook') {
    const s = stripUrl(raw).replace(/^(facebook|fb)\.com\//i, '');
    const id = s.match(/^profile\.php\?id=(\d{5,20})/);
    if (id) return { value: `profile.php?id=${id[1]}` };
    const name = s.split(/[/?#]/)[0]!;
    if (!/^[A-Za-z0-9.\-]{2,80}$/.test(name)) return { error: 'That isn\'t a Facebook page. Send it like facebook.com/bayokicks' };
    return { value: name };
  }
  // website or store
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'That doesn\'t look like a website. Send it like bayokicks.com' }; }
  if (!['http:', 'https:'].includes(url.protocol) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || url.username || url.password) {
    return { error: 'That doesn\'t look like a website. Send it like bayokicks.com' };
  }
  if (/(^|\.)(wa\.me|whatsapp\.com|hoolam\.com|onrender\.com)$/i.test(url.hostname)) return { error: 'Send your own website or store, not a WhatsApp or Hoolam link.' };
  url.hash = '';
  return { value: url.toString().replace(/\/$/, '') };
}

// ---------- Hoolam's own accounts (shown in the website footer, set in Console → Settings → Contact) ----------
export type CompanySocialKind = 'instagram' | 'tiktok' | 'facebook' | 'x' | 'youtube' | 'linkedin';
export const COMPANY_SOCIAL_KINDS: CompanySocialKind[] = ['instagram', 'tiktok', 'facebook', 'x', 'youtube', 'linkedin'];
export const COMPANY_SOCIAL_NAMES: Record<CompanySocialKind, string> = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', x: 'X', youtube: 'YouTube', linkedin: 'LinkedIn' };

export function parseCompanySocial(kind: CompanySocialKind, input: string): { value: string } | { error: string } {
  const raw = input.trim();
  if (kind === 'instagram' || kind === 'tiktok' || kind === 'facebook') return parseSocial(kind, raw);
  if (!raw) return { error: 'That was empty.' };
  if (raw.length > 200 || /\s|[<>"'`\\]|javascript:|data:/i.test(raw)) return { error: 'Send just the name or the link, with no spaces.' };
  const s = stripUrl(raw);
  if (kind === 'x') {
    const h = s.replace(/^(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]!;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return { error: 'That isn\'t an X username. Send it like @hoolamng.' };
    return { value: h };
  }
  if (kind === 'youtube') {
    const p = s.replace(/^youtube\.com\//i, '').split(/[?#]/)[0]!.replace(/\/$/, '');
    const ch = p.match(/^channel\/(UC[A-Za-z0-9_-]{10,40})$/);
    if (ch) return { value: `channel/${ch[1]}` };
    const h = p.replace(/^@/, '');
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(h)) return { error: 'That isn\'t a YouTube channel. Send it like @hoolamng.' };
    return { value: `@${h}` };
  }
  const p = s.replace(/^([a-z]{2}\.)?linkedin\.com\//i, '').split(/[?#]/)[0]!.replace(/\/$/, '');
  const m = p.match(/^(company|in|showcase)\/([A-Za-z0-9-_%]{2,100})$/);
  if (m) return { value: `${m[1]}/${m[2]}` };
  if (/^[A-Za-z0-9-]{2,100}$/.test(p)) return { value: `company/${p}` };
  return { error: 'That isn\'t a LinkedIn page. Send it like linkedin.com/company/hoolam' };
}

export function companySocialLink(kind: CompanySocialKind, value: string | null | undefined): { kind: CompanySocialKind; name: string; url: string; label: string } | null {
  if (!value) return null;
  const name = COMPANY_SOCIAL_NAMES[kind];
  switch (kind) {
    case 'x': return { kind, name, url: `https://x.com/${value}`, label: `@${value}` };
    case 'youtube': return { kind, name, url: `https://www.youtube.com/${value}`, label: value.startsWith('@') ? value : 'YouTube' };
    case 'linkedin': return { kind, name, url: `https://www.linkedin.com/${value}`, label: value.split('/')[1] ?? value };
    default: { const l = socialLink(kind, value)!; return { kind, name, url: l.url, label: l.label }; }
  }
}

export function socialLink(kind: SocialKind, value: string | null | undefined): SocialLink | null {
  if (!value) return null;
  switch (kind) {
    case 'instagram': return { kind, value, url: `https://instagram.com/${value}`, label: `@${value}` };
    case 'tiktok': return { kind, value, url: `https://www.tiktok.com/@${value}`, label: `@${value}` };
    case 'facebook': return { kind, value, url: `https://facebook.com/${value}`, label: value.startsWith('profile.php') ? 'Facebook' : value };
    case 'website': {
      let host = value;
      try { host = new URL(value).hostname.replace(/^www\./, ''); } catch { /* keep the value */ }
      return { kind, value, url: value, label: host };
    }
  }
}
