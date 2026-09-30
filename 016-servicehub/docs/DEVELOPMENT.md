# 開発ガイド (DEVELOPMENT.md)

## 1. 必要環境(開発者のみ。購入者には不要)
- Node.js 22.12 以上、pnpm 10、PostgreSQL 16(ローカル or Docker)
- E2E: Playwright 1.56(Chromium)。`PLAYWRIGHT_BROWSERS_PATH` に Chromium があればダウンロード不要。

## 2. セットアップ
```bash
cd 016-servicehub
pnpm install
cp .env.example .env            # DATABASE_URL / SESSION_SECRET を設定
# DB ロールは superuser/BYPASSRLS なしで作る(RLS検証のため)
#   CREATE ROLE servicehub LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS CREATEDB;
#   CREATE DATABASE servicehub_dev OWNER servicehub;
pnpm db:migrate
pnpm db:seed:sample             # サンプル組織 Sample Wellness(is_sample=true)
pnpm dev                        # API :3000 + Vite :5173(プロキシ)
```

## 3. テスト
```bash
pnpm typecheck
pnpm test:unit
pnpm test:integration           # TEST_DATABASE_URL(既定 servicehub_test)を毎回作り直す
pnpm test:e2e                   # ビルド済みサーバーを起動して Playwright(PC/iPhone/Android/iPad エミュレーション)
pnpm load:generate && pnpm load:run   # 負荷試験(大量データ生成は servicehub_load DB)
```

## 4. ディレクトリ
```
db/migrations/         SQL移行(適用後は変更禁止。変更は新しい番号で追加)
src/shared/            権限・定数・Zodスキーマ・時間ユーティリティ(サーバー/クライアント共通)
src/server/            Fastify API・予約エンジン・ジョブ・CLI
  engine/              予約エンジン(純関数) + DBローダー
  modules/<domain>/    routes.ts(API) + service.ts(業務処理)
  jobs/                通知ワーカー・スケジューラ
  cli/                 migrate / seed / setup-org / backup
src/web/               React SPA(PWA)
tests/unit|integration|e2e|load
docs/                  開発資料   manual/  購入者向け資料
```

## 5. コーディング規約(重要)
1. **テナント**: API ハンドラの DB アクセスは `withTenant(pool, {orgId}, fn)` のみ。`withSystem` はログイン照合・公開ページの組織解決・トークン照合・ジョブ・CLI 限定。
2. **全クエリに `organization_id = $1`** を明示(RLS と二重防御 + 索引利用)。
3. **RLS下の索引**: `LIKE`, `&&`(range overlap), `@>` は索引条件にならない。重複判定は `a.start < $end AND a.end > $start`、検索は正規化列の前方一致(`col >= $1 AND col < $1 || '￿'`)。
4. SQL は `$n` パラメータのみ。動的識別子はホワイトリスト。
5. 予約/占有を作る・変えるコードは `modules/bookings/allocate.ts` のみ(ロック順序を一元化)。
6. 回数券/プランの残数は台帳 INSERT のみで変える(直接 UPDATE はトリガで失敗する)。
7. 業務操作は同一トランザクションで 監査ログ・履歴・通知(outbox) を書く。
8. 日時は API では UTC ISO 文字列、拠点ローカル表示は `src/shared/time.ts`。
9. エラーは `AppError(code, 日本語メッセージ)`。
10. 同じトランザクション(Q)で `Promise.all` による並列クエリを発行しない(pg は同一接続で直列実行し、pg@9 で廃止予定の警告が出る)。

## 6. 主要コマンド
| コマンド | 内容 |
|---|---|
| `pnpm build` | Web(Vite) + Server(esbuild) を dist/ へ |
| `pnpm start` | 本番起動(dist/server/index.js) |
| `pnpm start:worker` | 通知ワーカー/スケジューラのみ起動 |
| `pnpm setup:org` | 本番用の組織と最初のオーナーを作成(対話なし・引数指定) |
| `pnpm backup:create -- --org <slug> --out file` | 組織バックアップ |
| `pnpm backup:verify -- --file f` | バックアップ検証 |
| `pnpm backup:restore -- --file f [--replace <slug>] [--dry-run] [--database-url <url>] [--migrate]` | 復元(既定は同じ組織がない環境へ。`--replace` で置き換え。1トランザクションで失敗時は現行データ維持) |
| `pnpm load:generate -- --scale 0.1` | 負荷試験用データを servicehub_load に生成(scale=1 で目標規模・約8GB) |
| `pnpm build && pnpm load:run -- --out docs/LOAD_TEST_REPORT.md` | 負荷試験の測定(ビルド済みサーバーを起動して autocannon で測る) |

## 7. テストの追加時の注意
- 新しい API ルートは `tests/integration/security.test.ts` が自動で網羅する(未ログイン 401・他組織IDで成功しない)。パス中の `:param` が新しい種類の場合は `TABLE_BY_SEGMENT` に対応を追加する。
- 新しい表は `src/server/backup/spec.ts` のバックアップ対象か除外(理由付き)に加える(`backup-restore.test.ts` が検査)。
- 一覧 API の ORDER BY は最後に ID を加えて順序を一意にする(ページング・復元の照合で必要)。
