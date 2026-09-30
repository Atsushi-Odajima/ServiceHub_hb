# データモデル (DATA_MODEL.md)

正本: `db/migrations/*.sql`。ここは構造と意図の要約。全テナントテーブルは `organization_id`(RLS対象)と `(organization_id, id)` UNIQUE を持ち、子は複合FKで参照する。ID は UUIDv7。

## 1. 関係図(主要)
```
organizations ─┬─ locations ─┬─ location_hours / location_exceptions / location_blocks
               │             ├─ resources ─┬─ resource_hours / resource_blocks
               │             │             └─ service_resource_options ─ service_resource_requirements ─ services
               │             ├─ staff_locations ─ staff ─ service_staff ─ services
               │             └─ service_locations ─ services ─ service_questions / service_fixed_times
               ├─ memberships(user×org, role) ─ membership_locations
               ├─ staff ─ shift_templates / staff_shifts
               ├─ customers ─ customer_notes / customer_merges
               ├─ occupancies ─ occupancy_resources            (スタッフ/リソースの時間確保)
               ├─ bookings(→occupancy, customer, service, staff, location) ─ booking_events / booking_answers
               ├─ service_records(→booking)                     (実施記録)
               ├─ pass_products ─ pass_product_services
               ├─ customer_passes ─ pass_ledger_entries(追記専用)
               ├─ plan_products ─ plan_product_services
               ├─ customer_plans ─ customer_plan_periods ─ plan_ledger_entries(追記専用)
               ├─ waitlist_entries ─ waitlist_matches
               ├─ notifications(送信箱)  audit_logs(追記専用)  csv_imports
users(グローバル) ─ auth_sessions / password_reset_tokens / invitations
システム: schema_migrations, rate_limit_buckets, job_runs
```

## 2. 主なテーブル

| テーブル | 要点 |
|---|---|
| organizations | slug(公開URL), is_sample, timezone, settings(jsonb: 移動時間/キャンセル規則/消化設定/通知設定/保存期間) |
| users / memberships | ログインIDはグローバル、所属は組織ごと(role/status/all_locations/staff_id) |
| locations | slug, timezone, 公開状態, 予約ページ設定, 刻み, 最短予約時間, 受付日数, 同時受付上限, キャンセル締切, 顧客キャンセル/変更可否 |
| location_hours | 曜日(ISO 1-7)ごとの営業区間(複数可)。行なし=定休日 |
| location_exceptions | 日付単位の臨時休業(closed) / 特別営業(special_hours)。ある日は通常営業時間を上書き |
| location_blocks | 時間帯単位の予約受付停止 |
| staff | 表示名/内部名/連絡先/公開プロフィール/受付可否/状態 |
| staff_shifts | work / break / vacation / training / other_work / block。**work は同一スタッフで重複不可(拠点をまたいでも)**(排他制約) |
| shift_templates | 週テンプレート(work/break)。生成時に staff_shifts を作る |
| resources | 拠点所属、同時利用数(capacity)、状態(active/stopped/archived)、利用可能時間(任意) |
| services | 所要時間、前後buffer、定員、1予約の最大人数、スタッフ要否、予約可否、公開、回数券/プラン対象、開催方式(flexible/fixed)、刻み/受付期間の上書き |
| service_resource_requirements/options | 必要リソース(ラベル, 数量)と候補リソース(いずれか) |
| occupancies | スタッフ/リソース確保の単位。seats_taken/capacity。**同一スタッフの有効占有は時間重複不可**(排他制約, 拠点をまたぐ) |
| bookings | 予約。スナップショット(サービス/拠点/スタッフ/連絡先)、状態、冪等キー、管理トークンハッシュ、キャンセル区分/締切後フラグ、消化記録、version(楽観ロック) |
| booking_events | 予約の状態遷移・変更履歴(タイムライン用) |
| booking_answers | 事前質問の回答 + 質問/選択肢スナップショット |
| service_records | 実施記録(1予約に有効1件)。内部メモ/顧客向けメモ/次回推奨/次回予約 |
| customers | 正規化キー(name_norm/kana_norm/email_normalized/phone_normalized/phone_reversed)で検索。status: active/archived/merged/anonymized |
| customer_passes / pass_ledger_entries | PASS_LEDGER.md |
| customer_plans / customer_plan_periods / plan_ledger_entries | PLAN_USAGE_RULES.md |
| waitlist_entries / waitlist_matches | 希望条件と空き候補(自動確定しない) |
| notifications | 送信箱。冪等キー UNIQUE。状態・試行・次回試行 |
| audit_logs | 追記専用。個人情報は値を残さない |

## 3. スナップショット方針
- 予約時: サービス(名称, 所要, buffer, 定員, 価格表示, カテゴリ, 注意事項)、拠点(名称, timezone)、スタッフ(表示名)、連絡先(氏名, メール, 電話)、事前質問(質問文, 種類, 選択肢)。
- 実施時: サービススナップショット。回数券付与時: 商品スナップショット。プラン契約時: 商品スナップショット。
- マスタ変更は過去の予約/実施/台帳の表示を変えない。

## 4. 状態遷移(予約)
```
confirmed ─┬─> arrived ─┬─> in_service ──> completed
           │            ├─> completed
           ├─> in_service
           ├─> completed
           ├─> canceled_customer / canceled_business
           └─> no_show
arrived ─> confirmed(来店取消) / canceled_* / no_show
in_service ─> arrived(対応開始取消)
completed ─(実施記録の取消)─> in_service
canceled_* / no_show ─(復元: 枠を再確保できた場合のみ, Owner/Manager)─> confirmed
```

## 5. 性能用索引(要点)
- 予約: (org, location, starts_at) / (org, customer, starts_at desc) / (org, staff, starts_at) / (org, starts_at)
- 占有: (org, staff, block_starts_at) WHERE active / (org, location, starts_at) WHERE active
- 顧客検索: (org, name_norm) / (org, kana_norm) / (org, email_normalized) / (org, phone_normalized) / (org, phone_reversed) … すべて COLLATE "C" で前方一致レンジ検索
- 通知: (next_attempt_at) WHERE pending/sending
