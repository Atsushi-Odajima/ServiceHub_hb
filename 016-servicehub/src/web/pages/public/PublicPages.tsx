import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type { BookingPage } from '../../../shared/constants';
import { addDays, formatDateTimeJa, isoWeekday, localTimeOf, todayIn, weekdayLabel } from '../../../shared/time';
import { api, ApiError, newIdempotencyKey, qs } from '../../api/client';
import { useApi } from '../../api/hooks';
import { Alert, Button, Checkbox, EmptyState, ErrorMessage, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';
import { TurnstileWidget, useTurnstileSiteKey } from '../../components/Turnstile';

interface PublicLocation {
  organization: { slug: string; name: string; isSample: boolean };
  emailDelivery: boolean;
  location: {
    slug: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
    maxAdvanceDays: number;
    allowWaitlist: boolean;
    cancelDeadlineHours: number;
    page: BookingPage;
  };
  services: {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    durationMin: number;
    priceLabel: string | null;
    capacity: number;
    maxPartySize: number;
    requiresStaff: boolean;
    notice: string | null;
  }[];
  staff: { id: string; name: string; profile: string | null; serviceIds: string[] }[];
}

interface Question {
  id: string;
  type: 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'yes_no' | 'confirm';
  label: string;
  helpText: string | null;
  options: { id: string; label: string }[];
  required: boolean;
}

/** 拠点の予約ページのテーマカラーは見出し上部の帯に使う(文字色には使わないのでコントラストに影響しない) */
function PublicShell({ title, sub, children, sample, theme }: { title: string; sub?: string; children: React.ReactNode; sample?: boolean; theme?: string }) {
  const color = theme && /^#[0-9a-fA-F]{6}$/.test(theme) ? theme : undefined;
  return (
    <div className="public">
      {sample ? <div className="banner banner-sample">これはサンプルの予約ページです。実際の予約は成立しません(メールも送信されません)。</div> : null}
      <header className="public-header" style={color ? { borderTop: `6px solid ${color}` } : undefined}>
        <div className="inner">
          <div style={{ fontWeight: 800, fontSize: '1.15rem' }}>{title}</div>
          {sub ? <div className="muted small">{sub}</div> : null}
        </div>
      </header>
      <main className="public-main">{children}</main>
    </div>
  );
}

export function PublicOrgPage() {
  const { org = '' } = useParams();
  const q = useApi<{ name: string; description: string | null; contact: string | null; isSample: boolean; locations: { slug: string; name: string; address: string | null; phone: string | null }[] }>(
    ['public-org', org],
    `/api/v1/public/orgs/${encodeURIComponent(org)}`,
    { retry: false },
  );
  if (q.isLoading) return <Spinner />;
  if (q.error)
    return (
      <PublicShell title="ページが見つかりません">
        <ErrorMessage error={q.error} />
      </PublicShell>
    );
  const d = q.data!;
  return (
    <PublicShell title={d.name} sub="ご予約" sample={d.isSample}>
      {d.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{d.description}</p> : null}
      <h1 style={{ fontSize: '1.15rem' }}>店舗を選んでください</h1>
      <div className="stack">
        {d.locations.map((l) => (
          <Link key={l.slug} to={`/p/${org}/${l.slug}`} className="option-card" style={{ textDecoration: 'none' }}>
            <strong style={{ fontSize: '1.1rem' }}>{l.name}</strong>
            {l.address ? <span className="muted small">{l.address}</span> : null}
            {l.phone ? <span className="muted small">電話 {l.phone}</span> : null}
          </Link>
        ))}
      </div>
      {d.contact ? <p className="small muted" style={{ marginTop: 16 }}>お問い合わせ: {d.contact}</p> : null}
    </PublicShell>
  );
}

type Step = 'service' | 'staff' | 'datetime' | 'info' | 'confirm' | 'done';
const STEP_LABELS: Record<Exclude<Step, 'done'>, string> = { service: 'サービス', staff: '担当', datetime: '日時', info: 'お客様情報', confirm: '確認' };

interface Slot {
  startsAt: string;
  endsAt: string;
  seatsAvailable: number | null;
}

export function PublicBookingPage() {
  const { org = '', loc = '' } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const data = useApi<PublicLocation>(['public-loc', org, loc], `/api/v1/public/orgs/${encodeURIComponent(org)}/locations/${encodeURIComponent(loc)}`, { retry: false });
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState<string | null>(params.get('service'));
  const [staffId, setStaffId] = useState<string | null>(params.get('staff'));
  const [partySize, setPartySize] = useState(1);
  const [date, setDate] = useState<string | null>(params.get('date'));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [customer, setCustomer] = useState({ name: '', nameKana: '', email: '', phone: '' });
  const [request, setRequest] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [agree, setAgree] = useState(false);
  const [website, setWebsite] = useState('');
  const turnstile = useTurnstileSiteKey();
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [submitErr, setSubmitErr] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [slotNotice, setSlotNotice] = useState<string | null>(null);
  const idemRef = useRef<string | null>(null);
  const formToken = useRef<string>('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const d = data.data;
  const tz = d?.location.timezone ?? 'Asia/Tokyo';
  const service = d?.services.find((s) => s.id === serviceId) ?? null;
  const staffOptions = useMemo(() => (d && service ? d.staff.filter((s) => s.serviceIds.includes(service.id)) : []), [d, service]);
  const showStaffStep = Boolean(service?.requiresStaff && d?.location.page.allowStaffSelection && staffOptions.length > 0);
  const today = todayIn(tz);
  const [stripStart, setStripStart] = useState<string | null>(null);
  const from = stripStart ?? today;
  const to = addDays(from, 13);

  // 事前入力(待機リストの案内リンク等)
  useEffect(() => {
    if (!d || !serviceId || step !== 'service') return;
    if (d.services.some((s) => s.id === serviceId)) setStep(params.get('date') ? 'datetime' : showStaffStep ? 'staff' : 'datetime');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const base = `/api/v1/public/orgs/${encodeURIComponent(org)}/locations/${encodeURIComponent(loc)}`;
  const summary = useApi<{ days: { date: string; available: number }[] }>(
    ['public-summary', org, loc, serviceId, staffId, partySize, from],
    serviceId && step === 'datetime' ? `${base}/availability/summary${qs({ serviceId, from, to, staffId, partySize })}` : null,
  );
  const slots = useApi<{ slots: Slot[]; formToken: string }>(
    ['public-slots', org, loc, serviceId, staffId, partySize, date],
    serviceId && date && step === 'datetime' ? `${base}/availability${qs({ serviceId, date, staffId, partySize })}` : null,
  );
  useEffect(() => {
    if (slots.data?.formToken) formToken.current = slots.data.formToken;
  }, [slots.data?.formToken]);
  // 案内リンクの時刻(time=HH:MM)を一度だけ選択。すでに埋まっていれば案内を表示
  const timePrefill = useRef(params.get('time'));
  useEffect(() => {
    const wanted = timePrefill.current;
    if (!wanted || !slots.data || date !== params.get('date')) return;
    timePrefill.current = null;
    const hit = slots.data.slots.find((x) => localTimeOf(x.startsAt, tz) === wanted);
    if (hit) setSlot(hit);
    else setSlotNotice('ご案内した時間はすでに埋まったか、予約できなくなりました。別の日時をお選びください。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.data]);
  const questions = useApi<{ items: Question[] }>(['public-questions', serviceId], serviceId ? `${base}/services/${serviceId}/questions` : null);

  if (data.isLoading) return <Spinner />;
  if (data.error || !d)
    return (
      <PublicShell title="予約ページ">
        <ErrorMessage error={data.error} />
      </PublicShell>
    );

  const steps = (['service', ...(showStaffStep ? ['staff'] : []), 'datetime', 'info', 'confirm'] as Exclude<Step, 'done'>[]).filter(Boolean);
  const stepIndex = steps.indexOf(step as Exclude<Step, 'done'>);
  const go = (s: Step) => {
    setSubmitErr(null);
    setStep(s);
    window.scrollTo(0, 0);
  };

  const qErrors: Record<string, string> = {};
  for (const qn of questions.data?.items ?? []) {
    const v = answers[qn.id];
    const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (qn.type === 'confirm' && v !== true);
    if (qn.required && empty) qErrors[qn.id] = '回答してください';
  }
  const infoValid =
    customer.name.trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email.trim()) &&
    customer.phone.replace(/\D/g, '').length >= 9 &&
    Object.keys(qErrors).length === 0;

  const submit = async () => {
    if (!slot || !service) return;
    if (!idemRef.current) idemRef.current = newIdempotencyKey('web');
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const r = await api.post(`${base}/bookings`, {
        serviceId: service.id,
        staffId: staffId,
        startsAt: slot.startsAt,
        partySize,
        customer: { name: customer.name, nameKana: customer.nameKana || null, email: customer.email, phone: customer.phone },
        customerRequest: request || null,
        answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
        idempotencyKey: idemRef.current,
        formToken: formToken.current,
        ...(turnstile.siteKey ? { turnstileToken: botToken ?? undefined } : {}),
        website,
        agree: true,
      });
      setResult(r);
      go('done');
    } catch (e) {
      const err = e as ApiError;
      // 確認のトークンは1回限り。失敗したら確認をやり直す
      if (turnstile.siteKey) setBotReset((n) => n + 1);
      if (err.code === 'SLOT_UNAVAILABLE') {
        // 別の方が先に予約した等: 日時選択へ戻り最新の空きを表示(冪等キーは新しくする)
        idemRef.current = null;
        setSlot(null);
        setSlotNotice(err.message);
        // 日時選択に戻ると空き状況の取得が有効になり、最新を取り直す(無効中の refetch はしない)
        void qc.invalidateQueries({ queryKey: ['public-slots'] });
        void qc.invalidateQueries({ queryKey: ['public-summary'] });
        go('datetime');
      } else {
        setSubmitErr(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicShell title={`${d.organization.name} ${d.location.name}`} sub="Web予約" sample={d.organization.isSample} theme={d.location.page.themeColor}>
      {step !== 'done' ? (
        <ol className="steps" aria-label="予約の手順">
          {steps.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} className={i < stepIndex ? 'done' : undefined}>
              {i + 1}. {STEP_LABELS[s]}
            </li>
          ))}
        </ol>
      ) : null}
      {d.location.page.message && step === 'service' ? <Alert tone="info">{d.location.page.message}</Alert> : null}

      {step === 'service' ? (
        <section className="stack">
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.15rem' }}>
            サービスを選んでください
          </h1>
          {d.services.length === 0 ? <EmptyState title="現在Webで予約できるサービスはありません" /> : null}
          {d.services.map((s) => (
            <button
              key={s.id}
              type="button"
              className="option-card"
              aria-pressed={serviceId === s.id}
              onClick={() => {
                setServiceId(s.id);
                setSlot(null);
                setPartySize(1);
                setStaffId(null);
                const hasStaffStep = s.requiresStaff && d.location.page.allowStaffSelection && d.staff.some((x) => x.serviceIds.includes(s.id));
                go(hasStaffStep ? 'staff' : 'datetime');
              }}
            >
              <span className="row-between">
                <strong style={{ fontSize: '1.05rem' }}>{s.name}</strong>
                {s.priceLabel ? <span>{s.priceLabel}</span> : null}
              </span>
              <span className="muted small">
                所要 {s.durationMin}分{s.capacity > 1 ? ` ・ 定員${s.capacity}名` : ''}
              </span>
              {s.description ? <span className="small">{s.description}</span> : null}
            </button>
          ))}
        </section>
      ) : null}

      {step === 'staff' && service ? (
        <section className="stack">
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.15rem' }}>
            担当者を選んでください
          </h1>
          <button type="button" className="option-card" aria-pressed={staffId === null} onClick={() => { setStaffId(null); go('datetime'); }}>
            <strong>おまかせ</strong>
            <span className="muted small">空いているスタッフが担当します(候補の時間が最も多くなります)</span>
          </button>
          {staffOptions.map((s) => (
            <button key={s.id} type="button" className="option-card" aria-pressed={staffId === s.id} onClick={() => { setStaffId(s.id); setSlot(null); go('datetime'); }}>
              <strong>{s.name}</strong>
              {s.profile ? <span className="small muted">{s.profile}</span> : null}
            </button>
          ))}
          <Button onClick={() => go('service')}>‹ 戻る</Button>
        </section>
      ) : null}

      {step === 'datetime' && service ? (
        <section className="stack">
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.15rem' }}>
            日時を選んでください
          </h1>
          <p className="small muted">
            {service.name}(所要{service.durationMin}分)
            {staffId ? ` ・ 担当 ${d.staff.find((s) => s.id === staffId)?.name ?? ''}` : ''} ・ 時刻は {d.location.name} の現地時間です
          </p>
          {slotNotice ? <Alert tone="warning">{slotNotice}</Alert> : null}
          {service.maxPartySize > 1 ? (
            <label className="field" style={{ maxWidth: 200 }}>
              <span className="field-label">人数</span>
              <select className="select" value={partySize} onChange={(e) => { setPartySize(Number(e.target.value)); setSlot(null); }}>
                {Array.from({ length: service.maxPartySize }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}名
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="row-between">
            <Button size="sm" disabled={from <= today} onClick={() => setStripStart(addDays(from, -14) < today ? today : addDays(from, -14))}>
              ‹ 前の2週間
            </Button>
            <Button size="sm" disabled={addDays(from, 14) > addDays(today, d.location.maxAdvanceDays)} onClick={() => setStripStart(addDays(from, 14))}>
              次の2週間 ›
            </Button>
          </div>
          <div className="date-strip" role="group" aria-label="日付">
            {Array.from({ length: 14 }, (_, i) => addDays(from, i)).map((day) => {
              const info = summary.data?.days.find((x) => x.date === day);
              const none = info ? info.available === 0 : false;
              return (
                <button
                  key={day}
                  type="button"
                  className="date-chip"
                  aria-pressed={date === day}
                  aria-label={`${day} ${info ? (none ? '空きなし' : `空き${info.available}枠`) : ''}`}
                  onClick={() => { setDate(day); setSlot(null); setSlotNotice(null); }}
                >
                  <small>{weekdayLabel(isoWeekday(day))}</small>
                  <strong>{Number(day.slice(8))}</strong>
                  <small>{info ? (none ? '×' : '○') : '…'}</small>
                </button>
              );
            })}
          </div>
          {date ? (
            slots.isLoading ? (
              <Spinner label="空き状況を確認中" />
            ) : slots.data && slots.data.slots.length > 0 ? (
              <div className="slot-grid" role="group" aria-label="開始時刻">
                {slots.data.slots.map((s) => (
                  <button key={s.startsAt} type="button" className="slot-btn" aria-pressed={slot?.startsAt === s.startsAt} onClick={() => setSlot(s)}>
                    {localTimeOf(s.startsAt, tz)}
                    {s.seatsAvailable !== null ? <small>残り{s.seatsAvailable}席</small> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="card">
                <p style={{ margin: 0 }}>この日は空きがありません。別の日をお選びください。</p>
                {d.location.allowWaitlist ? (
                  <p className="small" style={{ margin: '8px 0 0' }}>
                    <Link to={`/p/${org}/${loc}/waitlist${qs({ service: service.id, staff: staffId, date })}`}>キャンセル待ちに登録する</Link>
                  </p>
                ) : null}
              </div>
            )
          ) : (
            <p className="muted small">日付を選ぶと空いている時間が表示されます(○=空きあり ×=空きなし)。</p>
          )}
          <div className="row-between">
            <Button onClick={() => go(showStaffStep ? 'staff' : 'service')}>‹ 戻る</Button>
            <Button variant="primary" disabled={!slot} onClick={() => go('info')}>
              次へ
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'info' && service ? (
        <form
          className="stack"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (infoValid) go('confirm');
          }}
        >
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.15rem' }}>
            お客様情報
          </h1>
          <TextField label="お名前" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} required autoComplete="name" />
          <TextField label="フリガナ" value={customer.nameKana} onChange={(e) => setCustomer({ ...customer, nameKana: e.target.value })} autoComplete="off" />
          <TextField
            label="メールアドレス"
            type="email"
            inputMode="email"
            value={customer.email}
            onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
            required
            autoComplete="email"
            hint="予約確認メールと変更・キャンセル用のリンクをお送りします"
          />
          <TextField label="電話番号" type="tel" inputMode="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} required autoComplete="tel" />
          {(questions.data?.items ?? []).length > 0 ? (
            <fieldset className="stack">
              <legend>事前のご質問</legend>
              {questions.data!.items.map((qn) => (
                <QuestionField key={qn.id} q={qn} value={answers[qn.id]} onChange={(v) => setAnswers({ ...answers, [qn.id]: v })} />
              ))}
            </fieldset>
          ) : null}
          <TextAreaField label="ご要望・連絡事項(任意)" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={1000} />
          {/* ハニーポット(画面には表示されない。自動入力ボット対策) */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
            <label>
              Webサイト
              <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
          </div>
          {!infoValid ? <p className="small muted">必須項目(お名前・メール・電話番号・必須の質問)を入力すると次へ進めます。</p> : null}
          <div className="row-between">
            <Button onClick={() => go('datetime')}>‹ 戻る</Button>
            <Button type="submit" variant="primary" disabled={!infoValid}>
              確認へ
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'confirm' && service && slot ? (
        <section className="stack">
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.15rem' }}>
            予約内容の確認
          </h1>
          <div className="card">
            <dl className="kv">
              <dt>店舗</dt>
              <dd>{d.location.name}</dd>
              <dt>サービス</dt>
              <dd>
                {service.name}
                {partySize > 1 ? `(${partySize}名)` : ''}
              </dd>
              <dt>日時</dt>
              <dd>
                <strong>
                  {formatDateTimeJa(slot.startsAt, tz)}〜{localTimeOf(slot.endsAt, tz)}
                </strong>
              </dd>
              <dt>担当</dt>
              <dd>{staffId ? d.staff.find((s) => s.id === staffId)?.name : 'おまかせ'}</dd>
              <dt>お名前</dt>
              <dd>{customer.name}</dd>
              <dt>メール</dt>
              <dd>{customer.email}</dd>
              <dt>電話</dt>
              <dd>{customer.phone}</dd>
              {service.priceLabel ? (
                <>
                  <dt>料金の目安</dt>
                  <dd>{service.priceLabel}(お支払いは店舗にて)</dd>
                </>
              ) : null}
            </dl>
          </div>
          {service.notice ? <Alert tone="warning">{service.notice}</Alert> : null}
          {d.location.page.notice ? <Alert tone="info">{d.location.page.notice}</Alert> : null}
          <p className="small">
            Webからの変更・キャンセルは開始の{d.location.cancelDeadlineHours}時間前まで可能です。それ以降は店舗へご連絡ください
            {d.location.phone ? `(${d.location.phone})` : ''}。
          </p>
          <Checkbox label="上記の内容と注意事項を確認しました" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          {turnstile.siteKey ? <TurnstileWidget siteKey={turnstile.siteKey} onToken={setBotToken} resetKey={botReset} /> : null}
          <ErrorMessage error={submitErr} />
          {submitErr?.isNetwork ? (
            <Alert tone="warning">通信が途切れたため、予約が完了したか確認できませんでした。もう一度「予約する」を押しても二重予約にはなりません。</Alert>
          ) : null}
          <div className="row-between">
            <Button onClick={() => go('info')} disabled={submitting}>
              ‹ 戻る
            </Button>
            <Button variant="primary" size="lg" busy={submitting} disabled={!agree || turnstile.loading || (Boolean(turnstile.siteKey) && !botToken)} onClick={() => void submit()}>
              予約する
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'done' && result ? (
        <section className="stack" aria-live="polite">
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '1.2rem' }}>
            ✓ ご予約が確定しました
          </h1>
          <div className="card">
            <dl className="kv">
              <dt>予約番号</dt>
              <dd className="mono" style={{ fontSize: '1.2rem', fontWeight: 800 }}>
                {result.code}
              </dd>
              <dt>日時</dt>
              <dd>
                {formatDateTimeJa(result.startsAt, result.timezone)}〜{localTimeOf(result.endsAt, result.timezone)}
              </dd>
              <dt>サービス</dt>
              <dd>{result.serviceName}</dd>
              <dt>店舗</dt>
              <dd>
                {result.locationName}
                {result.locationAddress ? <div className="small muted">{result.locationAddress}</div> : null}
              </dd>
              <dt>担当</dt>
              <dd>{result.staffName ?? 'おまかせ'}</dd>
            </dl>
          </div>
          {d.emailDelivery ? (
            <Alert tone="info">確認メールを {customer.email} にお送りしました。届かない場合は迷惑メールフォルダもご確認ください。</Alert>
          ) : (
            <Alert tone="warning">現在この予約ページからは確認メールが送信されません。予約番号と下の「予約の確認・変更・キャンセル」リンクを控えてください。</Alert>
          )}
          <div className="row">
            <a className="btn btn-primary" href={`/b/${result.manageToken}`}>
              予約の確認・変更・キャンセル
            </a>
            <a className="btn" href={`/api/v1/public/manage/${result.manageToken}/ics`}>
              カレンダーに追加(.ics)
            </a>
          </div>
          <p className="small muted">このページのURL(予約確認リンク)は他の人に教えないでください。</p>
        </section>
      ) : null}
    </PublicShell>
  );
}

function QuestionField({ q, value, onChange }: { q: Question; value: unknown; onChange: (v: unknown) => void }) {
  const label = (
    <>
      {q.label}
      {q.required ? <span className="req">必須</span> : null}
    </>
  );
  if (q.type === 'short_text' || q.type === 'long_text') {
    return q.type === 'short_text' ? (
      <TextField label={q.label} hint={q.helpText ?? undefined} required={q.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={200} />
    ) : (
      <TextAreaField label={q.label} hint={q.helpText ?? undefined} required={q.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} maxLength={2000} />
    );
  }
  if (q.type === 'confirm') {
    return <Checkbox label={label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (q.type === 'yes_no') {
    return (
      <fieldset>
        <legend>{label}</legend>
        {[true, false].map((v) => (
          <label key={String(v)} className="check" style={{ marginRight: 16 }}>
            <input type="radio" name={q.id} checked={value === v} onChange={() => onChange(v)} />
            {v ? 'はい' : 'いいえ'}
          </label>
        ))}
        {q.helpText ? <div className="small muted">{q.helpText}</div> : null}
      </fieldset>
    );
  }
  const multi = q.type === 'multi_choice';
  const arr = Array.isArray(value) ? (value as string[]) : [];
  return (
    <fieldset>
      <legend>{label}</legend>
      {q.options.map((o) => (
        <label key={o.id} className="check" style={{ display: 'flex' }}>
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={q.id}
            checked={multi ? arr.includes(o.id) : value === o.id}
            onChange={(e) => (multi ? onChange(e.target.checked ? [...arr, o.id] : arr.filter((x) => x !== o.id)) : onChange(o.id))}
          />
          {o.label}
        </label>
      ))}
      {q.helpText ? <div className="small muted">{q.helpText}</div> : null}
    </fieldset>
  );
}

interface ManageView {
  code: string;
  status: string;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  locationName: string;
  locationAddress: string | null;
  locationPhone: string | null;
  staffName: string | null;
  timezone: string;
  canCancel: boolean;
  canReschedule: boolean;
  deadlinePassed: boolean;
  cancelDeadline: string;
}

export function ManageBookingPage() {
  const { token = '' } = useParams();
  const url = `/api/v1/public/manage/${encodeURIComponent(token)}`;
  const view = useApi<ManageView>(['manage', token], url, { retry: false });
  const [mode, setMode] = useState<'view' | 'cancel' | 'reschedule'>('view');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const v = view.data;
  const slots = useApi<{ slots: { startsAt: string; endsAt: string }[]; today: string }>(
    ['manage-slots', token, date],
    mode === 'reschedule' && date ? `${url}/availability${qs({ date })}` : null,
  );
  if (view.isLoading) return <Spinner />;
  if (view.error || !v)
    return (
      <PublicShell title="ご予約の確認">
        <ErrorMessage error={view.error} />
      </PublicShell>
    );
  const tz = v.timezone;
  const statusText: Record<string, string> = {
    confirmed: '予約確定',
    arrived: 'ご来店済み',
    in_service: 'ご案内中',
    completed: 'ご利用済み',
    canceled_customer: 'キャンセル済み',
    canceled_business: '店舗によりキャンセル',
    no_show: 'ご来店なし',
  };
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setDone(message);
      setMode('view');
      await view.refetch();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const today = todayIn(tz);
  return (
    <PublicShell title="ご予約の確認" sub={v.locationName}>
      {done ? <Alert tone="success">{done}</Alert> : null}
      <div className="card" style={{ marginBottom: 16 }}>
        <dl className="kv">
          <dt>状態</dt>
          <dd>
            <strong>{statusText[v.status] ?? v.status}</strong>
          </dd>
          <dt>予約番号</dt>
          <dd className="mono">{v.code}</dd>
          <dt>日時</dt>
          <dd>
            {formatDateTimeJa(v.startsAt, tz)}〜{localTimeOf(v.endsAt, tz)}
          </dd>
          <dt>サービス</dt>
          <dd>{v.serviceName}</dd>
          <dt>担当</dt>
          <dd>{v.staffName ?? 'おまかせ'}</dd>
          <dt>店舗</dt>
          <dd>
            {v.locationName}
            {v.locationAddress ? <div className="small muted">{v.locationAddress}</div> : null}
            {v.locationPhone ? <div className="small">電話 {v.locationPhone}</div> : null}
          </dd>
        </dl>
      </div>
      <ErrorMessage error={err} />
      {v.deadlinePassed ? (
        <Alert tone="warning">Webでの変更・キャンセルの受付は終了しました。ご変更の場合はお手数ですが店舗へお電話ください{v.locationPhone ? `(${v.locationPhone})` : ''}。</Alert>
      ) : null}
      {mode === 'view' && v.status === 'confirmed' ? (
        <div className="row">
          {v.canReschedule ? (
            <Button variant="primary" onClick={() => { setMode('reschedule'); setDate(today); }}>
              日時を変更する
            </Button>
          ) : null}
          {v.canCancel ? (
            <Button variant="danger" onClick={() => setMode('cancel')}>
              キャンセルする
            </Button>
          ) : null}
          <a className="btn" href={`${url}/ics`}>
            カレンダーに追加
          </a>
        </div>
      ) : null}
      {mode === 'cancel' ? (
        <div className="card stack">
          <h2>予約をキャンセルしますか?</h2>
          <TextAreaField label="理由(任意)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <div className="row">
            <Button onClick={() => setMode('view')}>戻る</Button>
            <Button variant="danger" busy={busy} onClick={() => void act(() => api.post(`${url}/cancel`, { reason: reason || null }), 'キャンセルを承りました。')}>
              キャンセルを確定する
            </Button>
          </div>
        </div>
      ) : null}
      {mode === 'reschedule' ? (
        <div className="card stack">
          <h2>新しい日時を選んでください</h2>
          <div className="date-strip" role="group" aria-label="日付">
            {Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((day) => (
              <button key={day} type="button" className="date-chip" aria-pressed={date === day} onClick={() => { setDate(day); setSlot(null); }}>
                <small>{weekdayLabel(isoWeekday(day))}</small>
                <strong>{Number(day.slice(8))}</strong>
              </button>
            ))}
          </div>
          {slots.isLoading ? <Spinner /> : null}
          {slots.data && slots.data.slots.length === 0 ? <p>この日は空きがありません。</p> : null}
          <div className="slot-grid">
            {slots.data?.slots.map((s) => (
              <button key={s.startsAt} type="button" className="slot-btn" aria-pressed={slot === s.startsAt} onClick={() => setSlot(s.startsAt)}>
                {localTimeOf(s.startsAt, tz)}
              </button>
            ))}
          </div>
          <div className="row">
            <Button onClick={() => setMode('view')}>戻る</Button>
            <Button
              variant="primary"
              disabled={!slot}
              busy={busy}
              onClick={() => void act(() => api.post(`${url}/reschedule`, { startsAt: slot }), '日時を変更しました。確認メールをお送りします。')}
            >
              この日時に変更する
            </Button>
          </div>
        </div>
      ) : null}
    </PublicShell>
  );
}

/** キャンセル待ちの登録(自動では予約されない。空きが出たら店舗からメールで案内) */
export function PublicWaitlistPage() {
  const { org = '', loc = '' } = useParams();
  const [params] = useSearchParams();
  const base = `/api/v1/public/orgs/${encodeURIComponent(org)}/locations/${encodeURIComponent(loc)}`;
  const data = useApi<PublicLocation>(['public-loc', org, loc], base, { retry: false });
  const token = useApi<{ formToken: string; allowWaitlist: boolean }>(['public-form-token', org, loc], `${base}/form-token`, { retry: false, staleTime: 30 * 60_000 });
  const d = data.data;
  const tz = d?.location.timezone ?? 'Asia/Tokyo';
  const today = todayIn(tz);
  const initialDate = params.get('date') && params.get('date')! >= today ? params.get('date')! : today;
  const [serviceId, setServiceId] = useState(params.get('service') ?? '');
  const [staffId, setStaffId] = useState(params.get('staff') ?? '');
  const [dateFrom, setDateFrom] = useState(initialDate);
  const [dateTo, setDateTo] = useState(addDays(initialDate, 6));
  const [useTime, setUseTime] = useState(false);
  const [timeFrom, setTimeFrom] = useState('10:00');
  const [timeTo, setTimeTo] = useState('18:00');
  const [partySize, setPartySize] = useState(1);
  const [customer, setCustomer] = useState({ name: '', nameKana: '', email: '', phone: '' });
  const [note, setNote] = useState('');
  const [agree, setAgree] = useState(false);
  const [website, setWebsite] = useState('');
  const turnstile = useTurnstileSiteKey();
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ dateFrom: string; dateTo: string } | null>(null);
  if (data.isLoading) return <Spinner />;
  if (data.error || !d)
    return (
      <PublicShell title="キャンセル待ち">
        <ErrorMessage error={data.error} />
      </PublicShell>
    );
  const service = d.services.find((x) => x.id === serviceId) ?? null;
  const staffOptions = service ? d.staff.filter((x) => x.serviceIds.includes(service.id)) : [];
  const valid =
    Boolean(service) &&
    customer.name.trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email.trim()) &&
    customer.phone.replace(/\D/g, '').length >= 9 &&
    dateTo >= dateFrom &&
    (!useTime || timeTo > timeFrom) &&
    agree;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ dateFrom: string; dateTo: string }>(`${base}/waitlist`, {
        serviceId,
        staffId: staffId || null,
        dateFrom,
        dateTo,
        timeFrom: useTime ? timeFrom : null,
        timeTo: useTime ? timeTo : null,
        partySize,
        note: note || null,
        customer: { name: customer.name, nameKana: customer.nameKana || null, email: customer.email, phone: customer.phone },
        formToken: token.data?.formToken ?? '',
        ...(turnstile.siteKey ? { turnstileToken: botToken ?? undefined } : {}),
        website,
        agree: true,
      });
      setDone(r);
      window.scrollTo(0, 0);
    } catch (e) {
      setErr(e as ApiError);
      void token.refetch();
      if (turnstile.siteKey) setBotReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PublicShell title={`${d.organization.name} ${d.location.name}`} sub="キャンセル待ち" sample={d.organization.isSample} theme={d.location.page?.themeColor}>
      {!d.location.allowWaitlist ? (
        <Alert tone="info">この店舗ではWebからのキャンセル待ち登録を受け付けていません。お電話でお問い合わせください{d.location.phone ? `(${d.location.phone})` : ''}。</Alert>
      ) : done ? (
        <section className="stack" aria-live="polite">
          <h1 style={{ fontSize: '1.2rem' }}>✓ キャンセル待ちを受け付けました</h1>
          <div className="card">
            <p style={{ margin: 0 }}>
              ご希望の期間({done.dateFrom}〜{done.dateTo})に空きが出た場合、店舗からメールでご案内します。
            </p>
            <p className="small" style={{ margin: '8px 0 0' }}>
              ご案内は先着順です。<strong>自動では予約されません。</strong>メールのリンクからご予約ください(その時点で空いている場合のみ予約できます)。
            </p>
          </div>
          <Link className="btn" to={`/p/${org}/${loc}`}>
            予約ページへ戻る
          </Link>
        </section>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid && (!turnstile.siteKey || botToken)) void submit();
          }}
        >
          <h1 style={{ fontSize: '1.15rem' }}>キャンセル待ちに登録</h1>
          <p className="small">ご希望の条件で空きが出たら、店舗からメールでお知らせします。登録だけでは予約は確定しません。</p>
          <SelectField
            label="サービス"
            required
            value={serviceId}
            onChange={(e) => { setServiceId(e.target.value); setStaffId(''); }}
            placeholder="選択してください"
            options={d.services.map((x) => ({ value: x.id, label: x.name }))}
          />
          {service?.requiresStaff && d.location.page.allowStaffSelection && staffOptions.length > 0 ? (
            <SelectField label="担当者" value={staffId} onChange={(e) => setStaffId(e.target.value)} placeholder="指定しない" options={staffOptions.map((x) => ({ value: x.id, label: x.name }))} />
          ) : null}
          <div className="grid-2">
            <TextField label="希望日(から)" type="date" value={dateFrom} min={today} onChange={(e) => setDateFrom(e.target.value)} required />
            <TextField label="希望日(まで)" type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} required hint="最長31日間" />
          </div>
          <Checkbox label="希望の時間帯を指定する" checked={useTime} onChange={(e) => setUseTime(e.target.checked)} />
          {useTime ? (
            <div className="grid-2">
              <TextField label="開始時刻(から)" type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
              <TextField label="開始時刻(まで)" type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
            </div>
          ) : null}
          {service && service.maxPartySize > 1 ? (
            <TextField label="人数" type="number" min={1} max={Math.min(service.maxPartySize, service.capacity)} value={partySize} onChange={(e) => setPartySize(Number(e.target.value) || 1)} />
          ) : null}
          <TextField label="お名前" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} required autoComplete="name" />
          <TextField label="フリガナ" value={customer.nameKana} onChange={(e) => setCustomer({ ...customer, nameKana: e.target.value })} autoComplete="off" />
          <TextField
            label="メールアドレス"
            type="email"
            inputMode="email"
            value={customer.email}
            onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
            required
            autoComplete="email"
            hint="空きのご案内をお送りします"
          />
          <TextField label="電話番号" type="tel" inputMode="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} required autoComplete="tel" />
          <TextAreaField label="ご要望(任意)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
            <label>
              Webサイト
              <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
          </div>
          <Checkbox label="空きが出ても自動では予約されないこと(先着順)を確認しました" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          {turnstile.siteKey ? <TurnstileWidget siteKey={turnstile.siteKey} onToken={setBotToken} resetKey={botReset} /> : null}
          <ErrorMessage error={err} />
          <div className="row-between">
            <Link className="btn" to={`/p/${org}/${loc}`}>
              ‹ 予約ページへ
            </Link>
            <Button type="submit" variant="primary" busy={busy} disabled={!valid || !token.data || turnstile.loading || (Boolean(turnstile.siteKey) && !botToken)}>
              登録する
            </Button>
          </div>
        </form>
      )}
    </PublicShell>
  );
}
