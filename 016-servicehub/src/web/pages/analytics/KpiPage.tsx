import { useState } from 'react';
import { addDays, endOfMonth, startOfMonth, todayIn } from '../../../shared/time';
import { qs } from '../../api/client';
import { useApi, useMe } from '../../api/hooks';
import { Card, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';
import { fmtMinutes, fmtNumber, fmtPercent } from '../../lib/format';

interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
}

interface BookingKpi {
  total: number;
  confirmed: number;
  arrivedOrInService: number;
  completed: number;
  canceledCustomer: number;
  canceledBusiness: number;
  noShow: number;
  persons: number;
  completionRate: Rate;
  noShowRate: Rate;
  cancelRateCustomer: Rate;
  cancelRateBusiness: Rate;
}

interface Kpi {
  period: { from: string; to: string; today: string };
  locations: { id: string; name: string }[];
  bookings: BookingKpi;
  byLocation: { locationId: string; name: string; bookings: BookingKpi; staff: { availableMin: number; occupiedMin: number; outsideShift: number; utilization: Rate } }[];
  staff: {
    availableMin: number;
    occupiedMin: number;
    outsideShift: number;
    utilization: Rate;
    rows: { staffId: string; name: string; availableMin: number; occupiedMin: number; outsideShift: number; utilization: Rate }[];
  };
  services: { serviceId: string; name: string; completed: number; persons: number }[];
  customers: { withCompleted: number; newCustomers: number; repeaters: number };
  passes: { usesNet: number; uses: number; reversals: number; expiredUses: number; expiringWithin30Days: { count: number; remaining: number } };
  plans: { activeWithCurrentPeriod: number; granted: number; used: number; remaining: number; usageRate: Rate };
  waitlist: { waiting: number; convertedInPeriod: number };
  notifications: { failedInPeriod: number };
}

/** 率の表示: 値と分子/分母。分母0は「—(データなし)」 */
function RateText({ r, unit = '件' }: { r: Rate; unit?: string }) {
  if (r.value === null) return <span title="分母が0のため計算できません">—(データなし)</span>;
  return (
    <span>
      <strong>{fmtPercent(r.value)}</strong>{' '}
      <span className="small muted">
        ({fmtNumber(r.numerator)}/{fmtNumber(r.denominator)}
        {unit})
      </span>
    </span>
  );
}

function StatCard({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="card stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ fontSize: '1.3rem' }}>
        {children}
      </span>
      {note ? <span className="stat-sub">{note}</span> : null}
    </div>
  );
}

type Preset = 'month_to_date' | 'this_month' | 'last_month' | 'last_30' | 'custom';

export function KpiPage() {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const today = todayIn(tz);
  const locations = me.data?.locations ?? [];
  // 既定は「今月(今日まで)」: 月の途中で未来の勤務時間が稼働率の分母に入らないようにする
  const [preset, setPreset] = useState<Preset>('month_to_date');
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [locId, setLocId] = useState('');
  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p === 'month_to_date') {
      setFrom(startOfMonth(today));
      setTo(today);
    } else if (p === 'this_month') {
      setFrom(startOfMonth(today));
      setTo(endOfMonth(today));
    } else if (p === 'last_month') {
      const lm = startOfMonth(addDays(startOfMonth(today), -1));
      setFrom(lm);
      setTo(endOfMonth(lm));
    } else if (p === 'last_30') {
      setFrom(addDays(today, -29));
      setTo(today);
    }
  };
  const valid = from && to && to >= from;
  const q = useApi<Kpi>(['kpi', from, to, locId], valid ? `/api/v1/kpi${qs({ from, to, locationId: locId || undefined })}` : null);
  const k = q.data;
  return (
    <div className="stack-lg">
      <PageHeader title="運営KPI" sub="期間は拠点の現地日付(両端を含む)。率は分子/分母を表示し、データがない場合は「—」と表示します(0%とは扱いません)。" />
      <Card>
        <div className="grid-auto">
          <SelectField
            label="期間"
            value={preset}
            onChange={(e) => applyPreset(e.target.value as Preset)}
            options={[
              { value: 'month_to_date', label: '今月(今日まで)' },
              { value: 'this_month', label: '今月(月末まで)' },
              { value: 'last_month', label: '先月' },
              { value: 'last_30', label: '直近30日' },
              { value: 'custom', label: '期間を指定' },
            ]}
          />
          <TextField label="開始日" type="date" value={from} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} />
          <TextField label="終了日" type="date" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} error={!valid ? '終了日は開始日以降にしてください' : undefined} />
          {locations.length > 1 ? (
            <SelectField label="拠点" value={locId} onChange={(e) => setLocId(e.target.value)} placeholder="担当のすべての拠点" options={locations.map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
        </div>
      </Card>
      <ErrorMessage error={q.error} retry={() => void q.refetch()} />
      {q.isLoading ? <Spinner label="集計中" /> : null}
      {k ? (
        <>
          <section className="stack" aria-labelledby="kpi-bookings">
            <h2 id="kpi-bookings" style={{ margin: 0, fontSize: '1.1rem' }}>
              予約({k.period.from}〜{k.period.to})
            </h2>
            <div className="grid-auto">
              <StatCard label="予約件数" note="期間内に開始する予約(全状態)">
                {fmtNumber(k.bookings.total)}件
              </StatCard>
              <StatCard label="完了率" note="完了 ÷ キャンセルを除く予約">
                <RateText r={k.bookings.completionRate} />
              </StatCard>
              <StatCard label="無断欠席率" note="無断欠席 ÷ キャンセルを除く予約">
                <RateText r={k.bookings.noShowRate} />
              </StatCard>
              <StatCard label="お客様都合キャンセル率" note="顧客キャンセル ÷ 予約件数">
                <RateText r={k.bookings.cancelRateCustomer} />
              </StatCard>
              <StatCard label="店舗都合キャンセル率" note="事業者キャンセル ÷ 予約件数">
                <RateText r={k.bookings.cancelRateBusiness} />
              </StatCard>
              <StatCard label="利用人数" note="完了した予約の人数の合計">
                {fmtNumber(k.bookings.persons)}名
              </StatCard>
            </div>
          </section>

          {k.byLocation.length > 1 ? (
            <Card title="拠点別(各予約は1拠点にのみ属するため、合計は全体と一致します)">
              <div className="table-wrap">
                <table className="table table-responsive">
                  <thead>
                    <tr>
                      <th>拠点</th>
                      <th className="num">予約</th>
                      <th className="num">完了</th>
                      <th className="num">顧客キャンセル</th>
                      <th className="num">店舗キャンセル</th>
                      <th className="num">無断欠席</th>
                      <th>完了率</th>
                      <th>稼働率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {k.byLocation.map((l) => (
                      <tr key={l.locationId}>
                        <td data-label="拠点">{l.name}</td>
                        <td data-label="予約" className="num">
                          {l.bookings.total}
                        </td>
                        <td data-label="完了" className="num">
                          {l.bookings.completed}
                        </td>
                        <td data-label="顧客キャンセル" className="num">
                          {l.bookings.canceledCustomer}
                        </td>
                        <td data-label="店舗キャンセル" className="num">
                          {l.bookings.canceledBusiness}
                        </td>
                        <td data-label="無断欠席" className="num">
                          {l.bookings.noShow}
                        </td>
                        <td data-label="完了率">
                          <RateText r={l.bookings.completionRate} />
                        </td>
                        <td data-label="稼働率">
                          <RateText r={l.staff.utilization} unit="分" />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" data-label="拠点">
                        合計
                      </th>
                      <td data-label="予約" className="num">
                        <strong>{k.bookings.total}</strong>
                      </td>
                      <td data-label="完了" className="num">
                        {k.bookings.completed}
                      </td>
                      <td data-label="顧客キャンセル" className="num">
                        {k.bookings.canceledCustomer}
                      </td>
                      <td data-label="店舗キャンセル" className="num">
                        {k.bookings.canceledBusiness}
                      </td>
                      <td data-label="無断欠席" className="num">
                        {k.bookings.noShow}
                      </td>
                      <td data-label="完了率">
                        <RateText r={k.bookings.completionRate} />
                      </td>
                      <td data-label="稼働率">
                        <RateText r={k.staff.utilization} unit="分" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card title="スタッフ稼働率">
            <p className="small muted" style={{ marginTop: 0 }}>
              稼働率 = 予約で占有された提供時間(準備・片付け時間は含めない)÷ 予約を受けられる勤務時間(勤務シフト − 休憩・休暇など)。無断欠席は枠を確保していたため含め、キャンセルは含めません。勤務の登録がない場合は「—」。
            </p>
            {k.staff.rows.length === 0 ? (
              <EmptyState title="期間内の勤務・予約がありません" />
            ) : (
              <div className="table-wrap">
                <table className="table table-responsive">
                  <thead>
                    <tr>
                      <th>スタッフ</th>
                      <th className="num">受付可能な勤務</th>
                      <th className="num">予約の提供時間</th>
                      <th>稼働率</th>
                      <th className="num">シフト外の予約</th>
                    </tr>
                  </thead>
                  <tbody>
                    {k.staff.rows.map((s) => (
                      <tr key={s.staffId}>
                        <td data-label="スタッフ">{s.name}</td>
                        <td data-label="受付可能な勤務" className="num">
                          {fmtMinutes(s.availableMin)}
                        </td>
                        <td data-label="予約の提供時間" className="num">
                          {fmtMinutes(s.occupiedMin)}
                        </td>
                        <td data-label="稼働率">
                          {s.availableMin === 0 ? <span>—(勤務時間データなし)</span> : <RateText r={s.utilization} unit="分" />}
                        </td>
                        <td data-label="シフト外の予約" className="num">
                          {s.outsideShift}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid-2">
            <Card title="顧客">
              <dl className="kv">
                <dt>期間内に来店(完了)</dt>
                <dd>{fmtNumber(k.customers.withCompleted)}名</dd>
                <dt>新規</dt>
                <dd>{fmtNumber(k.customers.newCustomers)}名(最初の完了予約が期間内)</dd>
                <dt>リピーター</dt>
                <dd>{fmtNumber(k.customers.repeaters)}名(期間より前にも完了予約あり)</dd>
              </dl>
              <p className="small muted">人数は重複なし(複数拠点を利用した方も1名)。統合後は存続顧客として数えます。</p>
            </Card>
            <Card title="サービス別の利用(完了)">
              {k.services.length === 0 ? (
                <p className="muted small">期間内の完了予約はありません。</p>
              ) : (
                <ul className="list">
                  {k.services.map((s) => (
                    <li key={s.serviceId} className="list-item">
                      <span className="grow">{s.name}</span>
                      <span className="num">
                        {s.completed}件 / {s.persons}名
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title="回数券">
              <dl className="kv">
                <dt>利用(純数)</dt>
                <dd>
                  {fmtNumber(k.passes.usesNet)}回(利用 {k.passes.uses} − 取消戻し {k.passes.reversals})
                </dd>
                <dt>期限切れで失効</dt>
                <dd>{fmtNumber(k.passes.expiredUses)}回</dd>
                <dt>30日以内に期限</dt>
                <dd>
                  {fmtNumber(k.passes.expiringWithin30Days.count)}枚(残り合計 {fmtNumber(k.passes.expiringWithin30Days.remaining)}回)
                </dd>
              </dl>
              <p className="small muted">利用・取消戻し・失効は台帳の記録日で集計します。</p>
            </Card>
            <Card title="利用プラン(今日を含む期間)">
              <dl className="kv">
                <dt>契約数</dt>
                <dd>{fmtNumber(k.plans.activeWithCurrentPeriod)}件</dd>
                <dt>付与 / 利用 / 残り</dt>
                <dd>
                  {fmtNumber(k.plans.granted)} / {fmtNumber(k.plans.used)} / {fmtNumber(k.plans.remaining)}回
                </dd>
                <dt>利用率</dt>
                <dd>
                  <RateText r={k.plans.usageRate} unit="回" />
                </dd>
              </dl>
            </Card>
          </div>

          <div className="grid-2">
            <Card title="待機リスト">
              <dl className="kv">
                <dt>待機中(現在)</dt>
                <dd>{fmtNumber(k.waitlist.waiting)}件</dd>
                <dt>期間内に予約化</dt>
                <dd>{fmtNumber(k.waitlist.convertedInPeriod)}件</dd>
              </dl>
            </Card>
            <Card title="通知">
              <dl className="kv">
                <dt>送信に失敗(期間内)</dt>
                <dd>{fmtNumber(k.notifications.failedInPeriod)}件</dd>
              </dl>
            </Card>
          </div>
          <p className="small muted">会計上の売上・利益の分析は行いません(サービスの価格表示は案内用です)。各指標の定義は項目ごとの説明のとおりです。</p>
        </>
      ) : null}
    </div>
  );
}
