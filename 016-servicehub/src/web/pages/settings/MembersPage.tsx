import { useState } from 'react';
import { ROLE_LABELS, ROLES, type Role } from '../../../shared/permissions';
import { api, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useMe } from '../../api/hooks';
import { Alert, Badge, Button, Checkbox, ConfirmDialog, ErrorMessage, Modal, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import type { LocationDto } from './LocationsPages';

interface Member {
  id: string;
  role: Role;
  status: string;
  allLocations: boolean;
  locationIds: string[];
  staffId: string | null;
  staffName: string | null;
  user: { id: string; email: string; name: string; lastLoginAt: string | null };
  isSelf: boolean;
}

const ROLE_DESC: Record<Role, string> = {
  owner: '全設定・全拠点・分析・スタッフ・権限',
  manager: '担当拠点の予約/顧客/シフト/受付/KPI',
  staff: '自分の予約・担当顧客・実施記録・次回予約',
  reception: '担当拠点の予約受付・来店処理・顧客検索(経営情報/機密メモは不可)',
};

export function MembersPage() {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const list = useApi<{ items: Member[]; invitations: { id: string; email: string; role: Role; expiresAt: string }[] }>(['members'], '/api/v1/members');
  const locs = useApi<{ items: LocationDto[] }>(['locations', false], '/api/v1/locations');
  const staff = useApi<{ items: { id: string; displayName: string; status: string }[] }>(['staff-list'], '/api/v1/staff');
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<Member | null>(null);
  const [toggle, setToggle] = useState<Member | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const revokeInv = useApiMutation((id: string) => api.del(`/api/v1/members/invitations/${id}`), { invalidate: [['members']], success: '招待を取り消しました' });
  const setStatus = useApiMutation((b: { id: string; status: string }) => api.post(`/api/v1/members/${b.id}/status`, { status: b.status }), {
    invalidate: [['members']],
    success: '変更しました',
    onSuccess: () => setToggle(null),
  });
  const issueReset = useApiMutation((id: string) => api.post<{ url: string }>(`/api/v1/members/${id}/password-reset-link`), {
    onSuccess: (r) => setResetLink(r.url),
  });
  const locName = (id: string) => locs.data?.items.find((l) => l.id === id)?.name ?? '(不明)';
  return (
    <>
      <PageHeader title="メンバーと権限" actions={<Button variant="primary" onClick={() => setInvite(true)}>メンバーを招待</Button>} />
      <Alert tone="info">権限の変更は即時に反映されます。ロールを変更したメンバーと無効化したメンバーは、ログイン中の端末から自動的にログアウトされます。</Alert>
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table table-responsive">
          <thead>
            <tr>
              <th>名前</th>
              <th>ロール</th>
              <th>担当拠点</th>
              <th>スタッフ紐付け</th>
              <th>状態</th>
              <th>最終ログイン</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((m) => (
              <tr key={m.id}>
                <td data-label="名前">
                  <strong>{m.user.name}</strong>
                  {m.isSelf ? <span className="muted small">(自分)</span> : null}
                  <br />
                  <span className="muted small">{m.user.email}</span>
                </td>
                <td data-label="ロール">{ROLE_LABELS[m.role]}</td>
                <td data-label="担当拠点">{m.allLocations ? '全拠点' : m.locationIds.map(locName).join('、') || '—'}</td>
                <td data-label="スタッフ">{m.staffName ?? '—'}</td>
                <td data-label="状態">{m.status === 'active' ? <Badge tone="success" icon="●">有効</Badge> : <Badge tone="muted" icon="■">無効</Badge>}</td>
                <td data-label="最終ログイン">{m.user.lastLoginAt ? fmtDateTime(m.user.lastLoginAt, tz) : '—'}</td>
                <td data-label="操作">
                  <div className="row">
                    <Button size="sm" onClick={() => setEdit(m)}>
                      権限を編集
                    </Button>
                    {!m.isSelf ? (
                      <Button size="sm" onClick={() => setToggle(m)}>
                        {m.status === 'active' ? '無効化' : '有効化'}
                      </Button>
                    ) : null}
                    {m.status === 'active' ? (
                      <Button size="sm" onClick={() => issueReset.mutate(m.id)}>
                        再設定リンク
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && list.data.invitations.length > 0 ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>招待中</h2>
          <ul className="list">
            {list.data.invitations.map((i) => (
              <li key={i.id} className="list-item">
                <span className="grow">
                  {i.email}({ROLE_LABELS[i.role]})<span className="muted small"> 期限 {fmtDateTime(i.expiresAt, tz)}</span>
                </span>
                <Button size="sm" onClick={() => revokeInv.mutate(i.id)}>
                  取り消し
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {invite ? <InviteModal locations={locs.data?.items ?? []} staff={staff.data?.items ?? []} onClose={() => setInvite(false)} /> : null}
      {edit ? <EditMemberModal member={edit} locations={locs.data?.items ?? []} staff={staff.data?.items ?? []} onClose={() => setEdit(null)} /> : null}
      {toggle ? (
        <ConfirmDialog
          title={toggle.status === 'active' ? `${toggle.user.name} を無効化しますか?` : `${toggle.user.name} を有効化しますか?`}
          message={toggle.status === 'active' ? 'ログイン中の端末はすぐにログアウトされ、以後ログインできなくなります。' : '再びログインできるようになります。'}
          danger={toggle.status === 'active'}
          busy={setStatus.isPending}
          onConfirm={() => setStatus.mutate({ id: toggle.id, status: toggle.status === 'active' ? 'disabled' : 'active' })}
          onCancel={() => setToggle(null)}
        />
      ) : null}
      {resetLink ? (
        <Modal title="パスワード再設定リンク" onClose={() => setResetLink(null)}>
          <p>このリンクを本人に直接お渡しください(24時間有効・1回限り)。</p>
          <TextField label="リンク" readOnly value={resetLink} onFocus={(e) => e.currentTarget.select()} />
        </Modal>
      ) : null}
    </>
  );
}

function ScopeFields({
  role,
  allLocations,
  setAll,
  locationIds,
  setLocationIds,
  locations,
}: {
  role: Role;
  allLocations: boolean;
  setAll: (v: boolean) => void;
  locationIds: string[];
  setLocationIds: (v: string[]) => void;
  locations: LocationDto[];
}) {
  if (role === 'owner') return <p className="small muted">オーナーは常に全拠点を操作できます。</p>;
  return (
    <fieldset>
      <legend>担当拠点</legend>
      <Checkbox label="全拠点(今後追加する拠点を含む)" checked={allLocations} onChange={(e) => setAll(e.target.checked)} />
      {!allLocations
        ? locations.map((l) => (
            <Checkbox
              key={l.id}
              label={l.name}
              checked={locationIds.includes(l.id)}
              onChange={(e) => setLocationIds(e.target.checked ? [...locationIds, l.id] : locationIds.filter((x) => x !== l.id))}
            />
          ))
        : null}
    </fieldset>
  );
}

function InviteModal({ locations, staff, onClose }: { locations: LocationDto[]; staff: { id: string; displayName: string; status: string }[]; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [allLocations, setAll] = useState(false);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const create = useApiMutation((b: unknown) => api.post<{ inviteUrl: string }>('/api/v1/members/invitations', b), {
    invalidate: [['members']],
    success: '招待を作成しました',
    onSuccess: (r) => setUrl(r.inviteUrl),
  });
  const err = create.error as ApiError | null;
  if (url) {
    return (
      <Modal title="招待を作成しました" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>閉じる</Button>}>
        <p>{sendEmail ? '招待メールを送信キューに登録しました。' : ''}メールが届かない場合は、次のリンクを本人に直接お渡しください(7日間有効)。</p>
        <TextField label="招待リンク" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </Modal>
    );
  }
  return (
    <Modal
      title="メンバーを招待"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={!email || (role !== 'owner' && !allLocations && locationIds.length === 0)}
            onClick={() => create.mutate({ email, role, allLocations, locationIds, staffId: staffId || null, sendEmail })}
          >
            招待する
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="メールアドレス" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required error={err?.fields?.email} />
        <SelectField
          label="ロール"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={ROLES.map((r) => ({ value: r, label: `${ROLE_LABELS[r]} — ${ROLE_DESC[r]}` }))}
        />
        <ScopeFields role={role} allLocations={allLocations} setAll={setAll} locationIds={locationIds} setLocationIds={setLocationIds} locations={locations} />
        <SelectField
          label="スタッフとして予約を担当する場合の紐付け"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          placeholder="紐付けない"
          options={staff.filter((s) => s.status === 'active').map((s) => ({ value: s.id, label: s.displayName }))}
          hint="スタッフロールは紐付けたスタッフの予約・顧客のみ操作できます"
        />
        <Checkbox label="招待メールを送信する" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
      </div>
    </Modal>
  );
}

function EditMemberModal({
  member,
  locations,
  staff,
  onClose,
}: {
  member: Member;
  locations: LocationDto[];
  staff: { id: string; displayName: string; status: string }[];
  onClose: () => void;
}) {
  const [role, setRole] = useState<Role>(member.role);
  const [allLocations, setAll] = useState(member.allLocations);
  const [locationIds, setLocationIds] = useState(member.locationIds);
  const [staffId, setStaffId] = useState(member.staffId ?? '');
  const save = useApiMutation((b: unknown) => api.patch(`/api/v1/members/${member.id}`, b), {
    invalidate: [['members']],
    success: '権限を変更しました',
    onSuccess: onClose,
  });
  return (
    <Modal
      title={`${member.user.name} の権限`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ role, allLocations, locationIds, staffId: staffId || null })}>
            保存する
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage error={save.error} />
        <SelectField label="ロール" value={role} onChange={(e) => setRole(e.target.value as Role)} options={ROLES.map((r) => ({ value: r, label: `${ROLE_LABELS[r]} — ${ROLE_DESC[r]}` }))} />
        {role !== member.role && !member.isSelf ? <Alert tone="warning">ロールを変更すると、このメンバーはすべての端末からログアウトされます。</Alert> : null}
        <ScopeFields role={role} allLocations={allLocations} setAll={setAll} locationIds={locationIds} setLocationIds={setLocationIds} locations={locations} />
        <SelectField
          label="スタッフ紐付け"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          placeholder="紐付けない"
          options={staff.filter((s) => s.status === 'active' || s.id === member.staffId).map((s) => ({ value: s.id, label: s.displayName }))}
        />
      </div>
    </Modal>
  );
}
