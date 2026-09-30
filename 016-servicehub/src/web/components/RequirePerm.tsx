import type { ReactNode } from 'react';
import type { Permission } from '../../shared/permissions';
import { useCan } from '../api/hooks';
import { Alert, PageHeader } from './ui';

/** 画面単位の権限確認(サーバー側でも必ず検査される。画面では分かりやすく案内するため) */
export function RequirePerm({ any, children, bare }: { any: Permission[]; children: ReactNode; bare?: boolean }) {
  const can = useCan();
  if (!any.some((p) => can(p))) {
    const body = (
      <>
        <PageHeader title="表示できません" />
        <Alert tone="warning">この画面を表示する権限がありません。必要な場合はオーナーに権限(ロール・担当拠点)の変更を依頼してください。</Alert>
        <a className="btn" href="/app">
          メニューへ戻る
        </a>
      </>
    );
    // 全画面ルート(受付モード)ではアプリの枠がないため余白を付ける
    return bare ? <div className="content">{body}</div> : body;
  }
  return <>{children}</>;
}
