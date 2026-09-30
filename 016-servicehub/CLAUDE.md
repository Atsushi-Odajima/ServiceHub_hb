# ServiceHub (#016) — 作業メモ

- まず `docs/PROGRESS.md` と `docs/NEXT_STEPS.txt` を読むこと(セッション再開手順)。
- 設計の正本: docs/DECISIONS.md, DATA_MODEL.md, BOOKING_ENGINE.md, RBAC.md, PASS_LEDGER.md, PLAN_USAGE_RULES.md, SECURITY.md。
- ローカルDB: `service postgresql start`。接続ロールは非superuser `servicehub`(RLS検証のため superuser で接続しない)。
- テスト: `pnpm test`(統合テストは servicehub_test を毎回作り直す)、`pnpm test:e2e`。
- 規約: DEVELOPMENT.md §5(withTenant / organization_id 明示 / RLS下の索引 / allocate.ts 一元化 / 台帳のみで残数変更)。
- 他商品(#001〜#015)のフォルダは変更しない。有料契約・本番公開・実メール送信・秘密情報の使用はしない。
