/**
 * Keeps the landing page in step with the console. The website is a separate static site that copies the logo,
 * pictures, fees and WhatsApp number when it's built, so it loads instantly even while this server sleeps.
 * After a change, we ask Render to rebuild it (its "Deploy Hook" URL in SITE_DEPLOY_HOOK). Changes made close
 * together are batched into one rebuild. Without a hook the website still picks changes up live, a little later.
 */
export class SiteSync {
  private timer: NodeJS.Timeout | null = null;
  lastRequestedAt: Date | null = null;
  lastError: string | null = null;

  constructor(private readonly hook: string | undefined, private readonly log: (l: string) => void, private readonly delayMs = 15_000) {}

  get enabled(): boolean { return !!this.hook; }
  get pending(): boolean { return !!this.timer; }

  /** Call after anything the website shows has changed. */
  changed(): void {
    if (!this.hook) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.rebuild(); }, this.delayMs);
    this.timer.unref?.();
  }

  async rebuild(): Promise<void> {
    if (!this.hook) return;
    try {
      const r = await fetch(this.hook, { method: 'POST' });
      if (!r.ok) throw new Error(`Render answered ${r.status}`);
      this.lastRequestedAt = new Date(); this.lastError = null;
      this.log('website rebuild requested');
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log(`website rebuild failed: ${this.lastError}`);
    }
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
