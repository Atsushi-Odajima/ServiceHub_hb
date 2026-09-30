-- バックアップ復元のための調整
-- 復元中(app.restoring = on)は updated_at を自動更新しない。
-- 復元は循環参照(予約⇔待機、統合済み顧客、次回予約の元予約)を「いったん NULL で投入 → 最後に更新」で
-- 解決するため、その更新で updated_at が復元時刻に変わらないようにする。通常の更新には影響しない。
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.restoring', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- 外部キーの参照側索引(親の行を削除するときの参照確認が全件走査にならないように)。
-- 置換復元・サンプル再作成・組織削除では親子をまとめて削除するため、件数が多い組織で必要になる。
CREATE INDEX IF NOT EXISTS bookings_previous ON bookings (previous_booking_id) WHERE previous_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_waitlist_entry ON bookings (waitlist_entry_id) WHERE waitlist_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_records_booking ON service_records (booking_id);
CREATE INDEX IF NOT EXISTS service_records_next_booking ON service_records (next_booking_id) WHERE next_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pass_ledger_record ON pass_ledger_entries (service_record_id) WHERE service_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plan_ledger_booking ON plan_ledger_entries (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plan_ledger_period ON plan_ledger_entries (customer_plan_period_id);
CREATE INDEX IF NOT EXISTS plan_ledger_record ON plan_ledger_entries (service_record_id) WHERE service_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS waitlist_entries_booked ON waitlist_entries (booked_booking_id) WHERE booked_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_merged_into ON customers (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_merges_survivor ON customer_merges (survivor_id);
CREATE INDEX IF NOT EXISTS customer_merges_merged ON customer_merges (merged_id);
