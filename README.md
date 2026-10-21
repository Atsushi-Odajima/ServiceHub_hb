# ServiceHub — 小規模サービス事業の運営管理

予約・顧客・スタッフ・拠点・受付・回数券・利用プランをまとめる、サービス業向けWebアプリです。

> **実装ブランチ：`claude/merge-name-badges`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- 予約・待機リスト・受付、顧客・スタッフ・拠点管理
- 購入済み回数券・プラン、KPI、権限と監査
- 統合済みの予約機能拡張、空き枠告知画像、名札・受付表の作成

## 現在の範囲・制限

- オンライン決済や医療向け電子カルテではありません。回数券は購入済みの利用権を管理します。
- 印刷物の実寸・日本語保存名、スマートフォン実機の確認が残っています。統合画像・印刷ツールは最小UIです。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js、PostgreSQL、PWA、pnpm。

- [016-servicehub/src/server](https://github.com/Atsushi-Odajima/ServiceHub_hb/tree/claude%2Fmerge-name-badges/016-servicehub/src/server)
- [016-servicehub/src](https://github.com/Atsushi-Odajima/ServiceHub_hb/tree/claude%2Fmerge-name-badges/016-servicehub/src)
- [016-servicehub/tests](https://github.com/Atsushi-Odajima/ServiceHub_hb/tree/claude%2Fmerge-name-badges/016-servicehub/tests)

## ローカルで試す

Node.js 22.12以上、pnpm、PostgreSQL。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-name-badges https://github.com/Atsushi-Odajima/ServiceHub_hb.git
cd ServiceHub_hb/016-servicehub
pnpm install
```

開発手順で環境変数・DB移行・初期組織を設定し、pnpm dev を実行します。公開運用ではWebサーバーとジョブワーカーの両方が必要です。

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/DEVELOPMENT.md)。
WindowsでBash形式の補助スクリプトを使う場合は、WSL等の対応環境で実行してください。

## 検証方法

`016-servicehub/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run build
pnpm run build:web
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [016-servicehub/docs/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/DEVELOPMENT.md)
- [016-servicehub/docs/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/NEXT_STEPS.txt)
- [016-servicehub/README.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/README.md)
- [016-servicehub/docs/TEST_REPORT.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/TEST_REPORT.md)
- [016-servicehub/docs/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/RELEASE_CHECKLIST.md)
- [016-servicehub/docs/DATA_MODEL.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/DATA_MODEL.md)
- [016-servicehub/docs/DECISIONS.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/DECISIONS.md)
- [016-servicehub/docs/SECURITY.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/SECURITY.md)
- [016-servicehub/docs/OPERATIONS.md](https://github.com/Atsushi-Odajima/ServiceHub_hb/blob/claude%2Fmerge-name-badges/016-servicehub/docs/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
