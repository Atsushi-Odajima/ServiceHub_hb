import { Alert, Button } from './ui';

function localTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 端末内の下書きの状態表示(lib/drafts.ts)。
 * - 前回の未送信の下書きを表示しているとき: その旨と「下書きを破棄」
 * - オフラインのとき: 入力は下書きとして端末に保存され、送信はできないこと
 */
export function DraftNotice({ restoredAt, online, submitLabel, onDiscard }: { restoredAt: string | null; online: boolean; submitLabel: string; onDiscard: () => void }) {
  return (
    <>
      {restoredAt ? (
        <Alert tone="info">
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span>
              この端末に保存されていた<strong>未送信の下書き</strong>({localTime(restoredAt)} 保存)を表示しています。「{submitLabel}」を押すまでサーバーには保存されていません。
            </span>
            <Button size="sm" onClick={onDiscard}>
              下書きを破棄
            </Button>
          </div>
        </Alert>
      ) : null}
      {!online ? (
        <Alert tone="warning">
          オフラインです。入力した内容はこの端末に<strong>下書きとして保存</strong>しています(未送信)。通信が戻ったら最新の状態を読み直してから「{submitLabel}」を押してください。
        </Alert>
      ) : null}
    </>
  );
}

/** 入力欄の近くに出す小さな表示(「下書き保存済み・未送信」) */
export function DraftStatus({ savedAt }: { savedAt: string | null }) {
  return (
    <span className="small muted" role="status" aria-live="polite">
      {savedAt ? `下書きを端末に保存しました(未送信・${localTime(savedAt)})` : ''}
    </span>
  );
}
