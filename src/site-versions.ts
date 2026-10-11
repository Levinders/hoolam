import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Home page versions. Each version is a frozen copy of the home page (site/versions/<version>.html) with its own
 * website images; the brand (logo, logo icon) is shared. Which version is live is a console setting; the website
 * rebuilds to show it, and every version can be previewed at /v/<version>/ (never indexed by search engines).
 * New versions are added to site/versions/versions.json only after the owner confirms a round of changes.
 */
export interface HomeVersion { version: string; date: string; notes: string; from: string | null }

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'versions', 'versions.json');
export const FIRST_VERSION = '1.0.0';
export const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

let cached: HomeVersion[] | null = null;
export function homeVersions(): HomeVersion[] {
  if (cached) return cached;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8')) as { versions: HomeVersion[] };
    cached = j.versions.filter((v) => VERSION_RE.test(v.version));
  } catch {
    cached = [{ version: FIRST_VERSION, date: '2026-10-11', notes: 'The first home page.', from: null }];
  }
  return cached;
}
export const isHomeVersion = (v: unknown): v is string => typeof v === 'string' && homeVersions().some((x) => x.version === v);
/** Newest first by number (1.10.0 after 1.9.0). */
export const byNumber = (a: string, b: string) => { const p = (s: string) => s.split('.').map(Number); const x = p(a), y = p(b); return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!; };
