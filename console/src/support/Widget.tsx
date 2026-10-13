import { Bell, BellOff, Headset, LayoutPanelLeft, Maximize2, MessageCircle, Minimize2, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect } from 'react';
import { Mark } from '../brand';
import { initials } from '../format';
import { ContentManager } from './Content';
import { useSupport, type SupportTab } from './hub';
import { LiveChat } from './LiveChat';
import { WhatsAppSupport } from './WhatsApp';
import './support.css';

/**
 * Support lives here, on every console page: a round button bottom right with the unread count,
 * ribbons that slide out for new messages, and a panel with Live chat, WhatsApp and Chat content.
 */
export function SupportWidget() {
  const s = useSupport();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && s.isOpen && s.expanded) s.setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);
  if (!s.enabled) return null;
  const tabs: { key: SupportTab; label: string; n?: number; show: boolean }[] = [
    { key: 'live', label: 'Live chat', n: s.counts.liveMessages, show: s.canLive },
    { key: 'whatsapp', label: 'WhatsApp', n: s.counts.whatsapp, show: s.canWa },
    { key: 'content', label: 'Chat content', show: s.canLive },
  ];
  return (
    <>
      {/* new messages, while the panel is closed or on another chat */}
      <div className={`sw-ribbons${s.isOpen ? ' with-panel' : ''}`} aria-live="polite">
        {s.ribbons.map((r) => (
          <div key={r.key} className="sw-ribbon" role="status">
            <button className="sw-ribbon-main" onClick={() => s.open(r.kind, r.id)}>
              <span className={`sw-av ${r.kind}`} aria-hidden="true">{initials(r.name)}</span>
              <span className="sw-ribbon-text">
                <span className="sw-ribbon-top"><b>{r.name}</b><span className={`sw-chip ${r.kind}`}>{r.kind === 'live' ? 'Live chat' : 'WhatsApp'}</span></span>
                <span className="sw-ribbon-msg">{r.text}</span>
              </span>
            </button>
            <button className="sw-x" aria-label="Dismiss" onClick={() => s.dismiss(r.key)}><X /></button>
          </div>
        ))}
      </div>

      {!s.isOpen && (
        <button className={`sw-launcher${s.counts.total ? ' has' : ''}`} onClick={() => s.open()} aria-label={`Support${s.counts.total ? `, ${s.counts.total} unread` : ''}`}>
          <Headset />
          {s.counts.total > 0 && <span className="sw-badge">{s.counts.total > 99 ? '99+' : s.counts.total}</span>}
        </button>
      )}

      {s.isOpen && (
        <section className={`sw-panel${s.expanded ? ' expanded' : ''}`} role="dialog" aria-label="Support">
          <header className="sw-head">
            <div className="sw-title">
              <Mark size={28} />
              <div><b>Support</b><span className={`sw-live${s.connected ? ' on' : ''}`}>{s.connected ? 'Live' : 'Reconnecting…'}</span></div>
            </div>
            <div className="sw-head-actions">
              <button className="sw-icon" onClick={() => s.setSound(!s.sound)} title={s.sound ? 'Sound on' : 'Sound off'} aria-label={s.sound ? 'Turn sound off' : 'Turn sound on'}>{s.sound ? <Volume2 /> : <VolumeX />}</button>
              <button className="sw-icon" onClick={() => s.setExpanded(!s.expanded)} title={s.expanded ? 'Back to the side panel' : 'Full screen'} aria-label={s.expanded ? 'Back to the side panel' : 'Full screen'}>{s.expanded ? <Minimize2 /> : <Maximize2 />}</button>
              <button className="sw-icon" onClick={s.close} aria-label="Close support"><X /></button>
            </div>
          </header>
          {s.notifyPermission === 'default' && (
            <div className="sw-notify">
              <Bell /><span>Get a pop-up when a message comes in, even on another tab.</span>
              <button className="btn sm primary" onClick={s.askNotify}>Turn on</button>
            </div>
          )}
          {s.notifyPermission === 'denied' && (
            <div className="sw-notify quiet"><BellOff /><span>Pop-ups are blocked in this browser. You still get the ribbons and the sound here.</span></div>
          )}
          <nav className="sw-tabs" role="tablist">
            {tabs.filter((t) => t.show).map((t) => (
              <button key={t.key} role="tab" aria-selected={s.tab === t.key} className={s.tab === t.key ? 'on' : ''} onClick={() => s.setTab(t.key)}>
                {t.key === 'live' ? <MessageCircle /> : t.key === 'whatsapp' ? <WaIcon /> : <LayoutPanelLeft />}
                {t.label}
                {!!t.n && <span className="sw-n">{t.n}</span>}
              </button>
            ))}
          </nav>
          <div className="sw-body">
            {s.tab === 'live' && s.canLive && <LiveChat />}
            {s.tab === 'whatsapp' && s.canWa && <WhatsAppSupport />}
            {s.tab === 'content' && s.canLive && <ContentManager />}
          </div>
        </section>
      )}
    </>
  );
}

function WaIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.4-.3z" /></svg>;
}
