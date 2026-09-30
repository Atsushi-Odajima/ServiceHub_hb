# 販売前チェックリスト (RELEASE_CHECKLIST.md)

対象: ServiceHub 1.0.0(ブランチ `claude/016-servicehub`)/ 作成: 2026-09-30(Phase 10)

## 0. 判定の要約

| 項目 | 状態 |
|---|---|
| 実装(Phase 0〜10) | 完了 |
| 自動テスト | `pnpm test` と `pnpm test:e2e` がすべて合格(件数は TEST_REPORT.md の Phase 10) |
| 端末での確認 | Chromium の端末エミュレーション(PC 1366px / iPhone 13 / Pixel 7 / iPad Pro 11)で確認済み。**実機(iPhone Safari・Android Chrome・iPad Safari)では未確認** |
| 本番環境 | **未公開**(本番公開・有料契約はしていない)。Docker イメージのビルドと Docker Compose での起動はこの環境で確認。Render は設定ファイル(render.yaml)と手順のみ |
| メールの実送信 | **未確認**(既定は送信しない。実送信は SMTP 事業者の契約と設定が必要) |
| 料金 | OPERATING_COSTS.md は検索結果の要約から作成。**公式ページでの再確認が必要** |

**結論: 販売前に 4章の「人が行う確認」をすべて行うこと。** 完成条件28(実機E2E)は、この開発環境に実機・Safari(WebKit)がないため Chromium の端末エミュレーションで代替しており、実機での確認が済むまで満たしていない。

---

## 1. 完成条件 30項目の対応

凡例: ✅ 実装し自動テストで確認 / ⚠ 代替手段で確認・人による確認が必要

| No | 完成条件 | 状態 | 根拠(テスト・資料) |
|---:|---|:---:|---|
| 1 | PC/iPhone/Android/iPad で主要業務 | ⚠ | E2E を4端末のエミュレーションで実行(主要画面、E2E-1〜7、アクセシビリティ、PWA、入力の下書き)。実機は 4.1 |
| 2 | PWA | ✅ (実機⚠) | manifest(standalone・アイコン・maskable)、Service Worker、更新の案内、オフラインは閲覧のみ・操作不可(e2e-p1)、入力は下書き・未送信表示・再接続で再検証(e2e-p2) |
| 3 | マルチテナント(組織の分離) | ✅ | RLS(FORCE)+複合外部キー、接続ロールの起動時検査、security.test.ts(全APIルートで他組織IDの操作が成功しない・漏れない)、poc-concurrency |
| 4 | 複数拠点 | ✅ | E2E-1(画面で2拠点を設定)、E2E-2、拠点スコープのテスト(auth-rbac / rbac / kpi-search-csv-audit) |
| 5 | RBAC | ✅ | rbac.test.ts(46 API × 4ロール・RBAC.md と照合)、auth-rbac(必須#8・権限変更の即時反映・無効化で即時失効)、E2E-5 |
| 6 | サービス/スタッフ/シフト/リソース | ✅ | booking-engine.test.ts、E2E-1(画面で設定)、シフトの他拠点表示 |
| 7 | 高精度予約エンジン | ✅ | engine.test.ts(28件: 営業時間・例外・シフト・休憩・他拠点・移動時間・リソース・定員・固定時刻・DST)、booking-engine(必須#7 #10〜#15) |
| 8 | 複数拠点スタッフ競合防止 | ✅ | 必須#7、E2E-2、concurrency(池袋/新宿へ30並行 → 1件)、DB の排他制約 |
| 9 | 公開予約 | ✅ | public-customers-notifications、E2E-1(iPhone で公開予約)、E2E-4、公開キャンセル待ち(全端末) |
| 10 | 顧客台帳/タイムライン | ✅ | public-customers-notifications(必須#9 #18、タイムラインのページング)、確認付き統合・匿名化 |
| 11 | 受付モード | ✅ | E2E-6(iPad 受付 → 他端末に反映)、E2E-5(受付)、状態を文字でも表示・16px 以上(e2e-8)、オフライン(e2e-p1) |
| 12 | 実施記録 | ✅ | records-entitlements、E2E-1、E2E-6、入力の下書き(e2e-p2) |
| 13 | 次回予約 | ✅ | E2E-1(実施記録に紐付く)、records-entitlements |
| 14 | 回数券台帳/残数再現 | ✅ | 必須#1〜#3 #5 #6、台帳トリガー(直接更新の拒否)、必須#19 |
| 15 | 二重消化防止 | ✅ | 必須#2、concurrency(残1回へ10並行 → 1件、同一予約へ10回 → 1回) |
| 16 | 期間利用プラン | ✅ | 必須#4、E2E-3、records-entitlements |
| 17 | 待機リスト | ✅ | 必須#16、E2E-4、waitlist-dashboard |
| 18 | 定員制 | ✅ | 必須#13、concurrency(定員6へ40並行 → 6以下) |
| 19 | キャンセル/無断欠席ルール | ✅ | records-entitlements(締切後キャンセル/無断欠席は確認待ち → 消化/消化しない/取消)、KPI、CSV「キャンセル・無断欠席」 |
| 20 | 通知重複防止 | ✅ | 必須#17、並行ワーカーで二重送信なし、再試行 → 失敗 → 手動再送 |
| 21 | Owner/Manager/Staff/Reception 画面 | ✅ | ロール別ダッシュボード(waitlist-dashboard)、E2E-5、E2E-6、権限のない画面の案内 |
| 22 | KPI | ✅ | kpi.test.ts、kpi-search-csv-audit(必須#20・分子分母・稼働率) |
| 23 | CSV | ✅ | kpi-search-csv-audit(出力8種・取込3種・BOM・数式対策・二重取込防止) |
| 24 | 監査ログ | ✅ | kpi-search-csv-audit、監査ログ画面、追記のみ(DB で変更・削除を拒否) |
| 25 | バックアップ/復元 | ✅ | 必須#19、backup-restore(13件)、backup-api(8件)、E2E-7、CLI |
| 26 | セキュリティ/RBAC/テナント分離テスト | ✅ | security.test.ts、rbac.test.ts、e2e-9(XSS) |
| 27 | 同時予約/回数券競合テスト | ✅ | concurrency.test.ts(11件)、目標規模の生成データ上での並行予約(LOAD_TEST_REPORT.md) |
| 28 | 実機E2E | ⚠ **未達** | Chromium の端末エミュレーションで E2E を実施。実機の iPhone Safari・Android Chrome・iPad Safari は未実施(4.1) |
| 29 | 運用費資料 | ✅ (金額⚠) | OPERATING_COSTS.md、pricing_research_2026-09-30.md。金額は公式ページで再確認(4.4) |
| 30 | 購入者向け説明書 | ✅ | manual/ の15ファイル(THIRD_PARTY_NOTICES.txt は `pnpm notices` で生成) |

---

## 2. 必須計算/整合性テスト 20件

| # | 内容 | テスト |
|---:|---|---|
| 1 | 8回券付与 → 1回利用 → 残7 | records-entitlements「#1 8回券を付与 → 完了時に1回消化 → 残7」 |
| 2 | 同じ利用操作の二重送信 → 残7のまま | records-entitlements「#2」、concurrency「同一予約10回同時消化」 |
| 3 | 利用取消 → 残8、履歴保持 | records-entitlements「#3 消化の取消で +1(use_reversal)」 |
| 4 | 月4回プラン → 3回利用 → 残1 | records-entitlements「#4」、E2E-3 |
| 5 | 期限切れ券を候補に出さない | records-entitlements「#5」 |
| 6 | 対象外サービスへ使えない | records-entitlements「#6」 |
| 7 | 池袋10:00 Aki → 同時刻新宿 Aki 不可 | booking-engine「#7」、engine.test「#7」、E2E-2 |
| 8 | Staff 権限で Owner 設定 API 拒否 | auth-rbac「#8」、rbac.test |
| 9 | Reception で経営KPI/機密メモ API 拒否 | public-customers-notifications「#9」、kpi-search-csv-audit(KPI 403) |
| 10 | アーカイブ後のスタッフに新規予約を割り当てない | booking-engine「#10」、engine.test「#10」 |
| 11 | シフト外予約不可 | booking-engine「#11」、engine.test「#11」 |
| 12 | リソース競合不可 | booking-engine「#12」、engine.test「#12」 |
| 13 | 定員6/5名予約済み → 2名不可・1名可 | booking-engine「#13」、engine.test「#13」 |
| 14 | 予約変更失敗時に元予約維持 | booking-engine「#14」、concurrency(変更と新規の取り合い) |
| 15 | キャンセルで枠再開放 | booking-engine「#15」 |
| 16 | 待機リストは自動確定しない | waitlist-dashboard「#16」、E2E-4 |
| 17 | 通知 Job 再送で重複なし | public-customers-notifications「#17」 |
| 18 | 顧客統合後も予約/台帳が正しい顧客へ | records-entitlements「#18」 |
| 19 | バックアップ復元後に残回数が一致 | backup-restore「#19 空の環境へ復元」、E2E-7 |
| 20 | 複数拠点 KPI で二重計上しない | kpi-search-csv-audit「#20」 |

## 3. E2E(Playwright / Chromium の端末エミュレーション)

| シナリオ | 端末 | ファイル |
|---|---|---|
| E2E-1 Owner設定 → 公開予約 → 受付 → 完了・8回券消化 → 次回予約 | PC(顧客は iPhone) | e2e-1-owner-to-next-booking |
| E2E-2 他拠点の予約で同時間を除外・手動予約も拒否 | Android(管理者は PC) | e2e-2-cross-location |
| E2E-3 月4回: 4回目で残0 → 5回目は候補なし | iPhone | e2e-3-period-plan |
| E2E-4 キャンセル → 待機候補 → 通知 → 別顧客が確定 → 古い空き表示から確定すると競合 | PC | e2e-4-waitlist |
| E2E-5 受付: 来店可・Owner設定不可 / Staff: 実施記録可・KPI不可 | iPad / iPhone | e2e-5a / e2e-5b |
| E2E-6 iPad 受付 → iPhone Staff → PC Owner へ反映 | PC + iPad + iPhone | e2e-6-realtime-devices |
| E2E-7 バックアップ → 空環境へ復元 → 一致 | PC | e2e-7-backup-restore |
| 主要画面・公開予約・キャンセル待ち | 4端末 | e2e-0-screens |
| アクセシビリティ(axe WCAG 2.1 AA・キーボード・エラーの関連付け・44px・色以外の表示) | 4端末 | e2e-8-accessibility |
| XSS(入力が実行されない) | PC | e2e-9-xss |
| PWA(ホーム画面追加の情報・オフライン) | iPhone / iPad | e2e-p1-pwa-offline |
| 入力の下書き(オフライン・再接続・競合・ログアウト) | PC / iPhone | e2e-p2-offline-drafts |

---

## 4. 販売前に人が行う確認

### 4.1 実機(完成条件1・2・28)
端末: iPhone(iOS の最新と1つ前の版の Safari)、Android(Chrome)、iPad(Safari)、PC(Chrome / Edge / Safari)。
- [ ] ログイン・ログアウト・「ログイン状態を保持する」
- [ ] ホーム画面に追加 → アプリのように全画面で起動する・アイコンが正しい
- [ ] 公開予約(ログインなし)を最後まで行う・予約確認リンクで変更とキャンセル
- [ ] 受付モード(iPad 横向き): 来店 → 対応開始 → 完了 → 別の端末に自動で反映
- [ ] 完了・回数券/利用プランの消化・次回予約(スマホ)
- [ ] 通信を切ったときの表示(オフライン表示・操作できない・入力が下書きとして残る)と再接続後の送信
- [ ] 新しい版をデプロイしたときの「更新があります」の案内と更新
- [ ] 日本語入力(変換中の Enter で送信されない)、日付・時刻の入力欄
- [ ] バックアップのダウンロードと、ファイルを選んでの検証・復元テスト(PC / iPad)
- [ ] CSV のダウンロードと Excel で開いたときに文字化けしない
- [ ] VoiceOver / TalkBack で主要な操作ができる(可能な範囲)

### 4.2 本番相当の環境
- [ ] 選んだホスティング(例: Render の Blueprint)で新しく作成し、起動ログで DB 構造の作成(`btree_gist` の作成を含む)と接続ロールの検査(superuser / BYPASSRLS でない)が成功する
- [ ] HTTPS で公開され、HSTS 等のヘッダーが付く。独自ドメインと `APP_BASE_URL`
- [ ] `SETUP_*` で最初のオーナーを作成 → ログイン → `SETUP_OWNER_PASSWORD` を削除
- [ ] `SESSION_SECRET` と `BACKUP_ENCRYPTION_KEY` を安全な場所に保管
- [ ] 通知ワーカーと日次処理が動く(リマインダー・回数券の失効・利用プランの期間締め・待機の期限)
- [ ] DB の自動バックアップ/時点復旧の設定、`/healthz` の外形監視
- [ ] 本番でサンプル組織を作らない(作った場合は `seed-sample.js --delete`)
- [ ] Turnstile(bot 対策)を使う場合は、実際のキーで公開予約とキャンセル待ちの登録ができることを確認(この環境からは Cloudflare に接続できず、テスト用の代替で確認)

### 4.3 メール
- [ ] SMTP 事業者と契約し、送信ドメインの SPF / DKIM / DMARC を設定
- [ ] テスト用の宛先で、予約確定・変更・キャンセル・リマインダー・空き枠のお知らせ・回数券の期限・利用プランの終了・招待・パスワード再設定の各メールが届き、リンクが開ける
- [ ] 迷惑メールに分類されない。送信失敗時に通知履歴に出て再送できる

### 4.4 料金・契約・法務
- [ ] OPERATING_COSTS.md の金額を各社の公式ページで再確認し、販売ページに書く場合は「目安」「時期」「税別」を明記
- [ ] ホスティング・メール事業者の規約(SaaS としての提供・再販)の確認
- [ ] 購入者が自分の顧客向けに用意する利用規約・プライバシーポリシーの案内(本製品は法的適合を保証しない)
- [ ] 販売者の表示(特定商取引法など)
- [ ] THIRD_PARTY_NOTICES.txt を同梱(依存を更新したら `pnpm notices` で作り直す)
- [ ] 販売ページの表現: 医療機関向けの電子カルテ・診療予約として販売しない。負荷試験の値を保証値として広告しない(「200万予約対応」等は不可)

### 4.5 セキュリティ
- [ ] 第三者による脆弱性診断(推奨)
- [ ] `pnpm audit --prod` の確認と依存の更新
- [ ] 本番のログに個人情報(メール・電話・検索語・トークン)が出ていない

### 4.6 性能
- [ ] 本番のホスティング(アプリと DB が別サーバー)で、今日の画面・受付ボード・空き枠・顧客検索の応答を確認(LOAD_TEST_REPORT.md は同一マシンでの測定)
- [ ] 大きな組織でのバックアップ作成・復元にかかる時間を確認

### 4.7 説明書
- [ ] manual/ の手順を実際の画面と突き合わせる(必要ならスクリーンショットを追加)
- [ ] Windows のメモ帳・Mac のテキストエディットで文字化けせずに開ける(UTF-8 BOM 付き・CRLF)

### 4.8 運用の準備
- [ ] 問い合わせ窓口・サポートの範囲を決めて購入者に案内
- [ ] 更新手順(OPERATIONS.md 2章)と復元の訓練(6.4)を一度通して行う

---

## 5. 配布物

- 含めるもの: `016-servicehub/` のうち `README.md` `src/` `db/` `public/` `scripts/` `deploy/` `docs/` `manual/` `tests/`、`Dockerfile` `.dockerignore` `docker-compose.yml` `render.yaml` `package.json` `pnpm-lock.yaml` `tsconfig*.json` `vite.config.ts` `vitest.config.ts` `playwright.config.ts` `.env.example`
- 含めないもの: `node_modules/` `dist/` `test-results/` `playwright-report/` `.env` `*.shbak`、負荷試験の生成データ、開発メモ(`CLAUDE.md`)
- 作り方の例: `pnpm notices` を実行してから、リポジトリのルートで `git archive --format=zip -o servicehub-1.0.0.zip HEAD:016-servicehub`(コミット済みの内容だけが入る)
- 購入者が最初に読むもの: `manual/はじめに.txt` → `manual/初期設定ガイド.txt`、サーバー作業は `docs/OPERATIONS.md`

## 6. 既知の制限

- 決済・月額課金・返金はない(回数券・利用プランは購入済みの利用権を管理する。価格は表示用の文字)。
- 通知はメールのみ(SMS・LINE・端末へのプッシュ通知はない)。メールの実送信には SMTP の設定が必要(既定は送信しない)。
- 外部カレンダーは予約ごとの .ics 出力のみ(Google / Outlook との同期はない)。
- オフラインでは、最後に取得した今日の画面・受付ボード等の閲覧と、入力の下書きのみ。予約・来店・完了・消化などの操作はオンラインが必要。
- 画面から組織を削除する機能はない(OPERATIONS.md 9.2)。
- CSV 取込は顧客・サービス・スタッフの新規登録のみ。予約・台帳の移行はバックアップ/復元で行う。
- 画面からの復元はファイル 200MB まで(`BACKUP_UPLOAD_MAX_MB`)。大きい場合はコマンドで行う。
- ファイル・写真の添付はない。画面は日本語のみ。
- 組織のURL名(slug)とログインのメールアドレスは画面から変更できない(組織名・表示名は変更できる)。
- 新しく作った拠点は営業時間が未設定(すべて休業)の状態で始まる。拠点の設定で営業時間を入れるまで予約を受け付けない。
- 利用プランの延長は新しい契約として登録する。無効化した回数券には消化の取消で戻せない。
- ダッシュボード・KPI の利用プランの今期の集計は、今期の期間が作られている契約(今期に利用・調整・繰越があったもの)が対象。
- 端末の確認は Chromium の端末エミュレーションのみで、Safari(WebKit)固有の挙動は未確認。
- 性能は開発環境の同一マシンでの測定値で、販売保証値ではない。
- 医療機関の電子カルテ・診療予約ではない(医療情報・診断の記録には使わない)。
