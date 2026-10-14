import type { Db } from './db.js';

/**
 * Campaign links: short addresses like hoolam.com/ig to post on socials, flyers and so on. Each one opens the
 * website and tells Google Analytics where the visitor came from (utm_source / utm_medium / utm_campaign), so
 * nobody has to type tags by hand. The website builds a tiny page for each link (site/build.mjs, from /site.json),
 * which counts the tap here and moves the visitor on instantly.
 */
export const LINK_SOURCES = {
  instagram: { label: 'Instagram', medium: 'social' },
  tiktok: { label: 'TikTok', medium: 'social' },
  x: { label: 'X (Twitter)', medium: 'social' },
  facebook: { label: 'Facebook', medium: 'social' },
  linkedin: { label: 'LinkedIn', medium: 'social' },
  youtube: { label: 'YouTube', medium: 'social' },
  whatsapp: { label: 'WhatsApp status or groups', medium: 'social' },
  flyer: { label: 'Flyer, poster or QR code', medium: 'print' },
  email: { label: 'Email', medium: 'email' },
  other: { label: 'Somewhere else', medium: 'referral' },
} as const;
export type LinkSource = keyof typeof LINK_SOURCES;

export const LINK_PAGES = { '/': 'Home page', '/about/': 'About', '/contact/': 'Contact us' } as const;

/** Addresses the website already uses (or might): a link can't take these. */
const RESERVED = new Set(['about', 'contact', 'legal', 'v', 'assets', 'media', 's', 'l', 'go', 'api', 'console', 'admin', 'blog', 'guides', 'help',
  'faq', 'pricing', 'terms', 'privacy', 'cookies', 'sitemap', 'robots', 'llms', 'index', '404', 'pay', 'order', 'orders', 'app', 'login', 'signup']);

export class LinkError extends Error {}

export interface CampaignLink { slug: string; source: LinkSource; campaign: string | null; page: string; createdAt: Date; createdBy: string | null }

const tidy = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

/** Where a link sends people: the page, with the tags Analytics reads. */
export function linkTarget(l: Pick<CampaignLink, 'slug' | 'source' | 'campaign' | 'page'>): string {
  const q = new URLSearchParams({ utm_source: l.source === 'other' ? l.slug : l.source, utm_medium: LINK_SOURCES[l.source].medium, utm_campaign: l.campaign || l.slug });
  if (l.campaign) q.set('utm_content', l.slug);
  return `${l.page}?${q.toString()}`;
}

export class CampaignLinks {
  constructor(private readonly db: Db) {}

  async list(): Promise<(CampaignLink & { taps7: number; tapsTotal: number; createdByName: string | null })[]> {
    const r = await this.db.query(`SELECT l.*, s.name AS created_by_name,
        coalesce((SELECT sum(taps) FROM campaign_link_taps t WHERE t.slug=l.slug AND t.day > current_date - 7), 0)::int AS taps7,
        coalesce((SELECT sum(taps) FROM campaign_link_taps t WHERE t.slug=l.slug), 0)::int AS taps_total
      FROM campaign_links l LEFT JOIN staff s ON s.id=l.created_by ORDER BY l.created_at DESC`);
    return r.rows.map((x) => ({ slug: x.slug, source: x.source, campaign: x.campaign, page: x.page, createdAt: x.created_at, createdBy: x.created_by, createdByName: x.created_by_name, taps7: x.taps7, tapsTotal: x.taps_total }));
  }

  /** Checks and saves a new link. */
  async create(staffId: string | null, input: { slug?: string; source?: string; campaign?: string | null; page?: string }): Promise<CampaignLink> {
    const slug = tidy(String(input.slug ?? ''));
    if (slug.length < 2) throw new LinkError('Give the link a short name, like ig or tiktok-bio.');
    if (slug.length > 40) throw new LinkError('Keep the name under 40 letters.');
    if (RESERVED.has(slug)) throw new LinkError(`hoolam.com/${slug} is already used by the website. Pick another name.`);
    if (!(String(input.source) in LINK_SOURCES)) throw new LinkError('Pick where you\'ll post it.');
    const source = input.source as LinkSource;
    const campaign = input.campaign ? tidy(String(input.campaign)).slice(0, 60) || null : null;
    const page = String(input.page ?? '/') in LINK_PAGES ? String(input.page ?? '/') : '/';
    const taken = await this.db.query('SELECT 1 FROM campaign_links WHERE slug=$1', [slug]);
    if (taken.rowCount) throw new LinkError(`hoolam.com/${slug} already exists.`);
    const r = await this.db.query(`INSERT INTO campaign_links (slug, source, campaign, page, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING created_at`,
      [slug, source, campaign, page, staffId]);
    return { slug, source, campaign, page, createdAt: r.rows[0].created_at, createdBy: staffId };
  }

  async remove(slug: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM campaign_links WHERE slug=$1', [slug])).rowCount ?? 0) > 0;
  }

  /** Counts one tap on a link (from its page on the website). */
  async tap(slug: string): Promise<boolean> {
    const r = await this.db.query(`INSERT INTO campaign_link_taps (slug, day, taps) SELECT slug, current_date, 1 FROM campaign_links WHERE slug=$1
      ON CONFLICT (slug, day) DO UPDATE SET taps=campaign_link_taps.taps+1`, [slug]);
    return (r.rowCount ?? 0) > 0;
  }

  /** What the website builds: each link's address and where it goes. */
  async forSite(): Promise<{ slug: string; target: string }[]> {
    const r = await this.db.query('SELECT slug, source, campaign, page FROM campaign_links ORDER BY slug');
    return r.rows.map((x) => ({ slug: x.slug, target: linkTarget(x) }));
  }
}
