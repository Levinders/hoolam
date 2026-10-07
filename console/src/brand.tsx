import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

/** The logo set in Settings → Brand. Every screen reads it from here; without uploads, the built-in mark shows. */
export interface Brand { logo: string | null; mark: string | null }
const Ctx = createContext<{ brand: Brand; refreshBrand: () => Promise<void> }>({ brand: { logo: null, mark: null }, refreshBrand: async () => {} });
export const useBrand = () => useContext(Ctx);

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<Brand>({ logo: null, mark: null });
  const refreshBrand = useCallback(async () => {
    try { setBrand(await api<Brand>('/auth/brand')); } catch { /* keep the built-in logo */ }
  }, []);
  useEffect(() => { refreshBrand(); }, [refreshBrand]);
  // the browser tab icon follows the logo icon
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = brand.mark ?? '/console/favicon.svg';
    link.type = brand.mark ? '' : 'image/svg+xml';
  }, [brand.mark]);
  return <Ctx.Provider value={{ brand, refreshBrand }}>{children}</Ctx.Provider>;
}

/** The Hoolam symbol: a coin held in cupped hands. Same drawing as the website. */
export function Mark({ size = 30, className = 'brand-mark' }: { size?: number; className?: string }) {
  const { brand } = useBrand();
  if (brand.mark) return <img className={`${className} brand-img`} src={brand.mark} width={size} height={size} alt="" />;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="18" fill="#0E5C63" />
      <g transform="translate(12 12) scale(1.6667)">
        <circle cx="12" cy="8.5" r="3.7" fill="#C9992E" />
        <path d="M3.5 12.5c0 4.4 3.8 7.5 8.5 7.5s8.5-3.1 8.5-7.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      </g>
    </svg>
  );
}
