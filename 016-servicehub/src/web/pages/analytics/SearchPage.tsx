import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { qs } from '../../api/client';
import { useApi, useCan } from '../../api/hooks';
import { Card, EmptyState, ErrorMessage, PageHeader, Spinner, StatusBadge } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import type { BookingDto } from '../bookings/BookingPages';

interface SearchResult {
  customers?: { id: string; name: string; nameKana: string | null; phone: string | null; email: string | null; status: string; lastVisitAt: string | null }[];
  bookings?: BookingDto[];
  staff: { id: string; name: string }[];
  services: { id: string; name: string }[];
}

/** 横断検索: 顧客(氏名・かな・電話・メール)・予約番号・スタッフ・サービス */
export function SearchPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(text.trim());
      setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text, setParams]);
  const q = useApi<SearchResult>(['search', debounced], debounced ? `/api/v1/search${qs({ q: debounced })}` : null);
  const r = q.data;
  const empty = r && (r.customers?.length ?? 0) + (r.bookings?.length ?? 0) + r.staff.length + r.services.length === 0;
  return (
    <div className="stack-lg">
      <PageHeader title="検索" sub="顧客(氏名・フリガナ・電話番号の下4桁・メール)、予約番号、スタッフ、サービス。権限のある範囲だけを表示します。" />
      <div className="field">
        <label htmlFor="global-search" className="field-label">
          検索語
        </label>
        <input
          id="global-search"
          className="input"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例: 山田 / 1234 / ABCD2345"
          autoFocus
          autoComplete="off"
          style={{ fontSize: '1.1rem' }}
        />
      </div>
      <ErrorMessage error={q.error} />
      {q.isFetching ? <Spinner label="検索中" /> : null}
      {empty ? <EmptyState title="見つかりませんでした">別の言葉やフリガナ、電話番号の下4桁でもお試しください。</EmptyState> : null}
      {r?.bookings && r.bookings.length > 0 ? (
        <Card title="予約番号">
          <ul className="list">
            {r.bookings.map((b) => (
              <li key={b.id}>
                <Link className="list-item" to={`/app/bookings/${b.id}`}>
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {b.code}
                  </span>
                  <span className="grow">
                    {b.customerName} ・ {fmtDateTime(b.startsAt, b.timezone)} ・ {b.serviceName}
                  </span>
                  <StatusBadge status={b.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r?.customers && r.customers.length > 0 ? (
        <Card title="顧客">
          <ul className="list">
            {r.customers.map((c) => (
              <li key={c.id}>
                <Link className="list-item" to={`/app/customers/${c.id}`}>
                  <span className="grow">
                    <strong>{c.name}</strong> {c.nameKana ? <span className="small muted">{c.nameKana}</span> : null}
                    {c.status === 'archived' ? <span className="small muted">(アーカイブ)</span> : null}
                    <br />
                    <span className="small muted">
                      {c.phone ?? ''} {c.email ?? ''}
                    </span>
                  </span>
                  <span className="small muted">{c.lastVisitAt ? `最終来店 ${new Date(c.lastVisitAt).toLocaleDateString('ja-JP')}` : '来店なし'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r && (r.staff.length > 0 || r.services.length > 0) ? (
        <div className="grid-2">
          {r.staff.length > 0 ? (
            <Card title="スタッフ">
              <ul className="list">
                {r.staff.map((s) => (
                  <li key={s.id}>
                    <Link className="list-item" to={`/app/schedule`}>
                      <span className="grow">{s.name}</span>
                      <span className="small muted">予定表 ›</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {r.services.length > 0 ? (
            <Card title="サービス">
              <ul className="list">
                {r.services.map((s) => (
                  <li key={s.id}>
                    {can('service.manage') ? (
                      <Link className="list-item" to={`/app/settings/services/${s.id}`}>
                        <span className="grow">{s.name}</span>
                        <span className="small muted">設定 ›</span>
                      </Link>
                    ) : (
                      <span className="list-item">{s.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
