# セキュリティ設計 (SECURITY.md)

最重要要件。実装箇所とテストを併記する。法的適合(個人情報保護法等)を保証するものではない。

## 1. テナント分離
- 全テナントテーブルに `organization_id`。RLS ENABLE + FORCE、ポリシー `organization_id = app_current_org() OR app_is_system()`。
- トランザクション毎に `set_config('app.org_id', <セッションの組織>, true)`。組織IDはセッションからのみ決定。
- 複合外部キー `(organization_id, id)` で他組織の行を参照できない。
- 他組織のIDを URL に指定しても 404(存在の有無を漏らさない)。
- 起動時に接続ロールが superuser/BYPASSRLS でないことを検査。
- テスト: `tests/integration/tenant-isolation.test.ts`。

## 2. 認証・セッション
- パスワード: scrypt(N=2^15,r=8,p=1)+ソルト。最小10文字。平文・ハッシュをログに出さない。
- ログイン失敗: 同一アカウント10回で15分ロック、IP単位のレート制限(DB バケット、複数インスタンス対応)。失敗時メッセージはアカウント存在を区別しない。
- セッション: 32byte 乱数トークン、DB には SHA-256 のみ。Cookie `sh_session` httpOnly / SameSite=Lax / Secure(HTTPS)/ Path=/。
  - 有効期限: 通常 アイドル12時間・最長7日。「ログイン状態を保持」(受付iPad等)アイドル7日・最長30日。
  - ログアウト・パスワード変更・メンバー無効化・ロール変更で失効。
- 無効化スタッフ: メンバーシップ無効化 or スタッフのアーカイブ時、紐付くメンバーの全セッションを即時削除。ミドルウェアでも `memberships.status='active'` を毎リクエスト確認。
- 招待/パスワード再設定トークン: 32byte 乱数、SHA-256 保存、1回限り、7日/1時間で失効。

## 3. CSRF / XSS / ヘッダー
- 状態変更リクエスト(POST/PUT/PATCH/DELETE)は `X-CSRF-Token`(セッションごとの同期トークン)必須 + `Origin`/`Referer` が APP_BASE_URL と一致すること。
- 公開予約 API(ログイン不要)は Cookie 認証を使わないため CSRF 対象外。代わりにレート制限 + フォームトークン(HMAC 署名付き発行時刻)+ ハニーポット。
- React の自動エスケープ。`dangerouslySetInnerHTML` 不使用。メール本文はプレーンテキスト。
- helmet: CSP `default-src 'self'`(インラインスクリプト不可), `frame-ancestors 'none'`, HSTS(HTTPS時), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`。
- CSV 出力は数式インジェクション対策(`= + - @ タブ CR` で始まるセルに `'` を前置)。

## 4. 入力検証・SQL
- 全 API 入力は Zod スキーマで検証(型・長さ・列挙・UUID形式)。未知のキーは除去。
- SQL は常に `$n` パラメータ。動的なソート列等はホワイトリスト。
- リクエストボディ上限 1MB(CSV取込 5MB、バックアップ検証 50MB)。

## 5. 公開予約の保護
- IP 単位レート制限(既定 30回/分、予約確定は 10回/10分)、管理トークン照合 20回/分。
- フォームトークン: 空き検索時に発行、確定時に「発行から3秒以上・2時間以内」を検証(bot の即時送信を抑止)。ハニーポット項目。
- 任意: Cloudflare Turnstile(環境変数設定時のみ有効)。
- 予約管理トークン(URL): 32byte 乱数、ハッシュ保存、予約終了+30日で失効。予約番号だけでは操作できない。

## 6. 認可
- RBAC.md の通り、全 API で `requirePermission` + データ取得時の拠点/担当スコープ。
- 画面の非表示は補助。サーバー側で拒否することをテストで確認。

## 7. 監査ログ
- 対象: 予約作成/変更/キャンセル、強制予約、来店/対応中/完了/無断欠席、回数券付与/消化/戻し/調整/失効、利用プラン契約/変更/消化、スタッフ/メンバー/権限変更、シフト、拠点/サービス/組織設定、顧客作成/更新/統合/アーカイブ/匿名化、データ削除、CSV取込/出力、バックアップ、通知再送。
- 記録: actor(種別/ユーザー/メンバー/表示名)、日時、対象種別/ID、操作、拠点、最小限の before/after、request_id。
- 個人情報の最小化: 氏名・メール・電話・メモ・事前質問の回答は before/after に値を残さず `"[変更あり]"` とする。トークン・パスワードは記録しない。
- 監査ログは追記専用(UPDATE/DELETE 禁止トリガ)。

## 8. ログ
- pino。`authorization`, `cookie`, `set-cookie`, `password`, `token`, `email`, `phone` 等を redact。リクエストログは URL のクエリ文字列からトークンを除去。
- エラー応答にスタックトレースを出さない(本番)。

## 9. 秘密情報
- すべて環境変数(DATABASE_URL, SESSION_SECRET, SMTP_URL, TURNSTILE_SECRET_KEY, BACKUP_ENCRYPTION_KEY)。リポジトリに保存しない(`.env` は .gitignore)。
- 本番で `SESSION_SECRET` が既定値なら起動拒否。

## 10. プライバシー
- 顧客データのエクスポート(JSON)、アーカイブ(一覧から除外・予約不可)、匿名化(氏名→「匿名化済み顧客」、連絡先・メモ・回答・予約の連絡先スナップショットを消去)。
- 匿名化しても予約・台帳・実施記録・監査の件数と関係は保持(集計・残数の整合性を維持)。
- 保存期間: `organizations.settings.retention`(将来設定用の構造。初版は手動匿名化のみ)。

## 11. 既知の制限(販売前に人間確認)
- 実機ブラウザでの Cookie/PWA 挙動、本番ドメインでの HTTPS/HSTS、SMTP 事業者の SPF/DKIM/DMARC 設定、ペネトレーションテストは未実施。
