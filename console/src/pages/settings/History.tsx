import { History, Image as ImageIcon, ImageOff, SlidersHorizontal } from 'lucide-react';
import { dateTime } from '../../format';
import { useData } from '../../hooks';
import { Empty, ErrorBanner, SkeletonRows } from '../../ui';
import { SectionHead } from '../Settings';
import { showValue, type Def } from './Values';

/** Every settings and image change, newest first. The full trail (with sign-ins and deals) is in Audit trail. */
export function HistoryPage() {
  const s = useData<any>('/settings');
  const m = useData<any>('/media');
  const error = s.error ?? m.error;
  const rows = s.data && m.data ? [
    ...s.data.history.map((h: any) => ({ ...h, kind: 'settings' })),
    ...m.data.history.map((h: any) => ({ ...h, kind: h.action })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)) : [];
  const defs: Def[] = s.data?.defs ?? [];
  return (
    <>
      <SectionHead title="Change history" lede="Every change to settings and images, with who made it, when and why." />
      <section className="panel">
        {error ? <div className="panel-body"><ErrorBanner error={error} /></div> : !s.data || !m.data ? <SkeletonRows rows={5} /> : !rows.length
          ? <Empty icon={History} title="Nothing changed yet">Everything is on its defaults.</Empty>
          : (
            <ol className="timeline history">
              {rows.map((h, i) => (
                <li key={i}>
                  <span className={`ic ${h.kind === 'media.remove' ? 'bad' : 'staff'}`}>{h.kind === 'settings' ? <SlidersHorizontal /> : h.kind === 'media.remove' ? <ImageOff /> : <ImageIcon />}</span>
                  <div className="what">{h.kind === 'settings' ? 'Changed settings' : h.kind === 'media.upload' ? `New image: ${h.details?.where ?? h.target_id}` : `Removed image: ${h.details?.where ?? h.target_id}`}{h.details?.ok === false && <span className="pill red plain" style={{ marginLeft: 6 }}>Refused</span>}</div>
                  <div className="meta">{h.actor} · {dateTime(h.at)}</div>
                  {h.kind === 'settings' && (
                    <div className="why">
                      {Object.entries(h.details?.changes ?? {}).map(([k, c]: [string, any]) => {
                        const d = defs.find((x) => x.key === k);
                        return <div key={k}>{d?.label ?? k}: {showValue(d, c.from, s.data.currency)} → <b>{showValue(d, c.to, s.data.currency)}</b></div>;
                      })}
                      {h.reason && <div className="muted" style={{ marginTop: 4 }}>“{h.reason}”</div>}
                    </div>
                  )}
                  {h.kind === 'media.upload' && h.details?.file && <div className="why muted">{h.details.file}</div>}
                </li>
              ))}
            </ol>
          )}
      </section>
    </>
  );
}
