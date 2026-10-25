import { Check, Clapperboard, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api';
import { ago } from '../../format';
import { useData } from '../../hooks';
import { Button, ConfirmAction, useToast } from '../../ui';

interface Video { id: number; userId: string; name: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; reason: string | null; size: number; at: string; reviewedAt: string | null; reviewedBy: string | null }

/**
 * Settings → Features → Seller videos: every video a seller sends waits here until someone approves it.
 * Approve: it goes on their page (replacing their old one). Turn down or take down: they're told why on WhatsApp.
 */
export function SellerVideos() {
  const q = useData<{ items: Video[]; on: boolean; canReview: boolean }>('/seller-videos');
  const toast = useToast();
  const [ask, setAsk] = useState<{ v: Video; action: 'reject' | 'remove' } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  if (!q.data) return <p className="small muted">Loading videos…</p>;
  const items = q.data.items;
  const waiting = items.filter((v) => v.status === 'PENDING');
  const live = items.filter((v) => v.status === 'APPROVED');
  const act = async (v: Video, action: 'approve' | 'reject' | 'remove', reason?: string) => {
    setBusy(v.id);
    try {
      await post(`/seller-videos/${v.id}`, { action, reason });
      toast({ kind: 'ok', title: action === 'approve' ? 'Approved' : action === 'reject' ? 'Turned down' : 'Taken down', body: action === 'approve' ? `It's on ${v.name}'s page, and they've been told.` : `${v.name} has been told why.` });
      q.reload();
    } finally { setBusy(null); }
  };
  const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
  const card = (v: Video) => (
    <li key={v.id} className={`sv-item ${v.status.toLowerCase()}`}>
      <video className="sv-player" controls preload="metadata" src={`/console/api/seller-videos/${v.id}/file`} />
      <div className="sv-meta">
        <div className="sv-top"><Link to={`/people/${v.userId}`} className="cell-main">{v.name}</Link>
          <span className={`pill plain ${v.status === 'PENDING' ? 'gold' : v.status === 'APPROVED' ? 'green' : 'grey'}`}>{v.status === 'PENDING' ? 'Waiting' : v.status === 'APPROVED' ? 'On their page' : 'Turned down'}</span></div>
        <span className="small muted">Sent {ago(v.at)} · {mb(v.size)}{v.reviewedBy ? ` · checked by ${v.reviewedBy}` : ''}</span>
        {v.reason && <span className="small">Why: {v.reason}</span>}
        {q.data!.canReview && v.status === 'PENDING' && (
          <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <Button size="sm" icon={Check} busy={busy === v.id} onClick={() => act(v, 'approve')}>Approve</Button>
            <Button size="sm" variant="ghost" icon={X} onClick={() => setAsk({ v, action: 'reject' })}>Turn down</Button>
          </div>
        )}
        {q.data!.canReview && v.status === 'APPROVED' && <div style={{ marginTop: 6 }}><Button size="sm" variant="ghost" icon={Trash2} onClick={() => setAsk({ v, action: 'remove' })}>Take down</Button></div>}
      </div>
    </li>
  );
  return (
    <div className="feature-more-body stack" style={{ gap: 14 }}>
      <p className="small muted">Check that it's really the seller, it's about what they sell, and nothing in it is misleading or rude. Approved videos show near the top of their page; buyers tap to play.</p>
      <div>
        <h3 className="sv-h"><Clapperboard />Waiting for a check{waiting.length ? ` · ${waiting.length}` : ''}</h3>
        {waiting.length ? <ul className="sv-list">{waiting.map(card)}</ul> : <p className="small muted">Nothing waiting. New videos show up here.</p>}
      </div>
      {live.length > 0 && <div><h3 className="sv-h">On sellers' pages · {live.length}</h3><ul className="sv-list">{live.map(card)}</ul></div>}
      {ask && <ConfirmAction icon={ask.action === 'reject' ? X : Trash2} tone="danger"
        title={ask.action === 'reject' ? `Turn down ${ask.v.name}'s video?` : `Take down ${ask.v.name}'s video?`}
        description={`${ask.v.name} is told on WhatsApp, with your reason, and can send a new one.`}
        reasonPlaceholder="For example: the video doesn't show you or what you sell"
        confirmLabel={ask.action === 'reject' ? 'Turn down' : 'Take down'}
        onClose={() => setAsk(null)} onConfirm={(reason) => act(ask.v, ask.action, reason)} />}
    </div>
  );
}
