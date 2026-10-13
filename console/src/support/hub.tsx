import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

/**
 * The support widget's brain: one live connection to the server, the unread counts, which chat is open,
 * the little "ribbons" for new messages, browser pop-ups and a soft sound.
 */
export type SupportTab = 'live' | 'whatsapp' | 'content';
export interface Counts { live: number; liveMessages: number; whatsapp: number; total: number }
export interface Ribbon { key: string; kind: 'live' | 'whatsapp'; id: number; name: string; text: string; at: number }
type Listener = (event: string, data: any) => void;

interface Hub {
  canLive: boolean; canWa: boolean; enabled: boolean;
  isOpen: boolean; tab: SupportTab; liveId: number | null; waId: number | null; expanded: boolean;
  open: (tab?: SupportTab, id?: number | null) => void; close: () => void; setTab: (t: SupportTab) => void; setExpanded: (v: boolean) => void;
  setLiveId: (id: number | null) => void; setWaId: (id: number | null) => void;
  counts: Counts; refreshCounts: () => void;
  ribbons: Ribbon[]; dismiss: (key: string) => void;
  connected: boolean;
  subscribe: (fn: Listener) => () => void;
  notifyPermission: NotificationPermission | 'unsupported';
  askNotify: () => void;
  sound: boolean; setSound: (v: boolean) => void;
}
const Ctx = createContext<Hub>(null as unknown as Hub);
export const useSupport = () => useContext(Ctx);

/** Listen to live events while a component is on screen. */
export function useSupportEvents(fn: Listener) {
  const { subscribe } = useSupport();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e, d) => ref.current(e, d)), [subscribe]);
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

/** A soft two-note chime (no sound file to load). */
function chime() {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new AC();
    const play = (f: number, t: number) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    };
    play(880, 0); play(1174.7, 0.14);
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch { /* no audio */ }
}

export function SupportProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const canLive = !!me?.access?.live, canWa = !!me?.access?.whatsapp;
  const enabled = canLive || canWa;
  const [isOpen, setOpen] = useState(false);
  const [tab, setTabState] = useState<SupportTab>(canLive ? 'live' : 'whatsapp');
  const [liveId, setLiveId] = useState<number | null>(null);
  const [waId, setWaId] = useState<number | null>(null);
  const [expanded, setExpandedState] = useState(store.get('hoolam:support:expanded') === '1');
  const [counts, setCounts] = useState<Counts>({ live: 0, liveMessages: 0, whatsapp: 0, total: 0 });
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [connected, setConnected] = useState(false);
  const [sound, setSoundState] = useState(store.get('hoolam:support:sound') !== '0');
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const listeners = useRef(new Set<Listener>());
  const state = useRef({ isOpen, tab, liveId, waId });
  state.current = { isOpen, tab, liveId, waId };
  const soundRef = useRef(sound); soundRef.current = sound;

  const refreshCounts = useCallback(() => {
    if (!enabled) return;
    api<Counts>('/support/counts').then(setCounts).catch(() => {});
  }, [enabled]);

  // the count in the browser tab: "(3) Hoolam Console"
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = counts.total > 0 ? `(${counts.total}) ${base}` : base;
  }, [counts.total]);

  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);

  const ribbon = useCallback((r: Omit<Ribbon, 'key' | 'at'>) => {
    const key = `${r.kind}:${r.id}`;
    setRibbons((x) => [{ ...r, key, at: Date.now() }, ...x.filter((y) => y.key !== key)].slice(0, 3));
    setTimeout(() => setRibbons((x) => x.filter((y) => y.key !== key || Date.now() - y.at < 8500)), 9000);
    if (soundRef.current) chime();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && (document.hidden || !state.current.isOpen)) {
      try {
        const n = new Notification(`${r.name} · ${r.kind === 'live' ? 'Live chat' : 'WhatsApp'}`, { body: r.text.slice(0, 140), tag: key, icon: '/console/favicon.svg' });
        n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('hoolam:support', { detail: { tab: r.kind, id: r.id } })); n.close(); };
      } catch { /* some browsers only allow this from a service worker */ }
    }
  }, []);

  // one live connection; the browser reconnects by itself
  useEffect(() => {
    if (!enabled) return;
    refreshCounts();
    let es: EventSource | null = null;
    let countTimer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => { if (countTimer) clearTimeout(countTimer); countTimer = setTimeout(refreshCounts, 400); };
    const emit = (event: string, data: any) => listeners.current.forEach((fn) => { try { fn(event, data); } catch { /* one bad listener can't stop the rest */ } });
    const connect = () => {
      es = new EventSource('/console/api/support/events');
      es.addEventListener('ready', () => setConnected(true));
      es.onerror = () => setConnected(false);
      es.addEventListener('chat', (ev) => {
        const e = JSON.parse((ev as MessageEvent).data);
        emit('chat', e);
        if (e.type === 'message' || e.type === 'thread' || e.type === 'seen') soon();
        if (e.type === 'message' && e.message.kind === 'VISITOR') {
          const s = state.current;
          const looking = s.isOpen && s.tab === 'live' && s.liveId === e.threadId && !document.hidden;
          if (!looking) {
            api(`/livechat/${e.threadId}`).then((t: any) => {
              if (t.assignedTo && t.assignedTo !== me?.id) return; // someone else's chat
              ribbon({ kind: 'live', id: e.threadId, name: t.visitor.name, text: e.message.body || 'Sent a file' });
            }).catch(() => {});
          }
        }
      });
      es.addEventListener('whatsapp', (ev) => {
        const e = JSON.parse((ev as MessageEvent).data);
        emit('whatsapp', e);
        soon();
        const s = state.current;
        if (!(s.isOpen && s.tab === 'whatsapp' && !document.hidden)) ribbon({ kind: 'whatsapp', id: e.requestId, name: e.name || e.phone, text: e.text });
      });
    };
    connect();
    const poll = setInterval(() => { if (!document.hidden) refreshCounts(); }, 60_000);
    return () => { es?.close(); clearInterval(poll); if (countTimer) clearTimeout(countTimer); };
  }, [enabled, refreshCounts, ribbon, me?.id]);

  const open = useCallback((t?: SupportTab, id?: number | null) => {
    const want = t ?? state.current.tab;
    const ok: SupportTab = want === 'live' && !canLive ? 'whatsapp' : want === 'whatsapp' && !canWa ? 'live' : want;
    setTabState(ok);
    if (id !== undefined) { if (ok === 'live') setLiveId(id); if (ok === 'whatsapp') setWaId(id); }
    setOpen(true);
    if (id != null) setRibbons((x) => x.filter((r) => r.key !== `${ok}:${id}`));
  }, [canLive, canWa]);

  // anything can open the widget: a ribbon, a pop-up, a link to /support
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail ?? {}; open(d.tab, d.id ?? undefined); };
    window.addEventListener('hoolam:support', on);
    return () => window.removeEventListener('hoolam:support', on);
  }, [open]);

  const value = useMemo<Hub>(() => ({
    canLive, canWa, enabled, isOpen, tab, liveId, waId, expanded,
    open, close: () => setOpen(false), setTab: setTabState,
    setExpanded: (v) => { setExpandedState(v); store.set('hoolam:support:expanded', v ? '1' : '0'); },
    setLiveId, setWaId, counts, refreshCounts,
    ribbons, dismiss: (key) => setRibbons((x) => x.filter((r) => r.key !== key)),
    connected, subscribe, notifyPermission: perm,
    askNotify: () => { if (typeof Notification !== 'undefined') Notification.requestPermission().then(setPerm).catch(() => {}); },
    sound, setSound: (v) => { setSoundState(v); store.set('hoolam:support:sound', v ? '1' : '0'); },
  }), [canLive, canWa, enabled, isOpen, tab, liveId, waId, expanded, open, counts, refreshCounts, ribbons, connected, subscribe, perm, sound]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Opens the widget from anywhere (links, the command palette). */
export function openSupport(tab?: SupportTab, id?: number | null) {
  window.dispatchEvent(new CustomEvent('hoolam:support', { detail: { tab, id } }));
}
