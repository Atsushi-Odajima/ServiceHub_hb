# RBAC (ロール/権限/拠点スコープ)

定義の正本: `src/shared/permissions.ts`(サーバー/クライアント共通)。UI の表示制御は補助で、**判定は常にサーバー側**(`requirePermission` + データ取得時の拠点/担当フィルタ)。

## 1. 構造
- ユーザー(users: ログインID) × 組織(organizations) = メンバーシップ(memberships: role, status, all_locations, staff_id)。
- 拠点スコープ: `owner` は常に全拠点。その他は `membership_locations`(または `all_locations = true`)。
- 担当スコープ(`.own` 権限): `memberships.staff_id` と一致する予約/顧客のみ。
- 将来拡張: 権限は文字列(`booking.create.all` 等)で、ロール→権限集合の対応表を差し替えれば組織別カスタムロールに拡張できる(判定関数は `can()` に一本化)。

## 2. ロール概要

| ロール | できること | できないこと |
|---|---|---|
| Owner | 全設定・全拠点・分析・スタッフ・権限・CSV取込・バックアップ・顧客匿名化 | — |
| Manager | 許可拠点の予約/顧客/シフト/受付/回数券/利用プラン/待機/KPI/監査/通知履歴、強制予約、顧客統合 | 組織設定、拠点の作成/設定変更、サービス定義、スタッフ/権限管理、CSV取込、バックアップ、顧客匿名化 |
| Staff | 自分の予約・自分の顧客・実施記録・次回予約・自分のシフト・回数券/プラン消化 | 他スタッフの予約/顧客、KPI、受付モード、設定、監査 |
| Reception | 許可拠点の予約受付/変更/キャンセル、来店処理、顧客検索/登録、回数券付与/消化、プラン契約、待機 | 機密メモ、実施記録の内部メモ、KPI/経営分析、強制予約、設定、監査 |

## 3. 権限マトリクス(抜粋。完全版はコード)

| 権限 | Owner | Manager | Staff | Reception |
|---|:-:|:-:|:-:|:-:|
| org.manage / member.manage / location.manage / service.manage / staff.manage | ○ | × | × | × |
| location.schedule.manage(臨時休業・ブロック) | ○ | ○(自拠点) | × | × |
| resource.manage / shift.manage | ○ | ○(自拠点) | × | × |
| booking.read / create / update / cancel / status | ○ | ○(自拠点) | own | ○(自拠点) |
| booking.force / booking.restore | ○ | ○ | × | × |
| booking.internal_note | ○ | ○ | ○ | × |
| reception.operate | ○ | ○ | × | ○ |
| customer.read / create / update | ○ | ○(拠点可視) | own | ○(拠点可視) |
| customer.note.confidential | ○ | ○ | ○(own) | **×** |
| customer.merge / archive / export | ○ | ○ | × | × |
| customer.anonymize | ○ | × | × | × |
| record.read(内部メモ含む) | ○ | ○ | ○(own) | **×** |
| record.write | ○ | ○ | own | × |
| record.void | ○ | ○ | × | × |
| pass.grant | ○ | ○ | × | ○ |
| pass.consume / plan.consume | ○ | ○ | own | ○ |
| pass.reverse / pass.adjust / plan.adjust | ○ | ○ | × | × |
| waitlist.manage | ○ | ○ | × | ○ |
| kpi.read / dashboard.operations | ○ | ○(自拠点) | **×** | **×** |
| audit.read / notification.read / retry | ○ | ○(自拠点) | × | × |
| csv.export.* | ○ | ○(自拠点) | × | × |
| csv.import / backup.manage | ○ | × | × | × |

## 4. データ単位の判定
- 予約: `booking.read.all` → 予約の拠点が自拠点に含まれること。`booking.read.own` のみ → `booking.staff_id = 自分の staff_id`。
- 顧客(DECISIONS D-017): Owner 全件。Manager/Reception は「自拠点の予約がある / 優先拠点が自拠点 / 予約も優先拠点もない」顧客。Staff は自分が担当した(する)予約がある顧客、または自分で登録した直後の顧客(登録直後に予約を作るため、作成者本人は24時間参照可)。
- 検索: すべての検索結果は上記の可視性フィルタを通す。権限外拠点の予約/顧客/シフトは返さない。
- 監査ログ(Manager): `location_id` が自拠点のもののみ。
- KPI(Manager): 自拠点のみで集計。組織横断の値は返さない。

## 5. 反映タイミング・セッション
- ロール/拠点変更は**即時**反映(リクエスト毎にDBから読み直す。権限キャッシュなし)。
- メンバー無効化・スタッフアーカイブ(ログイン紐付けあり)時は、そのメンバーの全セッションを即時失効。無効メンバーのセッションはミドルウェアでも拒否(二重防御)。
- ロール変更時もそのメンバーの他セッションを失効(次回ログインで新ロール)。自分自身の現在セッションは維持。
- Owner は最低1名必要(最後の Owner の降格/無効化は拒否)。

## 6. テスト
- `tests/integration/rbac.test.ts`: 全ロール × 代表API の許可/拒否表。
- 必須: Staff で Owner 設定 API 拒否(#8)、Reception で KPI/機密メモ API 拒否(#9)、権限外拠点の検索結果なし、他組織IDを指定しても 404。
