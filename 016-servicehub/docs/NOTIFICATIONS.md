# 通知 (NOTIFICATIONS.md)

初版はメールのみ。SMS/LINE は Pro 版候補。

## 1. 種類

| type | 契機 | 宛先 | 冪等キー |
|---|---|---|---|
| booking_confirmed | 予約確定 | 顧客 | `booking_confirmed:{bookingId}` |
| booking_changed | 日時/担当の変更 | 顧客 | `booking_changed:{bookingId}:v{version}` |
| booking_canceled | キャンセル(顧客/事業者) | 顧客 | `booking_canceled:{bookingId}` |
| booking_reminder | 開始の N 時間前(拠点設定、既定24h) | 顧客 | `booking_reminder:{bookingId}:{startsAtISO}` |
| waitlist_available | 待機候補の通知(運営者操作) | 顧客 | `waitlist_available:{matchId}` |
| pass_expiring | 回数券期限 N 日前 | 顧客 | `pass_expiring:{passId}:{expiresOn}` |
| plan_expiring | プラン終了 N 日前 | 顧客 | `plan_expiring:{planId}:{endsOn}` |
| member_invitation | メンバー招待 | 招待先 | `member_invitation:{invitationId}` |
| password_reset | パスワード再設定 | 本人 | `password_reset:{tokenId}` |

- 顧客にメールアドレスがない場合は `skipped`(skip_reason=no_recipient)。
- 組織/拠点の通知設定で OFF の種類は enqueue しない。
- リマインダーは送信時に予約状態を再確認し、キャンセル済み/日時変更済みなら `skipped`。

## 2. 送信箱とワーカー
1. 業務トランザクション内で `INSERT ... ON CONFLICT (organization_id, idempotency_key) DO NOTHING`(同じ通知は二度作られない)。
2. ワーカー: `status IN (pending, sending[リース切れ]) AND next_attempt_at <= now()` を `FOR UPDATE SKIP LOCKED` で最大20件取得 → `sending` + `locked_until = now()+2分` → 送信 → `sent`(provider_message_id, sent_at)。
3. 失敗: attempts+1、`next_attempt_at = now() + 2^attempts 分`(最大60分)、`max_attempts`(既定5)到達で `failed`。管理画面から手動再送(Owner/Manager、監査ログ)。
4. スケジューラ(既定60秒毎): リマインダー・期限間近・回数券失効・プラン期間締め・待機期限・セッション/レート制限の掃除。すべて冪等キーで重複しない(再実行・複数インスタンス同時実行でも安全)。

## 3. 重複防止の限界
- enqueue は厳密に1回(UNIQUE)。送信は「少なくとも1回」: SMTP 送信成功後、`sent` 記録前にプロセスが落ちるとリース切れ後に再送され得る。Message-ID を `<notification-{id}@servicehub>` に固定し、受信側で重複判定できるようにしている。

## 4. 安全装置
- `EMAIL_PROVIDER=log`(既定): 外部送信せず、本文を通知履歴と標準出力に記録。
- `organizations.is_sample = true` の組織は常に実送信しない(skipped: sample_org)。
- `EMAIL_ALLOWLIST`: 設定時は許可ドメイン/アドレス以外を skipped(検証環境向け)。
- 本文に予約管理URL(トークン)を含むため、通知履歴画面では本文を表示せず件名・状態のみ表示。

## 5. 送信履歴
- 管理画面「通知履歴」: 種類・宛先(マスク表示 例 `ta***@example.com`)・状態・試行回数・最終エラー・日時。失敗の再送ボタン。
- ダッシュボードに「通知失敗」件数。

## 6. テスト
- 必須 #17: スケジューラ/通知ジョブを2回実行しても同一通知は1件。
- ワーカー並行実行で同じ通知を二重送信しない(SKIP LOCKED)。
- 失敗→再試行→最大回数で failed。
