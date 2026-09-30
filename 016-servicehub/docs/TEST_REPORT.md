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
