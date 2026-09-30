-- CLI(サンプル投入・運用作業)による操作を予約履歴に記録できるようにする
ALTER TABLE booking_events DROP CONSTRAINT booking_events_actor_type_check;
ALTER TABLE booking_events ADD CONSTRAINT booking_events_actor_type_check
  CHECK (actor_type IN ('member', 'customer', 'system', 'operator'));
