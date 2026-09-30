import { useRegisterSW } from 'virtual:pwa-register/react';

/** 新しいバージョンがある場合に更新を促す(自動リロードで受付操作を中断しないため手動) */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      /* SW 非対応環境では何もしない */
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="banner banner-update" role="status">
      新しいバージョンがあります。
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void updateServiceWorker(true)}>
        更新する
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setNeedRefresh(false)}>
        あとで
      </button>
    </div>
  );
}
