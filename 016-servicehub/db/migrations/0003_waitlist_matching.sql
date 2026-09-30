-- 待機リストの候補抽出(Phase 7)
-- 担当指定なし(staff_id IS NULL = 誰でも可)の候補も重複しないよう、一意性を式索引にする
ALTER TABLE waitlist_matches DROP CONSTRAINT waitlist_matches_waitlist_entry_id_starts_at_staff_id_key;
CREATE UNIQUE INDEX waitlist_matches_unique
  ON waitlist_matches (waitlist_entry_id, starts_at, (COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX waitlist_matches_entry ON waitlist_matches (organization_id, waitlist_entry_id, status);

-- 候補を最後に再計算した時刻(定期ジョブが古い順に再計算する)と取消理由
ALTER TABLE waitlist_entries ADD COLUMN matched_at timestamptz;
ALTER TABLE waitlist_entries ADD COLUMN cancel_reason text;
CREATE INDEX waitlist_entries_active ON waitlist_entries (organization_id, matched_at NULLS FIRST) WHERE status IN ('waiting', 'notified');
