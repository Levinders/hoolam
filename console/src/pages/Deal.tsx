import { ArrowLeftRight, Ban, Check, ChevronRight, CircleDot, Coins, Image as ImageIcon, MessageSquare, Package, Scale, Send, StickyNote, ThumbsDown, ThumbsUp, TimerReset, TriangleAlert, Undo2, UserRound, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { ACTIONS, ago, dateTime, money, STATUS } from '../format';
import { useData } from '../hooks';
import { Avatar, Button, ConfirmAction, Empty, ErrorBanner, Modal, PayoutPill, Seg, Skeleton, StatusPill, useToast } from '../ui';

const ACTOR: Record<string, string> = { buyer: 'Buyer', seller: 'Seller', provider: 'Payment provider', system: 'Hoolam (automatic)', admin: 'Hoolam team' };


/** Same list as src/deals/categories.ts (the buyer's form). */
const CATEGORY_NAMES: Record<string, string> = {
  food: 'Food & drinks', clothing: 'Clothing', shoes: 'Shoes', bags: 'Bags & accessories', beauty: 'Beauty & hair',
  phones: 'Phones & gadgets', electronics: 'Electronics', appliances: 'Home appliances', home: 'Furniture & home', other: 'Something else',
};
export function Deal() {
  const { code = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useData<any>(`/deals/${code}`);
  const [tab, setTab] = useState<'activity' | 'messages' | 'money'>('activity');
  const [open, setOpen] = useState<null | 'release' | 'refund' | 'cancel' | 'extend' | 'message'>(null);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [hoursExtra, setHoursExtra] = useState(24);

  const timeline = useMemo(() => {
    if (!data) return [];
    const ev = data.events.map((e: any) => ({
      at: e.created_at, kind: e.to_status === 'DISPUTED' ? 'bad' : 'event',
      what: e.from_status ? `${STATUS[e.from_status]?.label ?? e.from_status} → ${STATUS[e.to_status]?.label ?? e.to_status}` : `Order created: ${STATUS[e.to_status]?.label ?? e.to_status}`,
      who: ACTOR[e.actor] ?? e.actor, why: e.note && !String(e.note).startsWith('NEEDS_ATTENTION') ? e.note : null,
      flag: e.note && String(e.note).startsWith('NEEDS_ATTENTION') ? String(e.note).replace(/^NEEDS_ATTENTION:\s*/, '').replace(/\b(payment|by|of) (\d+)\b/g, (_m: string, w: string, n: string) => `${w} ${money(Number(n), data.deal.currency)}`) : null,
    }));
    const staff = data.trail.filter((t: any) => t.action !== 'deal.note').map((t: any) => ({
      at: t.at, kind: t.details?.ok === false ? 'bad' : 'staff', what: (ACTIONS[t.action] ?? t.action) + (t.details?.ok === false ? ' (refused)' : ''),
      who: t.actor, why: [t.reason, t.details?.text ? `“${t.details.text}”` : null, t.details?.ok === false ? t.details.error : null].filter(Boolean).join(' · ') || null,
    }));
    const notes = data.notes.map((n: any) => ({ at: n.created_at, kind: 'note', what: 'Note', who: n.by ?? 'Team', why: n.note }));
    return [...ev, ...staff, ...notes].sort((a, b) => +new Date(b.at) - +new Date(a.at));
  }, [data]);

  if (error) return <div className="page"><ErrorBanner error={error} onRetry={reload} /></div>;
  if (loading || !data) return (
    <div className="page"><Skeleton h={14} w={140} /><Skeleton h={30} w={360} style={{ margin: '12px 0 20px' }} /><Skeleton h={90} /><div className="grid side" style={{ marginTop: 16 }}><Skeleton h={360} /><Skeleton h={360} /></div></div>
  );

  const d = data.deal;
  const cur = d.currency;
  const dispute = data.disputes.find((x: any) => x.status === 'OPEN');
  const run = (path: string, label: string) => async (reason: string, extra: Record<string, unknown> = {}) => {
    const r = await post(`/deals/${code}/${path}`, { reason, ...extra });
    toast({ kind: 'ok', title: label, body: r?.status ? `Now: ${STATUS[r.status]?.label ?? r.status}` : undefined });
    await reload();
  };

  const steps = [
    { key: 'created', label: 'Started', sub: d.started_by === 'BUYER' ? 'by the buyer' : 'by the seller', done: true },
    { key: 'matched', label: 'Both sides in', sub: d.buyer_id && d.seller_id ? 'Buyer and seller' : d.started_by === 'BUYER' ? 'Waiting for seller' : 'Waiting for buyer', done: !!(d.buyer_id && d.seller_id) },
    { key: 'paid', label: 'Money held', sub: d.funded_at ? ago(d.funded_at) : 'Not paid yet', done: !!d.funded_at },
    { key: 'shipped', label: 'On the way', sub: d.shipped_at ? ago(d.shipped_at) : 'Not shipped', done: !!d.shipped_at },
    { key: 'done', label: d.status === 'REFUNDED' ? 'Refunded' : 'Seller paid', sub: d.closed_at ? ago(d.closed_at) : '—', done: ['COMPLETED', 'REFUNDED'].includes(d.status) },
  ];
  const bad = ['DISPUTED', 'CANCELLED', 'EXPIRED'].includes(d.status);
  const nowIdx = steps.findIndex((s) => !s.done);
  const allowed = data.allowed;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/deals">Orders</Link><ChevronRight aria-hidden="true" /><span>{d.code}</span></nav>
      <div className="page-head">
        <div className="deal-hero">
          <div>
            <div className="row" style={{ gap: 10 }}>
              <span className="code">{d.code}</span><StatusPill status={d.status} />{d.is_test && <span className="tag test">Test</span>}
            </div>
            <h1 style={{ marginTop: 6 }}>{d.item}</h1>
            {d.description && <p style={{ marginTop: 4, maxWidth: '62ch' }}>{d.description}</p>}
            <p className="lede">Started {dateTime(d.created_at)} by the {d.started_by === 'BUYER' ? 'buyer' : 'seller'} · fee paid by the {d.fee_payer === 'SELLER' ? 'seller' : 'buyer'}</p>
          </div>
        </div>
        <div className="actions">
          {(allowed.messageBuyer || allowed.messageSeller) && can('deal.message') && <Button icon={MessageSquare} onClick={() => setOpen('message')}>Message</Button>}
          {allowed.extend && can('deal.extend') && <Button icon={TimerReset} onClick={() => setOpen('extend')}>Give seller more time</Button>}
          {allowed.cancel && can('deal.cancel') && <Button icon={Ban} variant="danger" onClick={() => setOpen('cancel')}>Cancel order</Button>}
          {allowed.refund && can('deal.refund') && <Button icon={Undo2} variant="danger" onClick={() => setOpen('refund')}>Refund buyer</Button>}
          {allowed.release && can('deal.release') && <Button icon={Check} variant="primary" onClick={() => setOpen('release')}>Release to seller</Button>}
        </div>
      </div>

      {dispute && (
        <section className="panel" style={{ borderColor: '#EBC6C1', marginBottom: 16 }}>
          <div className="panel-body row wrap" style={{ alignItems: 'flex-start', gap: 14 }}>
            <div className="sev high"><Scale /></div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2>Problem reported {ago(dispute.created_at)}</h2>
              <p style={{ marginTop: 4 }}>“{dispute.reason ?? 'The buyer hasn\'t described it yet.'}”</p>
              <p className="small muted" style={{ marginTop: 6 }}>{money(d.buyer_pays_minor, cur)} is frozen. Look at the photos, the proof of shipping and the messages below, then decide.</p>
            </div>
            <div className="row">
              {can('deal.refund') && <Button variant="danger" icon={Undo2} onClick={() => setOpen('refund')}>Refund buyer</Button>}
              {can('deal.release') && <Button variant="primary" icon={Check} onClick={() => setOpen('release')}>Release to seller</Button>}
            </div>
          </div>
        </section>
      )}

      <section className="panel" aria-label="Progress">
        <div className="flow">
          {steps.map((s, i) => (
            <div key={s.key} className={`flow-step${s.done ? ' done' : ''}${!s.done && i === nowIdx ? (bad ? ' bad' : ' now') : ''}`}>
              <div className="dot">{s.done ? <Check /> : !s.done && i === nowIdx && bad ? <X /> : null}</div>
              <b>{s.label}</b><span>{s.sub}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid side" style={{ marginTop: 16 }}>
        <div className="stack">
          <section className="panel">
            <div className="panel-head" style={{ paddingBottom: 0, borderBottom: 0 }}>
              <div className="tabs" style={{ marginBottom: 0, flex: 1 }}>
                <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity <span className="n">{timeline.length}</span></button>
                <button className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>WhatsApp messages <span className="n">{data.messages.length}</span></button>
                <button className={tab === 'money' ? 'on' : ''} onClick={() => setTab('money')}>Money</button>
              </div>
            </div>
            <div className="panel-body">
              {tab === 'activity' && (
                <>
                  {can('deal.note') && (
                    <form className="row" style={{ marginBottom: 18, alignItems: 'flex-start' }} onSubmit={async (e) => {
                      e.preventDefault(); if (note.trim().length < 2) return;
                      setSavingNote(true);
                      try { await post(`/deals/${code}/notes`, { note }); setNote(''); toast({ kind: 'ok', title: 'Note added' }); reload(); } catch (x) { toast({ kind: 'error', title: 'Note not saved', body: (x as Error).message }); } finally { setSavingNote(false); }
                    }}>
                      <input className="input" placeholder="Add an internal note (only the team sees it)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Internal note" />
                      <Button icon={StickyNote} busy={savingNote} disabled={note.trim().length < 2}>Add note</Button>
                    </form>
                  )}
                  <ol className="timeline">
                    {timeline.map((t, i) => (
                      <li key={i}>
                        <span className={`ic ${t.kind === 'staff' || t.kind === 'note' ? 'staff' : t.kind === 'bad' ? 'bad' : ''}`}>{t.kind === 'note' ? <StickyNote /> : t.kind === 'staff' ? <UserRound /> : t.kind === 'bad' ? <TriangleAlert /> : <CircleDot />}</span>
                        <div className="what">{t.what}</div>
                        <div className="meta" title={dateTime(t.at)}>{t.who} · {dateTime(t.at)}</div>
                        {t.why && <div className="why">{t.why}</div>}
                        {t.flag && <div className="why" style={{ background: 'var(--red-50)', color: 'var(--red)' }}>{t.flag}</div>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {tab === 'messages' && (
                data.messages.length === 0 ? <Empty icon={MessageSquare} title="No messages about this order yet" /> : (
                  <div className="stack" style={{ gap: 12 }}>
                    {data.messages.map((m: any) => {
                      const to = m.phone === data.buyer?.phone ? 'Buyer' : m.phone === (data.seller ?? data.counterSeller)?.phone ? 'Seller' : 'Invited number';
                      return (
                        <div key={m.id}>
                          <div className="small muted" style={{ marginBottom: 4 }}>To {to} · {dateTime(m.at)} {m.status !== 'SENT' && <span className="tag" style={{ marginLeft: 4 }}>{m.status === 'DRY_RUN' ? 'Test' : m.status === 'NEEDS_TEMPLATE' ? 'Not delivered (24 h rule)' : m.status}</span>}</div>
                          <div className={`bubble${m.text.startsWith('🙋 From the Hoolam team') ? ' team' : ''}`}>
                            {m.text}
                            {m.buttons.length > 0 && <div className="btns">{m.buttons.map((b: string) => <span key={b}>{b}</span>)}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
              {tab === 'money' && (
                <div className="stack">
                  <div>
                    <h3 style={{ marginBottom: 8 }}>Payments in</h3>
                    {data.payments.length === 0 ? <p className="muted">No payment requested yet.</p> : (
                      <table className="t"><thead><tr><th>Reference</th><th>Status</th><th className="r">Expected</th><th className="r">Received</th><th>When</th></tr></thead>
                        <tbody>{data.payments.map((p: any) => (
                          <tr key={p.payment_reference}><td className="mono">{p.payment_reference}</td><td><span className={`pill ${p.status === 'PAID' ? 'green' : p.status === 'PARTIAL' ? 'red' : 'grey'}`}>{p.status.charAt(0) + p.status.slice(1).toLowerCase()}</span></td>
                            <td className="r money">{money(p.amount_minor, cur)}</td><td className="r money">{p.amount_paid_minor != null ? money(p.amount_paid_minor, cur) : '—'}</td><td className="muted">{dateTime(p.created_at)}</td></tr>
                        ))}</tbody></table>
                    )}
                  </div>
                  <div>
                    <h3 style={{ marginBottom: 8 }}>Payouts</h3>
                    {data.payouts.length === 0 ? <p className="muted">Nothing paid out yet.</p> : (
                      <table className="t"><thead><tr><th>To</th><th>Status</th><th className="r">Amount</th><th>Account</th><th>Updated</th></tr></thead>
                        <tbody>{data.payouts.map((p: any) => (
                          <tr key={p.reference}><td>{p.kind === 'REFUND' ? 'Buyer (refund)' : 'Seller'}</td><td><PayoutPill status={p.status} /></td><td className="r money">{money(p.amount_minor, cur)}</td>
                            <td>{p.account_name}<div className="cell-sub">{p.bank_name} ••••{p.last4}</div></td><td className="muted">{dateTime(p.updated_at)}</td></tr>
                        ))}</tbody></table>
                    )}
                  </div>
                  <div>
                    <h3 style={{ marginBottom: 8 }}>Ledger lines</h3>
                    {data.ledger.length === 0 ? <p className="muted">No money has moved on this order.</p> : (
                      <table className="t"><thead><tr><th>Account</th><th>What</th><th className="r">Amount</th><th>When</th></tr></thead>
                        <tbody>{data.ledger.map((l: any, i: number) => (
                          <tr key={i}><td className="mono">{l.account}</td><td className="muted">{l.memo}</td><td className={`r money ${Number(l.amount_minor) < 0 ? '' : ''}`}>{money(l.amount_minor, cur, { sign: true })}</td><td className="muted">{dateTime(l.created_at)}</td></tr>
                        ))}</tbody></table>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Amounts</h2><Coins className="faint" style={{ marginLeft: 'auto', width: 18 }} /></div>
            <div className="panel-body">
              <dl className="kv">
                {d.category && <><dt>Category</dt><dd>{CATEGORY_NAMES[d.category] ?? d.category}</dd></>}
                {d.delivery_address && <><dt>Deliver to</dt><dd>{d.delivery_address}</dd></>}
                <dt>Price</dt><dd className="money">{money(d.price_minor, cur)}{d.started_by === 'BUYER' && <span className="muted small"> total, delivery included</span>}</dd>
                <dt>Hoolam fee</dt><dd className="money">{money(d.fee_minor, cur)} <span className="muted small">paid by {d.fee_payer === 'SELLER' ? 'seller' : 'buyer'}</span></dd>
                <dt>Buyer pays</dt><dd className="money" style={{ fontWeight: 600 }}>{money(d.buyer_pays_minor, cur)}</dd>
                <dt>Seller receives</dt><dd className="money" style={{ fontWeight: 600 }}>{money(d.seller_gets_minor, cur)}</dd>
                {d.counter_price_minor && <><dt>New price asked</dt><dd className="money">{money(d.counter_price_minor, cur)} <span className="pill gold plain">Waiting for buyer</span></dd></>}
                {d.accept_by && d.status === 'AWAITING_SELLER' && <><dt>Seller must accept</dt><dd>{ago(d.accept_by)} <span className="muted small">({dateTime(d.accept_by)})</span></dd></>}
                {d.arrive_by && <><dt>Expected by</dt><dd>{d.arrive_by}</dd></>}
                {data.sellerAccount && <><dt>Pays out to</dt><dd>{data.sellerAccount.account_name}<div className="cell-sub">{data.sellerAccount.bank_name} ••••{data.sellerAccount.last4}</div></dd></>}
              </dl>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>People</h2><ArrowLeftRight className="faint" style={{ marginLeft: 'auto', width: 18 }} /></div>
            <div className="panel-body stack" style={{ gap: 14 }}>
              {[{ who: 'Buyer', u: data.buyer, line: data.buyerTrust ? `${data.buyerTrust.purchases} purchases · ${data.buyerTrust.problems ? `${data.buyerTrust.problems} problem${data.buyerTrust.problems === 1 ? '' : 's'} reported` : 'no problems reported'}` : null },
                { who: 'Seller', u: data.seller ?? data.counterSeller, line: data.sellerTrust ? `${data.sellerTrust.completed} orders · ${data.sellerTrust.rated ? `${Math.round((100 * data.sellerTrust.happy) / data.sellerTrust.rated)}% happy` : 'no ratings yet'}${data.sellerTrust.refunded ? ` · ${data.sellerTrust.refunded} refunded` : ''}` : null }].map(({ who, u, line }) => (
                <div className="party" key={who}>
                  <Avatar name={u?.business_name || u?.display_name || who} gold={who === 'Seller'} />
                  <div style={{ minWidth: 0 }}>
                    <div className="small muted">{who}</div>
                    {u ? <Link to={`/people/${u.id}`} className="cell-main" style={{ color: 'var(--ink)' }}>{u.business_name || u.display_name || u.phone}</Link> : <span className="faint">{who === 'Seller' && d.invited_phone ? `Invited: ${d.invited_phone}` : 'Not yet'}</span>}
                    {u && <div className="cell-sub">{u.phone}{u.blocked && <span className="pill red plain" style={{ marginLeft: 6, height: 20 }}>Paused</span>}</div>}
                    {u && line && <div className="cell-sub">{line}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Photos</h2><span className="muted small" style={{ marginLeft: 'auto' }}>{data.photos.length}</span></div>
            <div className="panel-body">
              {data.photos.length === 0 ? <p className="muted small">No photos on this order.</p> : (
                <div className="photos">
                  {data.photos.map((p: any) => (
                    <a key={p.id} className="photo" href={p.url} target="_blank" rel="noreferrer" title={p.kind === 'SHIPPING' ? 'Proof of shipping' : 'Item photo'}>
                      <PhotoThumb url={p.url} label={p.kind === 'SHIPPING' ? 'Proof of shipping' : 'Item photo'} />
                    </a>
                  ))}
                </div>
              )}
              {d.shipping_note && <div className="why" style={{ marginTop: 10, background: 'var(--sunk)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}><Package style={{ width: 14, verticalAlign: -2 }} /> {d.shipping_note}</div>}
            </div>
          </section>

          {data.rating && (
            <section className="panel">
              <div className="panel-body row">
                <span className={`sev ${data.rating.happy ? 'low' : 'high'}`}>{data.rating.happy ? <ThumbsUp /> : <ThumbsDown />}</span>
                <div><b>{data.rating.happy ? 'Buyer was happy' : 'Buyer was not happy'}</b><div className="small muted">{data.rating.comment ? `“${data.rating.comment}”` : ago(data.rating.created_at)}</div></div>
              </div>
            </section>
          )}
        </div>
      </div>

      {open === 'release' && <ConfirmAction icon={Check} title={`Release ${money(d.seller_gets_minor, cur)} to the seller?`} confirmLabel="Release to seller"
        description={<>The seller is paid and the order completes. {dispute ? 'This closes the problem in the seller\'s favour and shows on their record.' : ''} Both sides get a WhatsApp message.</>}
        reasonPlaceholder="e.g. Buyer confirmed on a call that the item arrived" onClose={() => setOpen(null)} onConfirm={(r) => run('release', 'Released to seller')(r)} />}
      {open === 'refund' && <ConfirmAction icon={Undo2} tone="danger" title={`Refund ${money(d.buyer_pays_minor, cur)} to the buyer?`} confirmLabel="Refund buyer"
        description={<>Everything the buyer paid goes back, fee included. {dispute ? 'This counts as "refunded after review" on the seller\'s record.' : ''} The buyer needs a refund account on file.</>}
        reasonPlaceholder="e.g. Seller sent the wrong size and won't replace it" onClose={() => setOpen(null)} onConfirm={(r) => run('refund', 'Refund started')(r)} />}
      {open === 'cancel' && <ConfirmAction icon={Ban} tone="danger" title="Cancel this order?" confirmLabel="Cancel order"
        description="No money has moved. Both sides are told the Hoolam team closed it." onClose={() => setOpen(null)} onConfirm={(r) => run('cancel', 'Order cancelled')(r)} />}
      {open === 'extend' && <ConfirmAction icon={TimerReset} tone="gold" title="Give the seller more time" confirmLabel={`Add ${hoursExtra} hours`}
        description="The seller gets longer to accept before the order closes."
        extra={<Seg value={String(hoursExtra)} onChange={(v) => setHoursExtra(Number(v))} options={[{ value: '12', label: '12 hours' }, { value: '24', label: '24 hours' }, { value: '48', label: '48 hours' }, { value: '72', label: '3 days' }]} />}
        onClose={() => setOpen(null)} onConfirm={(r) => run('extend', 'More time given')(r, { hours: hoursExtra })} />}
      {open === 'message' && <MessageModal code={code} hasBuyer={allowed.messageBuyer} hasSeller={allowed.messageSeller} onClose={() => setOpen(null)} onSent={() => { toast({ kind: 'ok', title: 'Message sent on WhatsApp' }); reload(); }} />}
    </div>
  );
}

function PhotoThumb({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span><ImageIcon style={{ width: 18, display: 'block', margin: '0 auto 4px' }} />{label}<br />(test: no file)</span>;
  return <img src={url} alt={label} onError={() => setFailed(true)} loading="lazy" />;
}

function MessageModal({ code, hasBuyer, hasSeller, onClose, onSent }: { code: string; hasBuyer: boolean; hasSeller: boolean; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState<'buyer' | 'seller'>(hasBuyer ? 'buyer' : 'seller');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} label="Message on WhatsApp">
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await post(`/deals/${code}/message`, { to, text }); onSent(); onClose(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="modal-head"><div className="mi"><MessageSquare /></div><div><h2>Message on WhatsApp</h2><p>Sent from Hoolam, starting with “From the Hoolam team”.</p></div></div>
        <div className="modal-body">
          <Seg value={to} onChange={setTo} options={[...(hasBuyer ? [{ value: 'buyer' as const, label: 'To the buyer' }] : []), ...(hasSeller ? [{ value: 'seller' as const, label: 'To the seller' }] : [])]} />
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a short, friendly message" aria-label="Message" autoFocus />
          <div className="audit-note"><StickyNote />WhatsApp only delivers if they messaged Hoolam in the last 24 hours. Saved to the audit trail.</div>
          {err && <ErrorBanner error={err} />}
        </div>
        <div className="modal-foot"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Send} busy={busy} disabled={text.trim().length < 2}>Send</Button></div>
      </form>
    </Modal>
  );
}

