# 進捗 (PROGRESS.md)

最終更新: 2026-09-30(Phase 6 まで)

## Phase 状態
| Phase | 状態 | メモ |
|---|---|---|
| 0 技術/PoC/設計資料 | 完了 | RLS・予約競合 PoC 合格、設計資料一式、PWAビルド確認 |
| 1 組織/拠点/認証/RBAC | 完了 | DBセッション/CSRF/Origin検査/ログインロック/招待/再設定、拠点CRUD・営業時間・例外・ブロック、メンバー権限(即時反映)、管理UIシェル。統合テスト24件合格 |
| 2 サービス/スタッフ/シフト/リソース/予約エンジン | 完了 | 予約エンジン(純関数)+ローダー+確定トランザクション(allocate.ts)、CRUD API/画面、シフトテンプレート生成・競合警告。単体28件+統合15件合格 |
| 3 公開予約/顧客/事前質問/変更・キャンセル/通知 | 完了 | 公開予約(ウィザード/管理リンク/ICS/bot対策)、顧客台帳・タイムライン・重複候補・確認付き統合・匿名化・エクスポート、通知送信箱+ワーカー+スケジューラ。統合テスト21件合格 |
| 4 複数拠点/受付/実施記録/次回予約 | 完了 | 予定表(担当者別・他拠点予約/勤務の表示・リスト)、受付モード(全画面・利用権の目安表示)、今日の画面、完了+実施記録+取消、次回予約、SSE によるリアルタイム反映 |
| 5 回数券 | 完了 | 種類/付与/台帳/消化(明示確定のみ・冪等・1予約1件)/取消戻し/手動調整/期限変更/無効化/日次失効/期限間近通知 |
| 6 期間利用プラン | 完了 | 種類/契約/期間の遅延生成+付与/消化/取消/調整/終了・解約/期間締め(繰越ON/OFF)/期限通知 |
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

## Phase 3 記録
- 公開: /api/v1/public/orgs/:slug(/locations/:loc(/availability|/availability/summary|/bookings|/services/:id/questions)), /api/v1/public/manage/:token(/cancel|/reschedule|/availability|/ics)
  - bot対策: IPレート制限、フォームトークン(3秒〜2時間)、ハニーポット、任意Turnstile。冪等キーで再送しても1件・同じ管理トークン
- 顧客: 検索(電話前方/下4桁・氏名/かな前方+部分一致フォールバック・メール)、可視性(拠点/担当)、機密メモ(受付不可)、重複候補(自動統合なし)、確認付き統合(予約/回数券/プラン/メモ/実施/待機/通知を移動)、アーカイブ、匿名化(件数・関係は保持)、個人データJSONエクスポート
- 通知: 送信箱(冪等キーUNIQUE)、ワーカー(SKIP LOCKED・リース・指数バックオフ・max_attempts→failed・手動再送)、スケジューラ(リマインダー・掃除)、本文は送信時生成(管理トークンは冪等キーからHMAC再計算しDB非保存)、サンプル組織は送信しない、log プロバイダは「未送信」と明示
- テスト: tests/integration/public-customers-notifications.test.ts(#9 機密メモ拒否、#17 通知重複なし、並行ワーカーで二重送信なし、再試行→失敗→手動再送)
- 画面: 公開予約ウィザード/予約管理ページ(iPhone 13 エミュレーションで通し確認)、顧客一覧/詳細(タイムライン・メモ・統合・匿名化)、予約一覧/詳細/作成ダイアログ(顧客検索・強制予約)、通知履歴
- サンプル: pnpm db:seed:sample(Sample Wellness。池袋/新宿、Aki/Mika/Ken、3サービス、4リソース、シフト、満席ヨガ、今日の受付状況)

## Phase 4 記録
- API: /api/v1/today(Staff=自分の予約・全拠点 / その他=拠点指定)、/api/v1/reception/board(拠点の当日予約・件数・利用権の目安。内部メモは出さない)、/api/v1/events(SSE。LISTEN/NOTIFY `sh_events`、ペイロードはIDのみ、25秒ごとにセッション再検証)
- 完了・記録: /api/v1/bookings/:id/completion(候補・権限)、/complete(完了+実施記録+任意の消化を1トランザクション)、/api/v1/records(一覧・編集・取消。取消時は消化を戻す/戻さないを明示し監査に記録)
- 次回予約: 予約作成の previousBookingId で実施記録 next_booking_id に紐付け(画面 /app/bookings/:id/next)
- 画面: ダッシュボード(今日の件数・次の予約・今日の一覧・消化確認待ち・期限間近の回数券)、予定表(担当者列・勤務時間外の斜線・休憩・他拠点勤務/他拠点予約のグレー表示・グループレッスンはまとめて表示・スマホはリスト)、受付モード(/app/reception 全画面、未完了/来店待ち/来店中/終了タブ、名前・かな・予約番号で絞り込み、来店/対応開始/完了へ/無断欠席、同時更新は版番号で検出して再表示)、完了・実施記録ページ
- サンプル: 過去の実施履歴(常連4回・残一7回利用・期限間近3回利用+締切後キャンセル確認待ち・無断欠席・月4回会員)を予約エンジン/完了処理/台帳経由で投入(sample/extras.ts)。月初・月末・全曜日で投入できることをテストで確認(Mika 休業日の月曜翌日に体験予約が失敗する既存の不具合を修正)

## Phase 5-6 記録
- 回数券: /api/v1/pass-products, /api/v1/customers/:id/passes, /api/v1/passes(/:id 台帳・台帳合計との一致確認 /adjust /expiry /void)
- 利用プラン: /api/v1/plan-products, /api/v1/customers/:id/plans, /api/v1/plans(/:id 期間・台帳 /adjust /end)
- 消化: /api/v1/bookings/:id/consume(完了済み、または締切後キャンセル/無断欠席の確認待ち)、/consumption/reverse(+1、元エントリ参照)、/consumption/waive(消化しない)
- 日次ジョブ(jobs/register.ts): 回数券の失効(expire)と期限間近通知、プラン期間の締め(繰越ON: carryover_out/in、OFF: expire)と契約終了、プラン期限通知。いずれも冪等キーで二重実行しても1回
- 画面: 回数券一覧/詳細(台帳・調整・期限変更・無効化)、利用プラン一覧/詳細(期間・台帳・調整・終了/解約)、顧客詳細の回数券・プランタブ(付与・契約)、設定>回数券の種類/利用プランの種類、完了画面の消化候補(明示選択しない限り消化しない)、締切後キャンセル/無断欠席の消化確認
- テスト: tests/integration/records-entitlements.test.ts(必須 #1〜#6・#18、同時消化、DBでの台帳改ざん拒否、権限、テナント分離、受付ボード、今日の画面、実施取消、次回予約)
- E2E(Playwright・Chromium 端末エミュレーション): E2E-1 / E2E-2 / E2E-3 / E2E-6 と主要画面の表示確認(PC/iPhone/Android/iPad)。tests/e2e、`pnpm test:e2e`
