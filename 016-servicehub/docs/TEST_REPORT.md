# テスト報告 (TEST_REPORT.md)

各 Phase 終了時に更新。実行コマンド・日時・結果・未検証事項を記録する。

## Phase 0 (2026-09-30)
- `vitest run tests/integration/poc-concurrency.test.ts` … 5/5 合格
  - RLS: 他組織の行が見えない/書けない、テナント文脈なしで0行
  - 排他制約: 同一スタッフの重複占有を拒否、隣接([) 区間)は許可
  - 同一枠30並行(advisory lock + 再検証): 成功1件
  - 同一枠30並行(ロックなし): 排他制約により成功1件
- `vite build` + vite-plugin-pwa: manifest / sw.js / registerSW.js 生成を確認

## Phase 1〜6 (2026-09-30 時点の累計)
実行: `pnpm test`(Vitest。統合テストは servicehub_test を毎回作り直す)… **121/121 合格**

| ファイル | 件数 | 主な内容 |
|---|---|---|
| tests/unit/engine.test.ts | 28 | 予約エンジン(営業時間・例外・シフト・休憩・他拠点・移動時間・リソース・定員・固定時刻・DST) |
| tests/integration/poc-concurrency.test.ts | 5 | RLS・排他制約・同一枠30並行 |
| tests/integration/auth-rbac.test.ts | 19 | 必須 #8、拠点スコープ、テナント分離、無効化で即時失効、ロール変更、招待、ロック |
| tests/integration/booking-engine.test.ts | 15 | 必須 #7 #10〜#15、冪等、同一枠20並行→1件、定員6に12並行→6件 |
| tests/integration/public-customers-notifications.test.ts | 21 | 必須 #9 #17、公開予約、顧客統合・匿名化、通知の再試行・手動再送・並行ワーカー |
| tests/integration/records-entitlements.test.ts | 25 | 必須 #1〜#6 #18、同時消化(残2に3予約→2件)、同一期間の同時消化、台帳の改ざん拒否、締切後キャンセル/無断欠席の確認、受付ボード、今日の画面 |
| tests/integration/sample-seed.test.ts | 8 | サンプル組織を7日連続(全曜日・月末/月初)+2月中旬で投入し、説明どおりの残数・状態になること |

実行: `pnpm test:e2e`(Playwright 1.56.1 / Chromium。servicehub_e2e を作り直し、購入者と同じ CLI で準備してから起動)… **12/12 合格**

| シナリオ | 端末 | 内容 |
|---|---|---|
| 主要画面の表示 | PC / iPhone 13 / Pixel 7 / iPad Pro 11 | 12画面の表示・横はみ出しなし・スクリプトエラーなし、公開予約ページ |
| E2E-1 | PC(顧客は iPhone) | Owner が画面で2拠点・リソース・スタッフ・サービス・シフト・回数券の種類を設定 → iPhone で公開予約 → 付与 → 来店 → 対応中 → 完了(8回券 8→7)→ 次回予約(実施記録に紐付く) |
| E2E-2 | Android(管理者は PC) | Aki が池袋で予約中 → 新宿の公開ページで同時間が候補外 → 管理画面の直接指定でも「強制でも不可」、APIの強制予約も STAFF_BUSY で拒否 |
| E2E-3 | iPhone | 月4回: 3回利用 → 4回目で残0 → 5回目は候補なし、プラン詳細で当期 0/4・台帳一致 |
| E2E-6 | PC + iPad + iPhone | iPad 受付で来店 → iPhone の Staff 画面と PC の一覧に再読み込みなしで反映 → Staff が完了 → PC・iPad に反映 |

未検証(販売前に人が確認): 実機の iPhone Safari / Android Chrome / iPad Safari での操作(この環境には Chromium のみ)、実メール送信。

## Phase 7 (2026-09-30)
- `pnpm test` … **132/132 合格**(追加: tests/integration/waitlist-dashboard.test.ts 11件、サンプル投入に待機の確認を追加)
- `pnpm test:e2e` … **17/17 合格**(追加: E2E-4、公開キャンセル待ち登録 × 4端末)
- E2E-4 で公開予約の不具合を発見し修正: 確認画面で先に枠が埋まると画面が真っ白になっていた(無効中クエリの refetch)。修正後は「たった今埋まった」旨の表示と最新の空き一覧に戻ることを確認

## Phase 8 (2026-09-30)
- `pnpm test` … **155/155 合格**(追加: tests/unit/kpi.test.ts 10件、tests/integration/kpi-search-csv-audit.test.ts 13件)
- `pnpm test:e2e` … **19/19 合格**(追加: E2E-5 受付/スタッフ、主要画面の確認に 待機・KPI・検索・CSV・監査 を追加)
- 補足: 台帳の作成日時は DB の現在時刻のため、テスト時計(2030年)と異なる。台帳を作成日で絞る KPI・出力のテストは実際の日付で確認している(本番では同じ時刻)

## Phase 9 (2026-09-30)
- `pnpm test` … **211/211 合格**(16ファイル。追加 56件)

| ファイル | 件数 | 主な内容 |
|---|---|---|
| tests/integration/backup-restore.test.ts | 13 | **必須 #19**(空のDBへ復元 → 回数券ごとの残数・台帳合計・各エントリの balance_after、利用プラン期間の残数が一致)、全表の件数と内容ハッシュの一致、復元環境にログインして API の表示が一致、同じ日時の台帳の再生順、置換復元・dry run・失敗時の全巻き戻し、改ざん/破損/途中切れ/別組織データの拒否、暗号化(鍵なし・誤鍵・正しい鍵)、SESSION_SECRET の違いの警告、既存ユーザーの紐付け(上書きしない)、締め出し防止、対象表と外部キー順の網羅 |
| tests/integration/backup-api.test.ts | 8 | Owner のみ、ダウンロード → 検証 → 復元テスト → 復元(全員再ログイン)、確認入力、直近バックアップの必須化、別組織のファイル、上限 |
| tests/integration/security.test.ts | 16 | 全APIルートの未ログイン 401 / 他組織IDで成功なし・漏えいなし・組織A不変、一覧/検索/CSV/バックアップの分離、全テナント表の RLS、接続ロール、CSRF/Origin/Referer、Cookie 属性、HSTS、CSP 等、SQL 記号、本文上限、XSS、ログの個人情報、公開ページ/推測/バックアップのレート制限 |
| tests/integration/rbac.test.ts | 5 | ロール→権限の対応表の固定と RBAC.md の照合、46 API × 4ロールの許可/拒否、担当拠点・担当スタッフの絞り込み |
| tests/integration/concurrency.test.ts | 11 | 同一枠50並行→1件、同一スタッフの池袋/新宿30並行→1件、同一リソース20並行→1件、定員6へ40並行→6以下、変更と新規の取り合い(#14)、キャンセル直後の枠10並行→1件、残1回の回数券へ10並行→1件、同一予約10回同時消化→1回、利用プラン期間10並行→1件、同一顧客20人同時編集→1件、同一予約の同時状態変更→1件 |
| tests/unit/logmask.test.ts | 3 | メール・電話のマスク、DB エラーの detail を出さない、URL のトークン・検索語のマスク |

- `pnpm test:e2e` … **21/21 合格**(追加: **E2E-7** バックアップ → 空環境へ復元 → 拠点/スタッフ/予約/顧客/回数券残/利用プラン/実施履歴/監査が一致、XSS の実ブラウザ確認、主要画面の確認に バックアップ を追加)
  - E2E-7 の手順: 環境Aで Owner が画面からバックアップをダウンロード → 空の DB に `backup.js restore --migrate`(購入者向け手順と同じコマンド)→ 復元した DB で2台目のサーバーを起動 → 同じパスワードでログインし、同じ画面(同じ ID の URL)を A/B で開いて表示を比較
- 負荷試験(`pnpm load:generate -- --scale 1` + `pnpm load:run`): 組織100・拠点500・スタッフ5,000・顧客50万・予約200万・回数券台帳200万・通知500万(DB 約8GB)で主要画面を測定。結果は **docs/LOAD_TEST_REPORT.md**(販売保証値ではない)
  - 例(10並行 p50): 権限チェック 17ms、今日の画面 25〜40ms、受付ボード 36ms、顧客検索 16〜23ms、予約一覧(担当)28ms、空き枠 約190ms、運営KPI(30日)約600ms
  - 大量データの上でも 同一枠への50並行予約 → 成功1件、別々の枠80件の予約作成 → 全件成功
- 依存パッケージ: `pnpm audit --prod` 既知の脆弱性なし。開発用の autocannon 経由で uuid に moderate の注意報(本番の成果物に含まれない)
- 見つかって直した不具合・改善(このPhaseのテストで発見):
  - 未ログインで見える開発用エンドポイント(`/api/v1/dev/mails`、NODE_ENV が production 以外のとき直近のメール本文=予約管理リンクを返していた)を削除
  - NUL 文字を含む検索語で 500 → 入口で 400
  - 回数券の調整/期限/無効化で本文の検査が認証より先(未ログインで 400)→ 認証を先に
  - リクエストログに検索語(電話番号など)が残っていた → マスク。DB エラーの detail(行の値)をログに出さない
  - 一覧の並び順が同順位で不定(予約・顧客・タイムラインなど、復元後の比較で発見)→ ID を最後の並び替えキーに。顧客タイムラインのページングを「日時|行ID」のカーソルに(同じ日時の取りこぼし防止)
  - 空き枠計算が大量データで遅い → 1回の計算内で結果を再利用(p50 311ms → 57ms @ scale 0.02)
- 未検証(人が行う確認として RELEASE_CHECKLIST.md に記載予定): 実機 Safari/Android での画面からのバックアップのダウンロード・アップロード、本番ホスティング(別サーバーの DB)での性能

## Phase 10 (2026-09-30)
- `pnpm typecheck` … 合格
- `pnpm test` … **231/231 合格**(19ファイル)

| 追加・拡張したテスト | 件数 | 主な内容 |
|---|---|---|
| tests/unit/config.test.ts(新規) | 7 | 空文字の環境変数は未設定扱い、短い暗号化キーは起動拒否、APP_BASE_URL 末尾の / 除去、Render の RENDER_EXTERNAL_URL、本番で公開URLなしは起動拒否、Turnstile のキーは両方必須、見本の SESSION_SECRET を拒否 |
| tests/integration/setup-bootstrap.test.ts(新規) | 5 | 環境変数による初回セットアップ(不正値・空欄では作らない、1回だけ、パスワードをログに出さない)、`reset-password` CLI で再設定リンクを発行 → 再設定 → ログイン(1回限り・監査ログ)、サンプル組織を1回だけ作成、サンプル組織とサンプル専用ログインの削除(本番の組織は不変) |
| tests/integration/turnstile.test.ts(新規) | 3 | 公開設定でサイトキーのみ返す、トークンなし・検証失敗は予約不可・成功なら予約可(検証サーバーへ送る値)、キャンセル待ちも検証 |
| kpi-search-csv-audit(+2) | 15 | 検索の回数券(顧客名・券の名前、受付/Manager は担当拠点の顧客のみ、LIKE 記号は文字扱い)と拠点(担当外は返さない)、CSV「キャンセル・無断欠席」(区分・日時・操作者・拠点スコープ) |
| public-customers-notifications(+1) | 22 | 重複候補は見てよい顧客だけ(担当拠点外の顧客の氏名・連絡先を出さない) |
| records-entitlements(拡張) | 25 | 締切後キャンセルで消化 → 取消(+1)で確認待ちに戻る → 再度消化 |
| auth-rbac(+1) / booking-engine(+1) / waitlist-dashboard(拡張) / security(拡張) | | 表示名の変更(本人のみ・監査)、拠点のシフト一覧に所属スタッフの他拠点勤務、ダッシュボードの利用プラン残り(受付には出さない)、CSV の全種類で他組織のデータが出ない |

- `pnpm test:e2e`(Playwright 1.56.1 / Chromium の端末エミュレーション)… **42 合格 / 8 スキップ / 失敗 0**(スキップは端末を限定したテストの対象外端末: キーボード操作は PC のみ、エラーの関連付けは PC・iPhone、色以外の表示は PC・iPad、44px はタッチ端末のみ)

| 追加した E2E | 端末 | 内容 |
|---|---|---|
| e2e-8-accessibility | 4端末 | axe(WCAG 2.1 A/AA)で24画面の critical/serious 0件、キーボード操作、エラーの関連付け、44px、色以外の状態表示・受付モード16px |
| e2e-p1-pwa-offline | iPhone / iPad | manifest・アイコン・Service Worker、オフライン表示と操作不可、最後の受付ボードの閲覧、再接続、ログアウトでキャッシュ削除 |
| e2e-p2-offline-drafts | PC / iPhone | オフラインの入力が下書きとして残る・未送信表示・送信不可 → 再接続で読み直し → 開き直しても復元 → 完了で下書き削除、他端末で先に完了されたら送らず内容を表示、顧客メモの下書きとログアウト時の確認 |
| e2e-p3-turnstile | iPhone | Turnstile 設定時は確認が済むまで「予約する」を押せず、確認後に予約でき、サーバーがトークンを検証(Cloudflare はテスト用の代替) |

- デプロイ設定の確認(この環境で実施): `docker build` でイメージ作成(通信を中継する環境のため CA を追加した一時 Dockerfile を使用。手順は製品の Dockerfile と同じ)→ `docker compose up`(PostgreSQL 16 の初期化で superuser でないアプリ用ロールを作成 → 起動時の移行 → SETUP_* で組織・オーナー作成 → サンプル組織作成)→ ログイン・画面配信・manifest/Service Worker・公開ページ・バックアップのダウンロードと検証・CLI のバックアップ/検証・`seed-sample --delete`・SETUP_OWNER_PASSWORD を消して再起動(何も作らない・データ保持)・HEALTHCHECK healthy・node ユーザーで動作。確認後にコンテナとボリュームは削除
- `pnpm audit --prod` … 既知の脆弱性なし
- 説明書の点検: 15ファイルが UTF-8(BOM)・CRLF、見出しの形式、1行の長さ、Markdown 記法なし、説明書どうしの参照先が存在することを確認
- サブエージェントによる説明書の作成時に、画面と説明の食い違いや不具合を洗い出して修正(DECISIONS.md D-034)
- 未検証(RELEASE_CHECKLIST.md 4章): 実機の iPhone Safari / Android Chrome / iPad Safari、本番ホスティング(Render 等)での作成と HTTPS、SMTP の実送信、Turnstile の実キー、本番環境での性能
