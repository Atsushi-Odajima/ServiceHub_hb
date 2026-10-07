-- ReserveFlow(#015)の機能を ServiceHub へ統合するための追加。
-- 1) 全サービス共通の事前質問(service_id IS NULL = 全サービスで表示)
-- 2) 予約管理リンクの再発行・無効化(nonce を上げると以前のリンクは使えなくなる)
-- 3) スタッフ登録予約の受付経路(電話・来店・DM・メール・その他)

ALTER TABLE service_questions ALTER COLUMN service_id DROP NOT NULL;
CREATE INDEX service_questions_common ON service_questions (organization_id, sort_order) WHERE service_id IS NULL;

ALTER TABLE bookings ADD COLUMN manage_token_nonce int NOT NULL DEFAULT 0 CHECK (manage_token_nonce >= 0);
ALTER TABLE bookings ADD COLUMN source_detail text CHECK (source_detail IN ('phone', 'walk_in', 'dm', 'email', 'other'));
