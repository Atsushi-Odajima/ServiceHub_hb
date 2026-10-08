# 進捗 (PROGRESS.md)

最終更新: 2026-09-30(Phase 10)

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
| 7 待機/定員/ロール別画面 | 完了 | 待機リスト(登録・候補抽出・運営者の案内・先着順の再判定・予約で自動クローズ・期限切れ)、公開のキャンセル待ち登録、クラスの定員表示、ロール別ダッシュボード |
| 8 KPI/検索/CSV/監査 | 完了 | 運営KPI(期間・分母明示、欠損は—、拠点別合計=全体、稼働率)、横断検索、CSV出力7種(BOM・数式対策・カーソル分割)、CSV取込3種(プレビュー→検証→反映・二重取込防止)、監査ログ画面、画面単位の権限表示 |
| 9 バックアップ/セキュリティ/負荷・競合 | 完了 | 組織バックアップ(作成・検証・1トランザクション復元・台帳の再生照合・暗号化)画面とCLI、E2E-7、全APIのテナント分離/RBAC網羅/CSRF/XSS/ログ/レート制限テスト、競合の重点テスト、目標規模での負荷測定(LOAD_TEST_REPORT.md)、OPERATIONS.md |
| 10 端末E2E/アクセシビリティ/説明書/デプロイ/販売前チェック | **一部未完了** | アクセシビリティ・説明書・デプロイ・販売前チェック資料は完了。端末E2Eは Chromium の端末エミュレーション(PC/iPhone/Android/iPad)で完了、**実機 E2E は未実施**(この環境に実機・Safari がない。RELEASE_CHECKLIST.md 4.1 で人が行う) |

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

## Phase 7 記録
- 待機: modules/waitlist(service.ts / routes.ts)、migration 0003(候補の一意性を式索引に、matched_at / cancel_reason)
  - 登録: 管理画面(/api/v1/waitlist)と公開ページ(/p/:org/:loc/waitlist、フォームトークン・ハニーポット・レート制限・同意)。同条件の再登録は同じ待機、1人10件まで、希望期間は31日以内
  - 候補: キャンセル・無断欠席・日時変更・復元・予約作成で、その日の有効な待機がある場合だけ再計算(SAVEPOINT で元の操作は失敗させない)。定期ジョブが15分以上前に計算した待機を順に再計算。公開予約できる拠点・サービスは公開予約と同じ条件で判定
  - 案内: 運営者が「メールで案内」(送信箱・冪等キー waitlist_available:{matchId}、リンクにサービス・日付・時刻)または「連絡済みにする」。案内前に空きを再判定し、埋まっていれば stale(409)
  - 予約: 候補から「この枠で予約」(待機IDを指定・顧客/拠点/サービスの一致を検査)、または同じ顧客が同条件で予約すると自動で「予約済み」。予約は自動で確定しない
- ダッシュボード: /api/v1/dashboard(拠点ごとの当日件数・出勤人数・待機/空きの候補、消化確認待ち、期限間近の回数券、送信失敗の通知、Staff は自分の予定と記録未入力)
- 定員制: 予定表のグループ枠に「予約人数/定員」、公開予約の残席表示(既存)、必須テスト #13(既存)
- 不具合修正(E2E-4 で発見): 公開予約の確認画面で先に枠が埋まった場合、無効中のクエリを refetch して `/…/null` の HTML をデータとして扱い画面が真っ白になっていた → 無効中は要求しない・API応答が JSON でなければエラー・invalidate で取り直す
- テスト: tests/integration/waitlist-dashboard.test.ts(必須 #16、先着順、通知の冪等と再判定、予約での自動クローズ、公開登録の検査、期限切れ、権限、テナント分離、ダッシュボードの項目)、E2E-4、公開キャンセル待ち登録(全端末)

## Phase 8 記録
- KPI: modules/kpi(service.ts / routes.ts)、/api/v1/kpi(kpi.read。Manager は担当拠点のみ)、画面 /app/kpi
  - 予約: 件数・完了率・無断欠席率(分母=キャンセルを除く)・顧客/事業者キャンセル率(分母=予約件数)・利用人数。拠点ごとに集計して合算
  - 稼働率: 勤務 − 休憩等(重複は1回)に対する占有のサービス時間(buffer除く)。無断欠席は含めキャンセルは除く。シフト外予約は別に件数
  - 顧客: 新規(組織で最初の完了が期間内)・リピーター、人数は重複なし。回数券の純利用数・失効・30日以内期限、プランの当期利用率、待機・通知失敗
- 検索: /api/v1/search(顧客・予約番号・スタッフ・サービス。権限・拠点スコープ・Staff は自分の予約のみ)、画面 /app/search
- CSV 出力: /api/v1/csv/export/:kind(customers / bookings / services / staff / pass-ledger / plan-ledger / records)。UTF-8 BOM・CRLF・引用・数式インジェクション対策(文字列の先頭 = + - @ タブ CR に ')、REPEATABLE READ の読み取り専用トランザクションでカーソル(1000行ずつ)送信、出力は監査ログに記録
- CSV 取込: /api/v1/csv/import/preview → /:id/commit(customers / services / staff、新規登録のみ、5,000行・5MBまで、UTF-8/Shift_JIS)。エラーが1件でもあれば反映不可、ファイル内・既存との重複は「取り込まない/別人として登録」を選択(自動統合しない)、同じ内容(SHA-256)のファイルは二重取込不可(DB の部分一意索引でも保証)
- 監査ログ: /api/v1/audit(期間・種類・拠点で絞り込み、新しい順のカーソルページング。Manager は担当拠点の記録のみ)、画面 /app/audit(変更前後・詳細を表示)
- 画面: 権限のない画面は RequirePerm で「表示できません」と案内(以前は一部で読み込み中のまま)。サーバー側の検査は従来どおり
- テスト: tests/unit/kpi.test.ts(稼働率 3/7・勤務なし null・CSV の数式対策と往復)、tests/integration/kpi-search-csv-audit.test.ts(必須 #20、率の分子分母、稼働率、検索スコープ、CSV 出力/取込、監査ログ)、E2E-5(受付: 来店可・Owner設定/KPI不可 / スタッフ: 実施記録可・KPI不可)

## Phase 9 記録
- バックアップ: src/server/backup(spec / format / catalog / dump / verify / restore)、CLI src/server/cli/backup.ts、API modules/backup/routes.ts、画面 設定 > バックアップ(/app/settings/backup)
  - 形式: gzip NDJSON(ヘッダー: 形式/DB構造の版/アプリの版/作成日時/組織、表ごとの件数と SHA-256、全体の SHA-256)。任意で AES-256-GCM(BACKUP_ENCRYPTION_KEY)
  - 復元: new(空の環境)/ replace(置き換え)を1トランザクションで。RLS のテナント文脈で書き込み、別組織の行を含むファイルは拒否、既存ユーザーは上書きしない、循環参照は後から更新、台帳は元の順序で再生して DB のトリガーで残数を再計算 → 全エントリと残数を照合、全表を読み直して内容ハッシュを照合、未送信通知は skipped、dry run(復元テスト)
  - 画面からの復元の安全策: 2時間以内の現在データのバックアップ・URL 名の入力・操作者がバックアップ内の有効な Owner・別組織は追加の確認。完了後は全員再ログイン
  - 移行 0004: set_updated_at が app.restoring 中は更新しない、外部キーの参照側索引
- セキュリティ: app.routeList(登録済みルート一覧)を使った全APIの網羅テスト、RBAC 表のテスト、CSRF/Cookie/ヘッダー、XSS(API と実ブラウザ)、ログの個人情報、レート制限。発見した問題(開発用メールAPI・NUL で 500・認証前の本文検査・ログの検索語/DB詳細)を修正
- 競合: tests/integration/concurrency.test.ts(同一枠・別拠点同一スタッフ・同一リソース・定員・変更と新規・キャンセル直後・回数券/利用プランの同時消化・同一顧客/予約の同時更新)
- 負荷: tests/load/generate.ts(scale で段階的に生成。scale=1 で目標規模・約16分)と run.ts(実サーバーを autocannon で測定)。空き枠計算の無駄を解消。結果は LOAD_TEST_REPORT.md(販売保証値ではない)
- 並び順の安定化: 一覧の ORDER BY に ID を追加、array_agg に ORDER BY、顧客タイムラインのカーソルを「日時|行ID」に
- 資料: OPERATIONS.md(環境変数・コマンド・アップデート・バックアップ・復元・障害対応・定期作業)、SECURITY.md、DECISIONS.md(D-028〜D-031)、DATA_MODEL.md、TEST_REPORT.md、LOAD_TEST_REPORT.md

## Phase 10 記録
- 端末E2E(Chromium の端末エミュレーション: PC 1366px / iPhone 13 / Pixel 7 / iPad Pro 11): E2E-1〜7、主要画面、アクセシビリティ、XSS、PWA/オフライン、入力の下書き、Turnstile。**実機は未実施**
- アクセシビリティ: axe-core(WCAG 2.1 A/AA)で主要24画面 × 4端末の critical/serious 0件、キーボード操作(スキップリンク・ダイアログのフォーカス閉じ込めと戻り・フォーカス表示)、入力エラーの関連付け(aria-invalid/aria-describedby/role=alert)、タッチ端末で44px以上、状態は色+文字/記号、受付モードの状態・時刻は16px以上。小さいボタンをタッチ端末で44pxに
- PWA/オフライン: ホーム画面追加の情報(manifest/apple-touch-icon/theme-color)、オフライン表示・操作不可・最後の受付ボードの閲覧、ログアウトで閲覧キャッシュ削除(e2e-p1)。**入力の下書き**(実施記録・顧客情報・顧客メモを端末に保存・未送信表示・再接続で読み直し・送れなかった内容の表示・ログアウト時に件数確認して削除)を実装(仕様「オフライン入力は下書き/未同期表示。再接続時に最新状態を再検証」。e2e-p2)
- デプロイ: Dockerfile / docker-compose.yml / deploy/postgres/init-app-db.sh / deploy/docker.env.example / render.yaml。環境変数による初回セットアップ(SETUP_*)、SEED_SAMPLE_ON_START、`seed-sample --delete`、`reset-password` CLI、空文字の環境変数の扱い・RENDER_EXTERNAL_URL。この環境で Docker イメージのビルドと docker compose での起動・初回セットアップ・サンプル作成/削除・ログイン・バックアップ・再起動を確認(D-032)。本番公開・有料契約はしていない
- 仕様との突き合わせで追加・修正(D-034): 検索に回数券・拠点、CSV「キャンセル・無断欠席」、ダッシュボードの利用プラン残り、重複候補の見える範囲、締切後キャンセル/無断欠席の消化の取消を画面に、「完了時は表示しない」設定の反映、過去の予約の復元(理由付きの強制)、無断欠席・リソースのアーカイブの確認、テーマカラーの反映、シフトの他拠点表示、表示名の変更、Turnstile の画面側(D-033)
- 説明書: manual/ の15ファイル(UTF-8 BOM・CRLF)。THIRD_PARTY_NOTICES.txt は `pnpm notices`(scripts/third-party-notices.mjs)で本番の依存・画面に同梱されるライブラリ・Service Worker のライブラリから生成
- 販売前チェック: docs/RELEASE_CHECKLIST.md(完成条件30項目の対応・必須テスト20件・E2E・人が行う確認・配布物・既知の制限)。README.md(入口)
- 資料: OPERATIONS.md(1章 デプロイ、コマンド、復旧)、OPERATING_COSTS.md(誤りの修正)、SECURITY.md、DECISIONS.md(D-032〜D-034)、DEVELOPMENT.md、TEST_REPORT.md

## ReserveFlow(#015)統合の記録
- 内容は DECISIONS.md D-035。移行 `0005_reserveflow_merge.sql`(共通質問の service_id NULL 許可、manage_token_nonce、source_detail)。
- 統合テスト `tests/integration/reserveflow-merge.test.ts`(7件): 店舗宛て通知(Web予約・変更・キャンセル、スタッフ操作では送らない、種類ごとの停止)、共通質問(表示順・必須検証・管理ページとCSVの回答)、管理リンクの再発行/無効化/再送メール、変更締切、電話番号の要否・完了メッセージ・ご案内のメール掲載・URL検証、一括 .ics。
- 画面: 組織設定(店舗へのメール通知・署名)、拠点の予約ページ設定(電話番号・変更締切・同意文・完了メッセージ・ご案内・URL)、サービス一覧(共通の事前質問)、予約詳細(お客様用リンクの再発行・無効化、受付方法)、予約作成(受付方法)、CSV(カレンダー形式で出力)、公開予約・予約管理ページ。デザインは既存部品の組み合わせのみ。

## サロン空き枠お知らせ画像メーカー(#005)統合の記録
- 内容は DECISIONS.md D-036。名称「ServiceHub 空き枠お知らせ画像」。画面 /app/announcement(メニュー「日々の運営」)、API `GET /api/v1/availability/announcement`。移行なし。
- コード: src/server/modules/announcement/routes.ts、src/shared/announcement/core.ts・render.ts(元ツールの描画の移植)、src/web/pages/operations/AnnouncementPage.tsx。
- テスト: 単体 tests/unit/announcement.test.ts(14件: 日付・自動選択・上書き・1枠告知・チェック・全サイズ/種類のレイアウトのはみ出しなし)、統合 tests/integration/announcement.test.ts(9件: 7日分の候補と空き・予約の反映・休業日・過去時刻・基準・スタッフ指定・入力検証・権限・テナント分離)、security.test.ts の一覧漏えい検査に追加、E2E e2e-10-announcement(全端末でプレビューとPNG保存)、e2e-0 主要画面・e2e-8 アクセシビリティに画面を追加。
- テスト件数: vitest 239 → 262 件。E2E は Linux の POSIX ロケールで日本語のダウンロード名が "download" になるため、playwright.config.ts で Chromium を UTF-8 ロケール(LC_ALL=C.UTF-8)で起動するようにした。
- 画面のデザインは既存部品の組み合わせのみ(仮)。プレビューが画面の下にあり、日ごとの編集欄が縦に長い。

## 名札・受付チェック表メーカー(#010)統合の記録
- 内容は DECISIONS.md D-037。名称「ServiceHub 名札・受付表」。画面 /app/name-badges(メニュー「日々の運営」、予定表のグループ枠のダイアログからも開ける)、API `GET /api/v1/name-badges`。移行なし。
- コード: src/server/modules/namebadges/routes.ts、src/shared/namebadge/core.ts(番号・自然順・並び順・同行者・ページ分割・文字の収まり判定の移植)、src/web/pages/operations/NameBadgePage.tsx、印刷用 CSS は src/web/styles/app.css の `.nb-*`。
- テスト: 単体 tests/unit/namebadge.test.ts(18件: 番号の順序と欠番・自然順・同行者/1予約1枚・並び順・所属欄・ページ分割・除外・上限・文字幅と折り返し・文字サイズの段階・収まらない項目の報告)、統合 tests/integration/namebadges.test.ts(8件: 回の一覧と人数、回の予約・取消は氏名なし・欠番、後からの取消で番号不変、入力検証、マネージャー/受付の拠点スコープ、スタッフは担当分のみ、テナント分離、未ログイン)、security.test.ts の一覧漏えい検査に追加、E2E e2e-11-name-badges(全端末: 満席ヨガの回で名札6枚・受付表6行の番号一致、除外、印刷メディアで名札 91mm × 55mm・A4、PDF 2ページ)、e2e-0 主要画面・e2e-8 アクセシビリティに画面を追加。
- テスト件数: vitest 262 → 288 件。E2E 45 → 49 件合格(失敗は統合前と同じ e2e-6-realtime-devices の desktop 1件のみ・時刻依存の既知事象)。
- 印刷: Chromium の印刷メディアと PDF 出力で寸法・ページ数を確認した。実際のプリンターでの印刷は未確認。
- 画面のデザインは既存部品の組み合わせのみ(仮)。プレビューは実寸(210mm 幅)を横スクロールで表示する。
