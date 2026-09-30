import { useState } from 'react';
import { api } from '../../api/client';
import { useApi, useApiMutation, useCan, useOnline } from '../../api/hooks';
import { Alert, Badge, Button, Checkbox, EmptyState, ErrorMessage, fieldError, Modal, PageHeader, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';
import type { PassProduct, PlanProduct } from '../entitlements/types';
import { MultiCheck, useCatalog } from './CatalogPages';

function ServiceSummary({ all, ids }: { all: boolean; ids: string[] }) {
  const cat = useCatalog();
  if (all) return <>すべてのサービス</>;
  const names = ids.map((i) => cat.services.find((s) => s.id === i)?.name).filter(Boolean);
  return <>{names.length ? names.join('、') : <span className="muted">未設定(このままでは使えません)</span>}</>;
}

function StatusChip({ status }: { status: 'active' | 'inactive' }) {
  return status === 'active' ? (
    <Badge tone="success" icon="●">
      有効
    </Badge>
  ) : (
    <Badge tone="muted" icon="○">
      無効(新規付与不可)
    </Badge>
  );
}

// ============================= 回数券の種類 =============================

export function PassProductsPage() {
  const can = useCan();
  const online = useOnline();
  const list = useApi<{ items: PassProduct[] }>(['pass-products'], '/api/v1/pass-products');
  const [edit, setEdit] = useState<PassProduct | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="回数券の種類"
        sub="例: 8回券(180日間)。付与済みの回数券は付与時点の内容で動くため、ここを変更しても影響しません。"
        actions={
          can('pass.product.manage') ? (
            <Button variant="primary" disabled={!online} onClick={() => setEdit('new')}>
              追加
            </Button>
          ) : null
        }
      />
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="回数券の種類がありません">「追加」から作成してください。</EmptyState> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>名前</th>
                <th className="num">回数</th>
                <th>有効期間</th>
                <th>対象サービス</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id}>
                  <td data-label="名前">
                    <strong>{p.name}</strong>
                    {p.description ? <div className="small muted">{p.description}</div> : null}
                  </td>
                  <td data-label="回数" className="num">
                    {p.totalUses}回
                  </td>
                  <td data-label="有効期間">{p.validityDays ? `開始日から${p.validityDays}日` : '期限なし'}</td>
                  <td data-label="対象サービス">
                    <ServiceSummary all={p.allServices} ids={p.serviceIds} />
                  </td>
                  <td data-label="状態">
                    <StatusChip status={p.status} />
                  </td>
                  <td data-label="">
                    {can('pass.product.manage') ? (
                      <Button size="sm" disabled={!online} onClick={() => setEdit(p)}>
                        編集
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {edit ? <PassProductModal product={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function PassProductModal({ product, onClose }: { product: PassProduct | null; onClose: () => void }) {
  const cat = useCatalog();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [totalUses, setTotalUses] = useState(String(product?.totalUses ?? 8));
  const [limited, setLimited] = useState(product ? product.validityDays !== null : true);
  const [validityDays, setValidityDays] = useState(String(product?.validityDays ?? 180));
  const [allServices, setAllServices] = useState(product?.allServices ?? false);
  const [serviceIds, setServiceIds] = useState<string[]>(product?.serviceIds ?? []);
  const [status, setStatus] = useState<'active' | 'inactive'>(product?.status ?? 'active');
  const body = {
    name,
    description: description || null,
    totalUses: Number(totalUses),
    validityDays: limited ? Number(validityDays) : null,
    allServices,
    serviceIds: allServices ? [] : serviceIds,
  };
  const m = useApiMutation(() => (product ? api.patch(`/api/v1/pass-products/${product.id}`, { ...body, status }) : api.post('/api/v1/pass-products', body)), {
    invalidate: [['pass-products']],
    success: '保存しました',
    onSuccess: onClose,
  });
  const noTarget = !allServices && serviceIds.length === 0;
  return (
    <Modal
      title={product ? '回数券の種類を編集' : '回数券の種類を追加'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={m.isPending} disabled={!name.trim()} onClick={() => m.mutate(undefined)}>
            保存
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="名前" required value={name} onChange={(e) => setName(e.target.value)} error={fieldError(m.error, 'name')} placeholder="8回券" />
        <TextAreaField label="説明(任意)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid-2">
          <TextField label="回数" type="number" inputMode="numeric" min={1} required value={totalUses} onChange={(e) => setTotalUses(e.target.value)} error={fieldError(m.error, 'totalUses')} />
          <div className="stack">
            <Checkbox label="有効期限あり" checked={limited} onChange={(e) => setLimited(e.target.checked)} />
            {limited ? (
              <TextField label="有効日数(開始日を含む)" type="number" inputMode="numeric" min={1} value={validityDays} onChange={(e) => setValidityDays(e.target.value)} error={fieldError(m.error, 'validityDays')} />
            ) : null}
          </div>
        </div>
        <Checkbox label="すべてのサービスで使える" checked={allServices} onChange={(e) => setAllServices(e.target.checked)} />
        {!allServices ? (
          <MultiCheck legend="使えるサービス" items={cat.services.filter((s) => s.status === 'active').map((s) => ({ id: s.id, label: s.name }))} value={serviceIds} onChange={setServiceIds} />
        ) : null}
        {noTarget ? <Alert tone="warning">対象サービスが未設定です。このままでは付与しても使えません。</Alert> : null}
        {product ? (
          <SelectField
            label="状態"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: 'active', label: '有効' },
              { value: 'inactive', label: '無効(新規付与を止める。付与済みは使える)' },
            ]}
          />
        ) : null}
        <p className="small muted">サービス側の「回数券で利用可」がオフのサービスでは使えません。料金の決済はこのシステムでは行いません。</p>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

// ============================= 利用プランの種類 =============================

export function PlanProductsPage() {
  const can = useCan();
  const online = useOnline();
  const list = useApi<{ items: PlanProduct[] }>(['plan-products'], '/api/v1/plan-products');
  const [edit, setEdit] = useState<PlanProduct | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="利用プランの種類"
        sub="例: 月4回。期間ごとの利用回数を管理します(請求・自動課金はしません)。"
        actions={
          can('plan.product.manage') ? (
            <Button variant="primary" disabled={!online} onClick={() => setEdit('new')}>
              追加
            </Button>
          ) : null
        }
      />
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="利用プランの種類がありません">「追加」から作成してください。</EmptyState> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>名前</th>
                <th>回数</th>
                <th>期間の数え方</th>
                <th>繰越</th>
                <th>対象サービス</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id}>
                  <td data-label="名前">
                    <strong>{p.name}</strong>
                    {p.description ? <div className="small muted">{p.description}</div> : null}
                  </td>
                  <td data-label="回数">
                    {p.periodMonths === 1 ? '月' : `${p.periodMonths}か月`}
                    {p.usesPerPeriod}回
                  </td>
                  <td data-label="期間の数え方">{p.alignment === 'calendar' ? '暦月(1日〜月末)' : '開始日起点'}</td>
                  <td data-label="繰越">{p.carryoverEnabled ? `あり(上限${p.carryoverMax ?? 'なし'})` : 'なし'}</td>
                  <td data-label="対象サービス">
                    <ServiceSummary all={p.allServices} ids={p.serviceIds} />
                  </td>
                  <td data-label="状態">
                    <StatusChip status={p.status} />
                  </td>
                  <td data-label="">
                    {can('plan.product.manage') ? (
                      <Button size="sm" disabled={!online} onClick={() => setEdit(p)}>
                        編集
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {edit ? <PlanProductModal product={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function PlanProductModal({ product, onClose }: { product: PlanProduct | null; onClose: () => void }) {
  const cat = useCatalog();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [uses, setUses] = useState(String(product?.usesPerPeriod ?? 4));
  const [months, setMonths] = useState(String(product?.periodMonths ?? 1));
  const [alignment, setAlignment] = useState<'calendar' | 'anniversary'>(product?.alignment ?? 'calendar');
  const [carry, setCarry] = useState(product?.carryoverEnabled ?? false);
  const [carryMax, setCarryMax] = useState(product?.carryoverMax !== null && product?.carryoverMax !== undefined ? String(product.carryoverMax) : '');
  const [allServices, setAllServices] = useState(product?.allServices ?? false);
  const [serviceIds, setServiceIds] = useState<string[]>(product?.serviceIds ?? []);
  const [status, setStatus] = useState<'active' | 'inactive'>(product?.status ?? 'active');
  const body = {
    name,
    description: description || null,
    usesPerPeriod: Number(uses),
    periodMonths: Number(months),
    alignment,
    carryoverEnabled: carry,
    carryoverMax: carry && carryMax !== '' ? Number(carryMax) : null,
    allServices,
    serviceIds: allServices ? [] : serviceIds,
  };
  const m = useApiMutation(() => (product ? api.patch(`/api/v1/plan-products/${product.id}`, { ...body, status }) : api.post('/api/v1/plan-products', body)), {
    invalidate: [['plan-products']],
    success: '保存しました',
    onSuccess: onClose,
  });
  return (
    <Modal
      title={product ? '利用プランの種類を編集' : '利用プランの種類を追加'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={m.isPending} disabled={!name.trim()} onClick={() => m.mutate(undefined)}>
            保存
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="名前" required value={name} onChange={(e) => setName(e.target.value)} placeholder="月4回" error={fieldError(m.error, 'name')} />
        <TextAreaField label="説明(任意)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid-3">
          <TextField label="1期間の回数" type="number" inputMode="numeric" min={1} required value={uses} onChange={(e) => setUses(e.target.value)} />
          <SelectField
            label="期間の長さ"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            options={[1, 2, 3, 6, 12].map((n) => ({ value: String(n), label: n === 1 ? '1か月' : `${n}か月` }))}
          />
          <SelectField
            label="期間の数え方"
            value={alignment}
            onChange={(e) => setAlignment(e.target.value as typeof alignment)}
            options={[
              { value: 'calendar', label: '暦月(1日〜月末)' },
              { value: 'anniversary', label: '開始日起点(例: 15日〜翌14日)' },
            ]}
          />
        </div>
        <Checkbox label="残りを次の期間へ繰り越す" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
        {carry ? <TextField label="繰越の上限回数(空欄は上限なし)" type="number" inputMode="numeric" min={0} value={carryMax} onChange={(e) => setCarryMax(e.target.value)} /> : null}
        <p className="small muted">繰越なし(初期値)の場合、期間終了時の残りは失効します。</p>
        <Checkbox label="すべてのサービスで使える" checked={allServices} onChange={(e) => setAllServices(e.target.checked)} />
        {!allServices ? (
          <MultiCheck legend="使えるサービス" items={cat.services.filter((s) => s.status === 'active').map((s) => ({ id: s.id, label: s.name }))} value={serviceIds} onChange={setServiceIds} />
        ) : null}
        {product ? (
          <SelectField
            label="状態"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={[
              { value: 'active', label: '有効' },
              { value: 'inactive', label: '無効(新規契約を止める。契約済みは使える)' },
            ]}
          />
        ) : null}
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

