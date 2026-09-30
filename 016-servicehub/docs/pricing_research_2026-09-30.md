# ServiceHub 運用コスト調査メモ（価格・商用条件）

- 調査日: 2026-09-30
- 想定構成: Node.js 22 + Fastify API / React SPA / PostgreSQL 16 / バックグラウンドワーカー（メール送信ジョブ）/ トランザクションメール（SMTP または API）
- 目的: `OPERATING_COSTS.md` を書くための一次資料

---

## 調査方法と信頼度の凡例（必読）

- WebFetch（ページを直接取得する機能）は egress proxy に遮断された（render.com と aws.amazon.com で `EGRESS_BLOCKED` を確認済み）。
- 代わりに **WebSearch の `allowed_domains` をベンダー公式ドメインに絞り**、検索結果の要約から数値を拾った。要約は検索側が自動生成したもので、**公式ページの本文を直接読んだわけではない**。契約前・見積確定前には必ず公式ページで数値を確かめること。
- 区分の意味:
  - **公式**: 公式ドメインに絞った検索結果の要約で確認できた（render.com, docs.railway.com, neon.com, supabase.com など）
  - **公式(コミュニティ)**: 公式ドメイン上のコミュニティ Q&A（station.railway.com など）。運営者の正式回答とは限らない
  - **第三者**: 第三者サイトでしか確認できなかった。未検証として扱う
  - **未確認**: 見つからなかった
- 「as-of」欄: 検索結果に日付があったものだけ書いた。日付がないものは「表示なし」。
- 金額はすべて USD・税抜き。消費税／リバースチャージ、カードの為替手数料は含めていない。

---

## 0. 要点サマリー

- **Render**: 2026-04-23 からワークスペースプランは **Hobby $0 / Pro $25/月（定額・人数無制限）/ Scale $499/月** の3つ。インスタンスは **Starter $7/月（512MB / 0.5CPU）**、**Standard $25/月（2GB / 1CPU）**。Background Worker には Free プランがない。
- **Render の帯域**: 月に含まれる量は **Hobby 5GB / Pro 25GB / Scale 1TB**、超えた分は **$0.15/GB**。**サービスから外へ出す通信**（例: R2 へのバックアップのアップロード）も課金対象なので注意。
- **Render Postgres**: 最小の有料プランは **Basic-256mb $6/月**、ストレージは **$0.30/GB/月**。PITR（ポイントインタイムリカバリ）の保持期間は **Hobby 3日 / Pro 以上 7日**。Basic-1gb 以上の価格は第三者サイトでしか確認できなかった。
- **Render のログ保持**: **Hobby 7日 / Pro 14日 / Scale 30日**。
- **Neon**: Launch プランは **$0.106/CU時間 + $0.35/GB-月**、最低料金なし。PITR は Launch で最大7日（$0.20/GB-月）。btree_gist と pg_trgm の両方に対応。
- **Supabase**: **Pro $25/月**（Micro コンピュート込み）、PITR は **7日ごとに $100/月** のアドオン。**btree_gist と pg_trgm の両方に対応**。
- **メール**: **Resend** は Free 3,000通/月（1日100通まで）、Pro $20/月で50,000通。**Postmark** は Basic $15/月で10,000通（超過 $1.80/1,000通）。**SES** のアラカルト単価は $0.10/1,000通。ただし 2026-07-21 に「料金プラン」が導入され、新規アカウントは Essentials プランから始まる（Essentials の月額は未確認）。
- **バックアップ保存先**: **R2 は $0.015/GB-月・egress 無料・10GB まで無料**。**B2 は $6.95/TB/月・最初の 10GB 無料**。
- **商用利用**: **Railway Hobby は非商用に限る**（有償 SaaS なら Pro が必要）。Render / Neon / Supabase の Free 枠は本番用途に向かない（スピンダウン、失効、一時停止などがある）。

---

## 1. ホスティング（Web サービス + バックグラウンドワーカー）

### 1.1 Render

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| ワークスペース: Hobby | $0/月（使った分だけ課金）。メンバー1名、サービス合計25まで、1プロジェクトあたり環境2まで | 公式 | 表示なし | [R2][R3][R24] |
| ワークスペース: Pro | **$25/月 定額**。メンバー無制限（席課金なし）。旧 Professional（$19/メンバー/月）の後継。SOC 2 / ISO 27001 レポートと監査ログを含む | 公式 | 2026-04-23 発表 | [R2][R3] |
| ワークスペース: Scale | **$499/月 定額**。旧 Organization（$29/メンバー/月）の後継。SSO / SCIM / 高度な RBAC / HIPAA / 複数ワークスペース | 公式 | 2026-04-23 発表 | [R2] |
| ワークスペース: Enterprise | 個別見積 | 公式 | 2026-04-23 発表 | [R2] |
| 旧プランの自動移行 | 旧プランのまま残っているワークスペースは 2026-08-01 に自動で移行 | 第三者 | 2026 | [T5] |
| プラン名の変更 | 2026-08-26 から仕様ベースの ID（例 `0.5c-512mb`, `1c-2g`, `4c-32g`）に変更。旧名（starter / standard / pro など）も API・Blueprint で引き続き使える。**価格は変わらない** | 公式 | 2026-08-26 | [R6][R7] |
| Starter（`0.5c-512mb`） | **$7/月**、512MB RAM / 0.5 CPU。Web、Private Service、Background Worker で使える | 公式 | 表示なし | [R1][R5] |
| Standard（`1c-2g`） | **$25/月**、2GB RAM / 1 CPU | 公式 | 表示なし | [R5][R6] |
| Pro（`2c-4g`）の月額 | 未確認（Workflows 用の記載「2c-4g タスクを30分実行すると $0.20」しか見つからなかった） | 未確認 | — | [R22] |
| Pro Ultra（32GB / 8 CPU） | $450/月 | 第三者 | 2026 | [T5] |
| 課金方式 | 月額プランを秒単位で日割り | 公式 | 表示なし | [R5] |
| Free インスタンス（Web のみ） | $0。15分アクセスがないとスピンダウンし、次のリクエストで約1分かけて起動。ワークスペースごとに月750時間まで | 公式 | 表示なし | [R15][R8] |
| Background Worker の Free | **なし**（Starter から） | 公式 | 表示なし | [R16] |
| 含まれる外向き帯域 | **Hobby 5GB/月、Pro 25GB/月、Scale 1TB/月**。余っても翌月に繰り越せない | 公式 | 2026-04-23〜 | [R11][R3] |
| 帯域の超過料金 | **$0.15/GB**（1GB 単位。以前は 100GB 単位） | 公式 | 2026-04-23〜 | [R11][R2] |
| 課金対象になる帯域 | HTTP レスポンスに加えて、**サービスが自分から外へ出す通信**（外部 API 呼び出し、オブジェクトストレージへのアップロードなど）と Private Link の通信も対象 | 公式 | 表示なし（8/1 施行の改定記事） | [R12] |
| ビルドパイプライン分 | Hobby 500分/月、Pro 1,000分/月を含む。超過は $5/1,000分 | 公式 | 2026-04-23〜 | [R3][R2] |
| カスタムドメイン | 基本数を超えた分は $0.25/月/ドメイン（基本数そのものは未確認） | 公式 | 2026-04-23〜 | [R2] |
| 参考: Render 公式記事の構成例 | 常時稼働の Starter Web + Basic-256mb Postgres（Hobby）で**約 $13/月**（帯域とストレージの増加分は含まない） | 公式 | 2026-07 時点 | [R8] |

### 1.2 Railway（代替案 1）

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Hobby | **$5/月**（$5 分の利用枠を含む。使わなくても $5 かかる）。「個人プロジェクト向け」 | 公式 | 表示なし | [W1][W2] |
| Pro | **$20/月**（$20 分の利用枠を含み、超えた分だけ追加で払う）。「本番に出すプロ開発者・チーム向け」。ワークスペースの席は無料・無制限 | 公式 | 表示なし | [W1][W7] |
| CPU | $20/vCPU/月（$0.000463/vCPU/分）。実際に使った分で課金 | 公式 | 表示なし | [W2] |
| RAM | $10/GB/月（$0.000231/GB/分） | 公式 | 表示なし | [W2] |
| Egress | $0.05/GB | 公式 | 表示なし | [W2] |
| Volume | $0.15/GB/月 | 公式 | 表示なし | [W2] |
| VM プリミティブ（サンドボックス等） | RAM $50/GB/月、CPU $50/vCPU/月（通常サービスとは単価が違う） | 公式 | 表示なし | [W2] |
| Hobby の上限 | サービスごとにレプリカ6、RAM 48GB、vCPU 48、Volume 5GB | 公式 | 表示なし | [W1] |
| Pro の上限 | レプリカ42、RAM 1TB、Volume は自分で最大 1TB まで増やせる | 公式 | 表示なし | [W1][W5] |
| Trial | 1回だけ $5 付与、30日間、RAM 1GB・共有 vCPU、1プロジェクト5サービスまで | 公式 | 表示なし | [W4] |

### 1.3 Fly.io（代替案 2）

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| shared-cpu-1x 256MB | $1.94/月（Ashburn） | 公式 | 表示なし | [F1] |
| shared-cpu-1x 512MB | **$3.19/月**。検索要約の文言は「512MB を2台で $3.19」とも読めて曖昧。ただし「256MB $1.94 + 追加 RAM 0.25GB × $5.00 = $3.19」と一致するので1台の価格と解釈した | 公式（解釈を含む） | 表示なし | [F1] |
| shared-cpu-1x 1GB | $5.70/月 | 公式 | 表示なし | [F1] |
| 追加 RAM | $5.00/GB/月 | 公式 | 表示なし | [F1] |
| Volume | $0.15/GB/月（確保した容量で課金。マシン停止中も課金） | 公式 | 表示なし | [F1] |
| 外向き転送 | $0.02/GB（北米・欧州）。その他の地域はもっと高い。受信は無料 | 公式 | 表示なし | [F1][F6] |
| 専用 IPv4 | $2/月 | 公式 | 表示なし | [F1] |
| 無料枠 | 無料プランはない。トライアルクレジットのみ（新規組織の Pay As You Go には無料枠がない） | 公式 | 表示なし | [F3][F4] |
| 課金方式 | 確保していた時間で日割り（秒課金） | 公式 | 表示なし | [F1][F4] |

---

## 2. マネージド PostgreSQL

### 2.1 Render Postgres

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| 課金方式 | インスタンスタイプ（計算資源）の固定月額 + ストレージ。秒単位で日割り | 公式 | 表示なし | [R9][R8] |
| ストレージ | **$0.30/GB/月**。初期容量は 1GB か 5GB の倍数。後から無停止で増やせる | 公式 | 表示なし | [R9][R8] |
| ストレージの削減 | できない（増やすだけ） | 第三者（要約の元ページは特定できず） | 2026 | [T2][T3] |
| Basic-256mb（`0.1c-256mb`） | **$6/月**、256MB RAM、接続数100。最小の有料プラン | 公式 | 表示なし | [R1][R8] |
| Basic-1gb | **$19/月**（0.5 CPU / 1GB。「0.5 CPU」の部分は公式で確認） | 第三者 | 2026-09-26 に確認と記載 | [T1][T2] / [R19] |
| Basic-4gb | $75/月（2 CPU / 4GB） | 第三者 | 2026 | [T3] |
| Pro-4gb | $55/月（1 CPU / 4GB） | 第三者 | 2026 | [T3] |
| Postgres の `1c-2g`（1 CPU / 2GB） | $40/月（Web 用 `1c-2g` の $25 とは別の価格） | 公式（掲載ページは特定できず） | 表示なし | [R5] |
| 古い記事の記載 | 「Pro データベースは $95/月から」（HA 発表時の記事） | 公式（古い情報の可能性が高い） | 表示なし | [R21] |
| Free | 256MB。ストレージ 1GB 固定。作成から30日で失効し、14日の猶予後に削除。PITR なし | 公式 | 表示なし | [R15][R23] |
| **PITR（有料 DB すべて）** | **復旧できる期間: Hobby 3日、Pro 以上 7日** | 公式 | 表示なし | [R10][R9] |
| 論理バックアップ | いつでも手動でエクスポートできる。日次の自動論理バックアップは PITR に置き換わり廃止。エクスポートの保持期間は未確認 | 公式（保持期間は未確認） | 表示なし | [R10] |
| 高可用性（HA） | Pro 以上または Accelerated のインスタンスで有効化できる。スタンバイにも同じインスタンスとストレージの料金がかかる（DB 費用がほぼ2倍） | 公式 | 表示なし | [R21] |
| リードレプリカ | Basic-1gb 以上かつストレージ 10GB 以上で、最大5台 | 公式 | 表示なし | [R19] |

### 2.2 Neon

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free | $0。100プロジェクト、1プロジェクトあたり 100 CU時間・ストレージ 0.5GB・Egress 5GB。5分操作がないと scale-to-zero（オフにできない）。最大 2CU | 公式 | 表示なし | [N1][N6] |
| Launch | **$0.106/CU時間**、ストレージ **$0.35/GB-月**。**最低料金なし**。scale-to-zero をオフにできる。オートスケールは最大 16CU | 公式 | 表示なし | [N1][N2][N10] |
| Scale | **$0.222/CU時間**（SLA、コンプライアンス、追加のセキュリティ） | 公式 | 表示なし | [N1] |
| CU の定義 | 1 CU ≈ 4GB RAM（と対応する CPU・ローカル SSD）。Neon のガイドでは「≈ 1 vCPU + 4GB」 | 公式 | 表示なし | [N7][N9] |
| PITR（history window） | Free は最大6時間（変更量 1GB まで・無料）。Launch は最大7日、Scale は最大30日で、いずれも **$0.20/GB-月**（課金はルートブランチのみ）。有料プランの初期設定は1日 | 公式 | 表示なし | [N3][N2] |
| 公開ネットワーク転送 | 有料プランは 1プロジェクトあたり月 **500GB を含む**（100GB から拡大）。超過は $0.10/GB | 公式 | 2026-06-01 施行 | [N4][N5] |
| オブジェクトストレージ | $0.023/GB-月 | 公式 | 表示なし | [N1] |
| 参考: Neon 公式ガイドの試算 | 小さな DB を24時間動かすと約 **$22/月**（190 CU時間 = $20.14 + 5GB = $1.75） | 公式（競合比較記事） | 2026-08-03 に数値検証と記載 | [N9] |

### 2.3 Supabase

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free | $0。DB 500MB（共有 CPU・500MB RAM）、Egress 5GB、ファイル 1GB、MAU 5万。**1週間アクティビティがないと一時停止**。アクティブな無料プロジェクトは2つまで | 公式 | 表示なし | [S1][S8] |
| Pro | **$25/月から**。コンピュートクレジット $10/月（Micro 1台分）を含む。ディスク 8GB/プロジェクト（超過 $0.125/GB）、Egress 250GB（超過 $0.09/GB）、キャッシュ Egress 250GB（超過 $0.03/GB）、ファイル 100GB（超過 $0.0213/GB）、日次バックアップ7日保持、ログ保持7日。支出上限（spend cap）は初期状態で ON | 公式 | 表示なし | [S1][S9] |
| Team | **$599/月から**。日次バックアップ14日保持、ログ保持28日、SOC2 / ISO27001、ダッシュボードの SSO など | 公式 | 表示なし | [S1] |
| コンピュート | Micro $10/月（1GB RAM・共有 CPU）、Small $15/月（2GB）、Medium $60/月（4GB）。時間課金 | 公式 | 表示なし | [S2][S3] |
| PITR アドオン | 保持7日ごとに **$100/月**（14日なら $200、28日なら $400）。Small 以上のコンピュートが必要 | 公式 | 表示なし | [S4][S5] |
| 拡張 btree_gist | **対応**（2026年のマイナーリリース告知にも btree_gist への言及あり） | 公式 | 表示なし | [S6][S7] |
| 拡張 pg_trgm | **対応** | 公式 | 表示なし | [S6] |

### 2.4 参考: その他の Postgres

| ベンダー / 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Railway Postgres | DB 専用の料金はない。コンテナの CPU / RAM + Volume $0.15/GB/月（テンプレート型なので、Render や Neon のようなフルマネージドではない） | 公式 | 表示なし | [W2][W5] |
| Railway のバックアップ | Volume バックアップは差分・コピーオンライト方式で、Volume と同じ $0.15/GB/月。Postgres の PITR に別料金はない（WAL とベースバックアップのバケット保管料 + egress だけ） | 公式 | 表示なし | [W5] |
| Fly Managed Postgres Basic | $38/月（Shared-2x CPU・1GB） | 公式 | 表示なし | [F5] |
| Fly Managed Postgres Starter | $72/月（Shared-2x CPU・2GB） | 公式 | 表示なし | [F5] |
| Fly Managed Postgres ストレージ | $0.28/GB（30日あたり、確保した容量）。全プランに HA・バックアップ・コネクションプーリングを含む | 公式 | 表示なし | [F5] |

### 2.5 拡張機能（btree_gist / pg_trgm）の対応状況

| ベンダー | btree_gist | pg_trgm | 区分 | 出典 |
|---|---|---|---|---|
| Render Postgres | **未確認**（対応拡張の一覧ページはあるが、検索要約では確認できなかった） | 対応 | 公式 / 未確認 | [R17][R18] |
| Neon | 対応（専用ドキュメントページあり） | 対応（専用ドキュメントページあり） | 公式 | [N8] |
| Supabase | 対応 | 対応 | 公式 | [S6][S7] |

---

## 3. トランザクションメール

### 3.1 Resend

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free | $0/月、3,000通/月、**1日100通まで**、ドメイン3つ | 公式 | 表示なし | [M1][M2][M6] |
| Pro | **$20/月、50,000通/月**、超過 **$0.90/1,000通**、ドメイン10、1日の上限なし | 公式 | 表示なし | [M1][M2] |
| Scale | **$90/月、100,000通/月**、超過 $0.90/1,000通（大容量のティアでは最低 $0.46/1,000通まで下がる）、ドメイン1,000 | 公式 | 表示なし | [M1][M2] |
| 超過分の課金方式 | 1,000通単位で自動課金（pay-as-you-go） | 公式 | 表示なし | [M3] |
| ドメイン追加 | Pro / Scale で100ドメイン追加 $20/月 | 公式 | 表示なし | [M2] |
| 専用 IP | $30/月（Scale プランで、1日3,000通を超えて送る場合） | 公式 | 表示なし | [M4] |
| データ保持 | メールとログのデータを30日保持（Free / Pro / Scale）※検索要約の記載。念のため再確認すること | 公式 | 表示なし | [M1] |

### 3.2 Postmark

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free Developer | 100通/月、超過送信はできない | 公式 | 表示なし | [P3][P4] |
| Basic | **$15/月で10,000通**、超過 **$1.80/1,000通** | 公式 | 表示なし | [P1][P2][P3] |
| Pro（10,000通） | $16.50/月（以前は $60.50） | 公式 | 表示なし | [P2] |
| Platform（10,000通） | $18/月（以前は $138） | 公式 | 表示なし | [P2] |
| 50,000通のプラン | $55/月、超過 $1.30/1,000通（要約からはどのティアか判別できない） | 公式（ティア不明） | 表示なし | [P1][P3] |
| Pro / Platform の超過単価 | 未確認 | 未確認 | — | — |

### 3.3 Amazon SES

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| アラカルトの送信単価 | **$0.10/1,000通**（無料枠を超えた分）。※出典は公式の「SES 無料枠」解説記事。2026年時点の料金ページには「送信は受信者単位で、段階ごとに単価が変わる（各段階の単価はその段階の通数だけに適用）」とあり、**段階表と第1段の単価は未確認** | 公式（段階表は未確認） | 表示なし | [A5][A1] |
| 添付ファイルのデータ | $0.12/GB | 公式 | 表示なし | [A1] |
| SES 独自の無料枠 | 初めて使ってから12か月・月3,000通の無料枠は、2026-07-21 以降の新規顧客には提供されない | 公式 | 2026-07-21 | [A1][A5] |
| AWS Free Tier クレジット | 2025-07-15 以降の新規 AWS 顧客に最大 $200 のクレジット（SES にも使える。アカウント作成から6か月の無料プラン） | 公式 | 2025-07-15 | [A1] |
| 料金プラン（Essentials / Pro / Enterprise） | 2026-07-21 に導入。**新規 SES アカウントは Essentials から始まる**。いつでもアラカルトに切り替え可能。2025-06-01 以降に送信実績のある既存顧客はアラカルトのまま。**Essentials の月額は未確認**（検索要約に「Essentials プランの顧客は月 $1,250（5ドメイン・専用 IP 12個・シードリストテスト25回込み）」という断片があったが、文脈不明で例示の可能性が高い） | 公式（月額は未確認） | 2026-07-21 | [A2][A3][A4] |
| サンドボックス | 本番アクセスが承認されるまでは、24時間で200通・1秒1通・検証済みの宛先にしか送れない。申請への最初の回答は通常24時間以内 | 公式 | 表示なし | [A6][A7] |
| 専用 IP の月額 | 未確認 | 未確認 | — | — |

### 3.4 参考: SendGrid

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free Trial | 60日間、1日100通 | 公式 | 表示なし | [G3] |
| Essentials 50k | $19.95/月、超過 $0.00133/通 | 公式（2022年時点。現在の価格は未確認） | 2022-07-01 改定の changelog | [G2][G1] |
| Essentials 100k | $34.95/月、超過 $0.0009/通 | 公式（2022年時点。現在の価格は未確認） | 2022-07-01 改定の changelog | [G2] |

---

## 4. オフサイトバックアップ用のオブジェクトストレージ

### 4.1 Cloudflare R2

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Standard ストレージ | **$0.015/GB-月** | 公式 | 表示なし | [C1] |
| Infrequent Access | $0.01/GB-月（最低30日分は課金、取り出し料金あり） | 公式 | 表示なし | [C1][C3] |
| Class A 操作（PutObject, ListObjects など） | $4.50/100万リクエスト（IA は $9.00） | 公式 | 表示なし | [C1] |
| Class B 操作（GetObject, HeadObject など） | $0.36/100万リクエスト（IA は $0.90） | 公式 | 表示なし | [C1] |
| 無料の操作 | DeleteObject、DeleteBucket、AbortMultipartUpload | 公式 | 表示なし | [C1] |
| **無料枠** | **毎月 10GB-月、Class A 100万回、Class B 1,000万回**（Standard のみ） | 公式 | 表示なし | [C1] |
| Egress | **無料**（S3 API、Workers API、r2.dev のいずれも） | 公式 | 表示なし | [C1][C2] |

### 4.2 Backblaze B2

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| ストレージ | **$6.95/TB/30日**（約 $0.00695/GB） | 公式 | 表示なし | [B1] |
| 無料枠 | 最初の 10GB | 公式 | 表示なし | [B2] |
| Egress | 月平均の保管量の3倍まで無料、それを超えると $0.01/GB。提携 CDN（Cloudflare など）経由なら無制限に無料 | 公式 | 表示なし | [B1] |
| 最低保管期間 | なし（検索要約による） | 公式 | 表示なし | [B2] |
| 価格の推移 | 2023-10-03 に $5 から $6/TB に値上げ。$6.95 になった日付は未確認 | 公式 | 2023-10-03 | [B3] |

### 4.3 参考: Railway Buckets

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| ストレージ | $0.015/GB-月。egress と S3 API 操作は無料。無料プランで月 10GB-月まで | 公式 | 表示なし | [W6] |

---

## 5. ログ・監視

### 5.1 Render の内蔵ログ

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| ログ保持期間 | **Hobby 7日、Pro 14日、Scale 30日**。上位プランに上げても、すでに消えたログは戻らない | 公式 | 表示なし | [R13] |
| ログストリーム | syslog（TLS）か HTTPS で Datadog、Better Stack、Papertrail などに転送できる。**プランごとに使えるかどうかは未確認** | 公式 / 未確認 | 表示なし | [R14] |
| HTTP リクエストログ | Pro 以上でログエクスプローラーに表示される（ログストリームにも転送される） | 公式 | 表示なし | [R13][R24] |
| メトリクスの転送 | Pro 以上なら OpenTelemetry 互換の送信先へ送れる | 公式 | 表示なし | [R24] |
| メトリクスの保持期間 | プランによって違う（具体的な日数は未確認） | 公式 / 未確認 | 表示なし | [R24] |

### 5.2 Better Stack（外部サービスの例）

| 項目 | 値 | 区分 | as-of | 出典 |
|---|---|---|---|---|
| Free | モニター10、ハートビート10、ステータスページ、3分間隔のチェック、ログ 3GB/月（3日保持）、メトリクス1,000万データポイント（30日保持） | 公式 | 表示なし | [BS1] |
| Responder ライセンス（オンコール・インシデント管理・稼働監視） | $34/月（月払い）/ $29/月（年払い） | 公式 | 表示なし | [BS1] |
| ログの従量課金 | 取り込み $0.10/GB（EU）・$0.15/GB（US）・$0.35/GB（シンガポール）、保持 $0.05/GB-月（EU）・$0.08（US）・$0.18（シンガポール） | 公式 | 表示なし | [BS1][BS2] |
| バンドル | Nano $45/月（US）、Micro $180/月など。いずれもログ30日保持 | 公式 | 表示なし | [BS1] |
| 返金保証 | 60日 | 公式 | 表示なし | [BS1] |

---

## 6. 商用利用・再販に関する制約

| ベンダー | 制約の内容 | 区分 | 出典 |
|---|---|---|---|
| Render | Free インスタンスは「本番アプリには使うべきでない」。Free の Web は15分でスピンダウン。Free Postgres は30日で失効（+14日の猶予） | 公式 | [R15][R23] |
| Render | Hobby はメンバー1名・サービス25・1プロジェクト2環境まで。**Hobby で商用利用してよいかどうかの明記は見つからなかった（未確認）** | 公式 / 未確認 | [R24] |
| Render | 規約で「本サービスの再販、賃貸、リース、その他第三者への提供」を禁止。これは Render そのものを又貸しする行為の禁止であり、Render の上で作った SaaS の提供は通常の使い方と読める（**解釈を含むので法務確認を推奨**）。暗号資産マイニングも禁止 | 公式 | [R20] |
| Railway | Hobby は「個人プロジェクト向け」。規約には「自社内部・個人・非商用の目的に限り、第三者のため・第三者の利益のためには使わない」との記載があり、**商用利用は Pro 以上**が必要 | 公式 + 公式(コミュニティ) | [W1][W8][W9] |
| Railway | Fair Use Policy: 「違法なことをすればプラットフォームから追放する」 | 公式 | [W10] |
| Fly.io | 無料プランはなく、トライアルクレジットのみ。無料枠があっても請求額に上限はかからない（超えれば請求される） | 公式 | [F3][F4] |
| Neon | Free は試作・プロトタイプ向けで「止まらずに動いてほしい本番ワークロードには避けるべき」。scale-to-zero をオフにできない。容量は 0.5GB/プロジェクト | 公式 | [N6][N2] |
| Supabase | Free は7日間アクティビティがないと一時停止。アクティブな無料プロジェクトは2つまで。有料プランは一時停止されない | 公式 | [S8][S10] |
| Resend | Free は1日100通まで。利用規約: オプトインした宛先にだけ送る、バウンス率は4%未満、コールドメールや購入・収集したリストへの送信は禁止 | 公式 | [M2][M5] |
| Postmark | Free Developer は月100通で、超過送信はできない | 公式 | [P3] |
| Amazon SES | 新規アカウントはサンドボックスから始まる（検証済みの宛先のみ、1日200通）。本番アクセスの申請が必要（トランザクション / マーケティングを選ぶ） | 公式 | [A6][A7] |
| Cloudflare R2 / Backblaze B2 / Better Stack | 商用利用や再販に関する特別な制約は見つからなかった（未確認） | 未確認 | — |
| 全般 | Render 以外（Railway の Hobby 条項を除く）では、「プラットフォーム上で作った SaaS を再販すること」についての条項を個別に確認できなかった（未確認） | 未確認 | — |

---

## 7. 月額コスト試算（**見積り**。前提はすべて仮定）

### 7.1 共通の前提（仮定）

- 構成: Web サービス1つ（Fastify API。React SPA も同じサービスから配信）+ ワーカー1つ + Postgres 1つ + メール + バックアップ保存先。
- バックアップ: 1日1回 `pg_dump`（圧縮後は DB サイズの **30%** と仮定）をワーカーから R2 にアップロード。**保持は日次30世代 + 月次12世代 = 42世代**（仮定）。
  - 別に Render Cron Job を使う場合、その料金（分単位課金）は未調査なので含めていない。
- **Render では、サービスから外へのアップロードも外向き帯域として課金される**（§1.1）。そのためバックアップのアップロード量を帯域に加えている。
- アプリ本体の外向き帯域（仮定）: Small は **3GB/月**、Medium は **20GB/月**。
- 監視: Render の内蔵ログ + Better Stack Free（$0）。有料にするなら Responder を +$29/月（年払い）。
- 為替・税金は含めない（円換算の例は §7.6）。

### 7.2 計算式（単価が変わったら差し替えて再計算する）

```
月額合計 = WS + WEB + WRK + PG + BW + MAIL + BK + MON

WS   = ワークスペース料金                    （Render Hobby = 0 / Pro = 25）
WEB  = Web インスタンス月額                   （Starter = 7 / Standard = 25）
WRK  = Worker インスタンス月額                （Starter = 7）
PG   = Postgres インスタンス月額 + ストレージ GB × 0.30
BW   = max(0, (アプリ帯域 GB + dump GB × アップロード回数/月) − 含まれる帯域 GB) × 0.15
       （含まれる帯域: Hobby = 5 / Pro = 25）
MAIL = 次のいずれか
       Resend Free = 0                        （月3,000通以下かつ1日100通以下）
       Resend Pro  = 20 + max(0, ceil((N − 50,000) / 1,000)) × 0.90
       Postmark Basic = 15 + max(0, (N − 10,000) / 1,000) × 1.80
       SES アラカルト  = N / 1,000 × 0.10     （+ 添付 GB × 0.12。Essentials プランの料金は未確認なので含めない）
BK   = max(0, dump GB × 世代数 − 10) × 0.015    （R2 Standard。B2 なら × 0.00695）
       ※Class A / B の操作は無料枠（100万回 / 1,000万回）に収まる前提で 0
MON  = 0（Better Stack Free）/ 29（Responder 年払い）/ 34（月払い）
```

### 7.3 Small（1店舗 / 3スタッフ / 1,000顧客 / 約600予約/月 / 約2,000通/月 / DB 1GB 未満）

仮定: DB 1GB（上限側で計算）、dump 0.3GB、アップロード30回/月、Postgres ストレージ 5GB、メール N = 2,000。

| 費目 | 案 A: Render Hobby（最小構成） | 案 B: Render Pro（業務利用として推奨） | 式 |
|---|---|---|---|
| WS | $0 | $25 | プラン料金 |
| WEB（Starter） | $7 | $7 | 公式価格 |
| WRK（Starter） | $7 | $7 | 公式価格 |
| PG（Basic-256mb + 5GB） | $7.50 | $7.50 | 6 + 5 × 0.30 |
| BW | $1.05 | $0 | 帯域 = 3 + 0.3 × 30 = 12GB → A: (12 − 5) × 0.15 / B: 12 ≤ 25 |
| MAIL | $0（Resend Free） | $20（Resend Pro） | §7.2 の MAIL の式 |
| BK（R2） | $0.04 | $0.04 | (0.3 × 42 − 10) × 0.015 = 2.6 × 0.015 |
| MON | $0 | $0 | Better Stack Free |
| **合計（見積り）** | **約 $22.59/月** | **約 $66.54/月** | |

- 案 A でメールを Resend Pro にすると **$42.59/月**。Resend Free は1日100通が上限なので、予約リマインダーが集中する日に止まる恐れがある。
- 案 B のメールだけを差し替えた場合: Postmark Basic なら **$61.54**、SES アラカルト（$0.20）なら **$46.74**、Resend Free なら **$46.54**。
- 案 B を推奨する理由: PITR 7日（Hobby は3日）、ログ14日（Hobby は7日）、メンバー無制限、帯域 25GB。
- B2 にした場合の BK は約 $0.02（差はほぼない）。

### 7.4 Medium（3店舗 / 20スタッフ / 20,000顧客 / 約6,000予約/月 / 約25,000通/月 / DB 2〜5GB）

仮定: DB 5GB（上限側で計算）、dump 1.5GB、アップロード30回/月、Postgres ストレージ 10GB（リードレプリカ条件の 10GB 以上も満たす）、メール N = 25,000。

| 費目 | Render Pro 構成 | 式 |
|---|---|---|
| WS | $25 | Pro |
| WEB（Standard 1c-2g） | $25 | 公式価格 |
| WRK（Starter） | $7 | 公式価格 |
| PG（Basic-1gb + 10GB） | $22.00 | 19（**第三者価格**）+ 10 × 0.30 |
| BW | $6.00 | 帯域 = 20 + 1.5 × 30 = 65GB → (65 − 25) × 0.15 |
| MAIL（Resend Pro） | $20 | 25,000 ≤ 50,000 なので超過なし |
| BK（R2） | $0.80 | (1.5 × 42 − 10) × 0.015 = 53 × 0.015 = 0.795 |
| MON | $0 | Better Stack Free |
| **合計（見積り）** | **約 $105.80/月** | |

感度分析（それぞれ上の合計に対する差し替え）:
- Postgres を `1c-2g` の $40（公式ドメインの記載だが掲載ページは特定できず）にする: **約 $126.80/月**
- Postgres を Pro-4gb の $55（第三者）+ HA にする: スタンバイ分で (55 + 3) × 2 = $116 → **約 $199.80/月**
- メールを Postmark Basic にする（15 + 15 × 1.80 = $42）: **約 $127.80/月**
- メールを SES アラカルトにする（$2.50）: **約 $88.30/月**（Essentials プランの料金が発生しないことが前提）
- Better Stack Responder（年払い $29）を足す: **約 $134.80/月**
- 帯域超過の大半はバックアップのアップロード（45GB/月）が原因。短期の復旧は Render の PITR（Pro は7日）に任せ、オフサイト dump を週1回にすれば、帯域 = 20 + 1.5 × 4.3 ≈ 26.5GB → BW ≈ $0.23 まで下がる（保管量も減る）。
- B2 にした場合の BK は約 $0.37。

### 7.5 代替構成の参考値（見積り）

| 構成 | 月額の見積り | 式と前提 |
|---|---|---|
| Medium の DB を **Neon Launch** にする | 約 $22.29（Render PG の $22.00 とほぼ同じ） | 190 CU時間 × 0.106 = 20.14（Neon 公式ガイドの小規模・24時間稼働例）+ 5GB × 0.35 = 1.75 + PITR 変更量 2GB（仮定）× 0.20 = 0.40。0.25CU を常時動かし続けるなら 182.5 × 0.106 ≈ $19.3 |
| DB を **Supabase Pro** にする | $25〜$30 | 25（Micro 込み）。Small に上げると +$5（15 − クレジット 10）。ディスクは 8GB まで込み。PITR が必要なら +$100/月（Small 以上が必要） |
| Small を **Railway Pro** で動かす（Web + Worker + Postgres） | $20（最低額）+ メール + BK | 使用量の例: Web 0.1vCPU / 0.25GB、Worker 0.05vCPU / 0.2GB、PG 0.1vCPU / 0.5GB + Volume 5GB、egress 12GB → CPU 0.25 × 20 = 5.00、RAM 0.95 × 10 = 9.50、Volume 0.75、egress 0.60 = 15.85 → max(20, 15.85) = **$20**。Postgres はテンプレート型なので運用責任が増える |
| Small を **Fly.io** で動かす（Web + Worker + Managed Postgres Basic） | 約 $47.42（専用 IPv4 を付けると +$2） | 3.19 × 2 + 38 + ストレージ 10GB（仮定）× 0.28 = 2.80 + egress 12GB × 0.02 = 0.24 |

### 7.6 円換算（例）

- 式: `円/月 = USD/月 × R（円/USD）`
- **R = 150円/USD と仮定した場合**（実勢レートではないので、使うときに差し替えること）:
  - Small 案 A: $22.59 → 約3,388円
  - Small 案 B: $66.54 → 約9,981円
  - Medium: $105.80 → 約15,869円
- 消費税（国外事業者のリバースチャージを含む）とカードの為替手数料は含めていない。

---

## 8. 未確認のまま残った項目

1. Render の Pro（`2c-4g`）以上の Web / Worker 月額（Pro Ultra $450 は第三者サイトのみ）
2. Render Postgres の Basic-1gb $19、Basic-4gb $75、Pro-4gb $55 は**第三者サイトでしか確認できていない**。Postgres `1c-2g` の $40 は公式ドメインの要約だが、掲載ページを特定できていない
3. Render Postgres の **btree_gist 対応**（pg_trgm は対応を確認）
4. Render のログストリームがどのプランで使えるか、メトリクスの保持日数、論理エクスポートの保持期間、カスタムドメインの基本数
5. Render Hobby で商用利用してよいかの明記
6. Amazon SES の 2026年版の段階別単価表（第1段が $0.10/1,000 のままか）、**Essentials プランの月額**、専用 IP の月額
7. Postmark の Pro / Platform の超過単価と、50,000通プラン（$55）のティア
8. SendGrid の現在の価格（手元にあるのは 2022年の changelog の値）
9. Backblaze B2 が $6.95/TB に改定された日付
10. Railway / Neon / Supabase / Resend / Postmark / R2 / B2 の規約で「SaaS の再販」がどう扱われるか（Render の条項と Railway Hobby の非商用条項以外）
11. 各ベンダーに東京リージョンがあるか、レイテンシはどうか（今回の調査範囲外）

---

## 9. 出典一覧

区分: [公式] = ベンダーの公式ドメイン、[公式(コミュニティ)] = 公式ドメイン上のコミュニティ、[第三者] = 第三者サイト。
すべて 2026-09-30 に WebSearch で得た結果（WebFetch は遮断されたため、本文は直接読めていない）。

### Render
- [R1] [公式] https://render.com/pricing
- [R2] [公式] https://render.com/changelog/updated-plans-for-render-workspaces
- [R3] [公式] https://render.com/blog/better-pricing-for-fast-growing-teams
- [R5] [公式] https://render.com/docs/compute-plans
- [R6] [公式] https://render.com/docs/compute-plans-update
- [R7] [公式] https://render.com/changelog/new-compute-plans-and-new-ids-for-existing-plans
- [R8] [公式] https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses
- [R9] [公式] https://render.com/docs/postgresql-refresh
- [R10] [公式] https://render.com/docs/postgresql-backups
- [R11] [公式] https://render.com/docs/outbound-bandwidth
- [R12] [公式] https://render.com/blog/new-bandwidth-pricing-on-render
- [R13] [公式] https://render.com/docs/logging
- [R14] [公式] https://render.com/docs/log-streams
- [R15] [公式] https://render.com/docs/free
- [R16] [公式] https://render.com/docs/background-workers
- [R17] [公式] https://render.com/docs/postgresql-extensions
- [R18] [公式] https://render.com/articles/postgres-features-that-matter-for-production-pitr-read-replicas-and-native-exten
- [R19] [公式] https://render.com/articles/render-vs-railway
- [R20] [公式] https://render.com/terms / https://render.com/acceptable-use
- [R21] [公式] https://render.com/docs/postgresql-high-availability / https://render.com/blog/high-availability-postgresql
- [R22] [公式] https://render.com/docs/workflows-limits
- [R23] [公式] https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90
- [R24] [公式] https://render.com/docs/new-workspace-plans / https://render.com/docs/professional-features
- [T1] [第三者] https://frontdeskreview.com/software/managed-postgres/render/ （「checked 2026-09-26」と記載）
- [T2] [第三者] https://kuberns.com/blogs/render-postgres-pricing-setup-limits/
- [T3] [第三者] https://bex.co/blog/2026/09/11/render-postgres-flexible-plans-vs-self-hosted-cost （Basic-4gb $75 / Pro-4gb $55。要約の元ページは完全には特定できず、同じ検索に getdeploying.com / srvrlss.io / checkthat.ai なども出ていた）
- [T5] [第三者] https://www.srvrlss.io/provider/render/ 、https://checkthat.ai/brands/render/pricing 、https://deploycloud.app/blog/render-pricing （Pro Ultra $450 と 2026-08-01 の自動移行。要約の元ページは特定できず）

### Railway
- [W1] [公式] https://docs.railway.com/pricing/plans
- [W2] [公式] https://docs.railway.com/pricing
- [W3] [公式] https://railway.com/pricing
- [W4] [公式] https://docs.railway.com/pricing/free-trial
- [W5] [公式] https://docs.railway.com/volumes/backups / https://docs.railway.com/reference/volumes
- [W6] [公式] https://docs.railway.com/storage-buckets/billing
- [W7] [公式] https://docs.railway.com/platform/compare-to-render
- [W8] [公式] https://railway.com/legal/terms
- [W9] [公式(コミュニティ)] https://station.railway.com/questions/terms-of-service-only-non-commercial-us-8302c41c / https://station.railway.com/questions/commercial-usage-using-hobby-plan-7fd8cf69
- [W10] [公式] https://railway.com/legal/fair-use

### Fly.io
- [F1] [公式] https://fly.io/docs/about/pricing/
- [F2] [公式] https://fly.io/pricing/
- [F3] [公式] https://fly.io/docs/about/cost-management/
- [F4] [公式] https://fly.io/docs/about/billing/
- [F5] [公式] https://fly.io/docs/mpg/ / https://fly.io/mpg/
- [F6] [公式] https://fly.io/blog/we-cut-bandwidth-prices-go-nuts/

### Neon
- [N1] [公式] https://neon.com/pricing
- [N2] [公式] https://neon.com/docs/introduction/plans
- [N3] [公式] https://neon.com/docs/introduction/history-window
- [N4] [公式] https://neon.com/blog/more-data-transfer-on-paid-plans
- [N5] [公式] https://neon.com/docs/introduction/network-transfer
- [N6] [公式] https://neon.com/faqs/free-plan-limits-and-quotas
- [N7] [公式] https://neon.com/docs/manage/computes
- [N8] [公式] https://neon.com/docs/extensions/btree_gist / https://neon.com/docs/extensions/pg_trgm
- [N9] [公式] https://neon.com/guides/neon-launch-plan-vs-supabase-pro-plan （2026-08-03 に数値検証と記載）
- [N10] [公式] https://neon.com/blog/new-usage-based-pricing

### Supabase
- [S1] [公式] https://supabase.com/pricing
- [S2] [公式] https://supabase.com/docs/guides/platform/compute-and-disk
- [S3] [公式] https://supabase.com/docs/guides/platform/manage-your-usage/compute
- [S4] [公式] https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- [S5] [公式] https://supabase.com/docs/guides/platform/backups
- [S6] [公式] https://supabase.com/docs/guides/database/extensions
- [S7] [公式] https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes
- [S8] [公式] https://supabase.com/docs/guides/platform/free-project-pausing
- [S9] [公式] https://supabase.com/docs/guides/platform/billing-on-supabase
- [S10] [公式] https://supabase.com/docs/guides/platform/billing-faq

### メール
- [M1] [公式] https://resend.com/pricing
- [M2] [公式] https://resend.com/docs/knowledge-base/account-quotas-and-limits
- [M3] [公式] https://resend.com/changelog/pay-as-you-go-pricing
- [M4] [公式] https://resend.com/features/dedicated-ips
- [M5] [公式] https://resend.com/legal/acceptable-use
- [M6] [公式] https://resend.com/changelog/three-domains-on-the-free-tier
- [P1] [公式] https://postmarkapp.com/pricing
- [P2] [公式] https://postmarkapp.com/blog/new-we-made-pro-and-platform-tier-features-accessible-to-lower-volume-email-plans
- [P3] [公式] https://postmarkapp.com/support/article/1107-how-does-monthly-pricing-work
- [P4] [公式] https://postmarkapp.com/support/article/1285-pricing-billing-faq
- [A1] [公式] https://aws.amazon.com/ses/pricing/
- [A2] [公式] https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-ses-pricing-plans/
- [A3] [公式] https://aws.amazon.com/blogs/messaging-and-targeting/introducing-amazon-simple-email-service-ses-pricing-plans/
- [A4] [公式] https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html
- [A5] [公式] https://aws.amazon.com/blogs/messaging-and-targeting/the-amazon-ses-free-tier/
- [A6] [公式] https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- [A7] [公式] https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html
- [G1] [公式] https://www.twilio.com/en-us/products/email-api/pricing
- [G2] [公式] https://www.twilio.com/en-us/changelog/essentials-40k-and-100k-pricing-and-packaging-have-changed
- [G3] [公式] https://support.sendgrid.com/hc/en-us/articles/35270136965403-Twilio-SendGrid-Trial-Account-Plan

### ストレージ・監視
- [C1] [公式] https://developers.cloudflare.com/r2/pricing/
- [C2] [公式] https://www.cloudflare.com/products/r2/
- [C3] [公式] https://developers.cloudflare.com/r2/buckets/storage-classes/
- [B1] [公式] https://www.backblaze.com/cloud-storage/pricing
- [B2] [公式] https://help.backblaze.com/hc/en-us/articles/360037814594-B2-Pricing
- [B3] [公式] https://www.backblaze.com/blog/2023-product-announcement/
- [BS1] [公式] https://betterstack.com/pricing
- [BS2] [公式] https://betterstack.com/log-management
