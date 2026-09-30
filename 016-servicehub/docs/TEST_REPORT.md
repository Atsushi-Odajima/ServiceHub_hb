# テスト報告 (TEST_REPORT.md)

各 Phase 終了時に更新。実行コマンド・日時・結果・未検証事項を記録する。

## Phase 0 (2026-09-30)
- `vitest run tests/integration/poc-concurrency.test.ts` … 5/5 合格
  - RLS: 他組織の行が見えない/書けない、テナント文脈なしで0行
  - 排他制約: 同一スタッフの重複占有を拒否、隣接([) 区間)は許可
  - 同一枠30並行(advisory lock + 再検証): 成功1件
  - 同一枠30並行(ロックなし): 排他制約により成功1件
- `vite build` + vite-plugin-pwa: manifest / sw.js / registerSW.js 生成を確認
