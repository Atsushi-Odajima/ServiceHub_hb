# ServiceHub — 小規模サービス事業 統合運営システム

予約・顧客・スタッフ・拠点・受付・回数券・利用プラン・待機リスト・運営KPIまでを、1つの Web アプリで運用するための業務システムです。
PC のブラウザ、iPhone(Safari)・Android(Chrome)、iPad で使え、スマホ・タブレットではホーム画面に追加してアプリのように使えます(PWA)。

- 購入者・利用者の方: まず **[manual/はじめに.txt](manual/はじめに.txt)**、次に **[manual/初期設定ガイド.txt](manual/初期設定ガイド.txt)** をお読みください。
- サーバーの準備・運用をする方: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**(デプロイ・環境変数・バックアップ・復元・障害対応)
- 運用費の目安: [docs/OPERATING_COSTS.md](docs/OPERATING_COSTS.md)(金額は各社の公式ページで最新を確認してください)
- 第三者ソフトウェアのライセンス: [manual/THIRD_PARTY_NOTICES.txt](manual/THIRD_PARTY_NOTICES.txt)

> 医療機関の電子カルテ・診療予約システムではありません。オンライン決済は含みません(回数券・利用プランは購入済みの利用権を管理します)。

## 構成

- サーバー: Node.js 22 + Fastify 5 + PostgreSQL 16(組織ごとのデータ分離を DB の行レベルセキュリティでも強制)
- 画面: React 19 + Vite(PWA)
- デプロイの例: `render.yaml`(Render の Blueprint)、`Dockerfile` / `docker-compose.yml`(自社サーバー・VPS)
- 購入者のパソコンに開発環境は不要です(ホスティングの画面で環境変数を設定するだけで始められます)。

## 開発者向け

- 開発手順・コマンド: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 設計資料: [docs/PLAN.md](docs/PLAN.md) / [DECISIONS.md](docs/DECISIONS.md) / [DATA_MODEL.md](docs/DATA_MODEL.md) / [BOOKING_ENGINE.md](docs/BOOKING_ENGINE.md) / [RBAC.md](docs/RBAC.md) / [PASS_LEDGER.md](docs/PASS_LEDGER.md) / [PLAN_USAGE_RULES.md](docs/PLAN_USAGE_RULES.md) / [SECURITY.md](docs/SECURITY.md)
- テスト: `pnpm test`(単体・結合)、`pnpm test:e2e`(Playwright)。結果は [docs/TEST_REPORT.md](docs/TEST_REPORT.md)、負荷試験は [docs/LOAD_TEST_REPORT.md](docs/LOAD_TEST_REPORT.md)(販売保証値ではありません)
- 販売前チェック: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)
