# 進捗 (PROGRESS.md)

最終更新: 2026-09-30

## Phase 状態
| Phase | 状態 | メモ |
|---|---|---|
| 0 技術/PoC/設計資料 | 完了 | RLS・予約競合 PoC 合格、設計資料一式、PWAビルド確認 |
| 1 組織/拠点/認証/RBAC | 完了 | DBセッション/CSRF/Origin検査/ログインロック/招待/再設定、拠点CRUD・営業時間・例外・ブロック、メンバー権限(即時反映)、管理UIシェル。統合テスト24件合格 |
| 2 サービス/スタッフ/シフト/リソース/予約エンジン | 完了 | 予約エンジン(純関数)+ローダー+確定トランザクション(allocate.ts)、CRUD API/画面、シフトテンプレート生成・競合警告。単体28件+統合15件合格 |
| 3 公開予約/顧客/事前質問/変更・キャンセル/通知 | 未着手 | |
| 4 複数拠点/受付/実施記録/次回予約 | 未着手 | |
| 5 回数券 | 未着手 | |
| 6 期間利用プラン | 未着手 | |
| 7 待機/定員/ロール別画面 | 未着手 | |
| 8 KPI/検索/CSV/監査 | 未着手 | |
| 9 バックアップ/セキュリティ/負荷・競合 | 未着手 | |
| 10 端末E2E/アクセシビリティ/説明書/デプロイ/販売前チェック | 未着手 | |

## Phase 0 記録
- 環境: Node 22.22 / pnpm 10.33 / PostgreSQL 16.13 / Chromium(Playwright 1.56.1 付属)。Docker デーモンなし。
- 外部Web: 公式料金ページへの直接アクセスはプロキシで遮断(WebSearch のみ可)。料金は検索結果の公式ドメイン要約で確認し、販売前に人間が再確認する(OPERATING_COSTS.md)。
- PoC 結果:
  - RLS(FORCE): テナント文脈なし→0行、他組織の行は不可視、他組織IDでのINSERTはポリシー違反で拒否。
  - RLS下で LIKE / && は索引条件にならない(leakproof でない)→ 正規化列の前方一致 + 比較演算で設計。
  - 同一スタッフ同一枠へ30並行: advisory lock + 再検証で成功1件。ロックなしでも排他制約で成功1件。

## Phase 1 記録
- API: /api/v1/auth/*(login, logout, me, switch-org, change-password, invitations, password-reset), /api/v1/org, /api/v1/locations(+hours/exceptions/blocks), /api/v1/members(+invitations/status/password-reset-link)
- 画面: ログイン/組織選択/招待受諾/パスワード再設定/設定トップ/組織・運営ルール/拠点(基本・営業時間・臨時休業・受付停止・予約ページ)/メンバーと権限/アカウント
- テスト: tests/integration/auth-rbac.test.ts(#8 Staff→Owner設定API拒否、拠点スコープ、テナント分離、無効化で即時セッション失効、ロール変更、最後のOwner保護、招待、ロック/レート制限)
- 確認: PC(1366px)とiPhone 13 エミュレーションでログイン/設定画面のスクリーンショット確認

## Phase 2 記録
- エンジン: src/server/engine/availability.ts(営業時間/例外/ブロック/受付期間/シフト/休憩/他拠点占有/移動時間/リソースピーク容量/定員相乗り/同時受付上限/固定開催時刻/おまかせ割当/DST)
- 確定: modules/bookings/allocate.ts(advisory lock 数値順 → 最新データで再判定 → 占有確保)、service.ts(作成/変更/キャンセル/状態/復元、冪等キー、管理トークンは冪等キーからHMACで決定的に生成しハッシュのみ保存)
- テスト: tests/unit/engine.test.ts(28件)、tests/integration/booking-engine.test.ts(#7 #10 #11 #12 #13 #14 #15、冪等、同一枠20並行→1件、定員6に12並行→6件、シフト競合警告、テンプレート生成)
- 画面: 設定>サービス(基本/拠点・スタッフ・リソース/事前質問)、スタッフ、リソース(停止期間)、シフト(週表示・テンプレート・生成・競合承知保存)
