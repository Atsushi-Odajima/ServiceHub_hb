-- ServiceHub initial schema
-- 方針: 共有DB/共有スキーマ + organization_id 列 + Row Level Security(FORCE) + 複合外部キー
-- すべての時刻は timestamptz(UTC保存)。拠点ローカル時刻は time 型 + 拠点timezoneで解釈する。

-- btree_gist: 排他制約(スタッフ時間重複禁止)に使用。PG13以降は trusted extension のため非superuserでも作成可。
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 注意(RLS下の索引利用): RLSが有効なテーブルでは leakproof でない演算子(LIKE, &&, @> 等)を
-- 索引条件に使えない。範囲重複は「a_start < b_end AND a_end > b_start」、検索は正規化列の
-- 前方一致(>=, <)で書くこと。DEVELOPMENT.md 参照。

-- ---------------------------------------------------------------------------
-- 共通関数
-- ---------------------------------------------------------------------------

-- UUIDv7 (時系列順で索引の局所性が高い)
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
END $$;

-- 現在のテナント(トランザクション内で set_config('app.org_id', ..., true) される)
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- システム処理(ログイン照合・ジョブ・移行・バックアップ)専用モード
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- 追記専用テーブル(台帳・監査)の更新/削除禁止。組織削除/置換復元時のみ app.allow_ledger_purge=on で削除可。
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_ledger_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- ---------------------------------------------------------------------------
-- 組織・ユーザー・所属
-- ---------------------------------------------------------------------------

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_sample boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  public_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  address text,
  phone text,
  email text,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_public boolean NOT NULL DEFAULT true,
  booking_page jsonb NOT NULL DEFAULT '{}'::jsonb,
  slot_interval_min int NOT NULL DEFAULT 30 CHECK (slot_interval_min IN (5, 10, 15, 20, 30, 60)),
  min_notice_min int NOT NULL DEFAULT 60 CHECK (min_notice_min BETWEEN 0 AND 43200),
  max_advance_days int NOT NULL DEFAULT 60 CHECK (max_advance_days BETWEEN 1 AND 366),
  max_concurrent_sessions int CHECK (max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0),
  cancel_deadline_hours int NOT NULL DEFAULT 24 CHECK (cancel_deadline_hours BETWEEN 0 AND 720),
  allow_customer_cancel boolean NOT NULL DEFAULT true,
  allow_customer_reschedule boolean NOT NULL DEFAULT true,
  allow_public_waitlist boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  internal_name text,
  email text,
  phone text,
  public_profile text,
  accepts_bookings boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  color text,
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'reception')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  all_locations boolean NOT NULL DEFAULT false,
  staff_id uuid,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, staff_id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id)
);

CREATE TABLE membership_locations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  location_id uuid NOT NULL,
  PRIMARY KEY (membership_id, location_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id uuid REFERENCES memberships(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  remember boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX auth_sessions_membership ON auth_sessions (membership_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  email_normalized text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'reception')),
  all_locations boolean NOT NULL DEFAULT false,
  location_ids uuid[] NOT NULL DEFAULT '{}',
  staff_id uuid,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id)
);
CREATE INDEX invitations_org ON invitations (organization_id, created_at DESC);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 拠点の営業時間・例外・ブロック
-- ---------------------------------------------------------------------------

CREATE TABLE location_hours (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO 1=月 ... 7=日
  open_time time NOT NULL,
  close_time time NOT NULL,
  CHECK (close_time > open_time),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX location_hours_loc ON location_hours (organization_id, location_id, weekday);

CREATE TABLE location_exceptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('closed', 'special_hours')),
  open_time time,
  close_time time,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'closed' AND open_time IS NULL AND close_time IS NULL)
      OR (kind = 'special_hours' AND open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX location_exceptions_loc ON location_exceptions (organization_id, location_id, date);

CREATE TABLE location_blocks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  note text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX location_blocks_loc ON location_blocks (organization_id, location_id, starts_at);

CREATE TABLE staff_locations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  PRIMARY KEY (staff_id, location_id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX staff_locations_loc ON staff_locations (organization_id, location_id);

-- ---------------------------------------------------------------------------
-- リソース
-- ---------------------------------------------------------------------------

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category text NOT NULL DEFAULT 'room',
  capacity int NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'archived')),
  note text,
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id)
);
CREATE INDEX resources_loc ON resources (organization_id, location_id);

CREATE TABLE resource_hours (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  CHECK (end_time > start_time),
  FOREIGN KEY (organization_id, resource_id) REFERENCES resources (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX resource_hours_res ON resource_hours (organization_id, resource_id);

CREATE TABLE resource_blocks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  kind text NOT NULL DEFAULT 'maintenance' CHECK (kind IN ('maintenance', 'stopped', 'other')),
  note text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, resource_id) REFERENCES resources (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX resource_blocks_res ON resource_blocks (organization_id, resource_id, starts_at);

-- ---------------------------------------------------------------------------
-- サービス
-- ---------------------------------------------------------------------------

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text,
  category text,
  duration_min int NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  buffer_before_min int NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
  buffer_after_min int NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
  price_label text,
  capacity int NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),
  max_party_size int NOT NULL DEFAULT 1 CHECK (max_party_size BETWEEN 1 AND 500),
  requires_staff boolean NOT NULL DEFAULT true,
  is_bookable boolean NOT NULL DEFAULT true,
  is_public boolean NOT NULL DEFAULT true,
  pass_eligible boolean NOT NULL DEFAULT true,
  plan_eligible boolean NOT NULL DEFAULT true,
  notice text,
  schedule_mode text NOT NULL DEFAULT 'flexible' CHECK (schedule_mode IN ('flexible', 'fixed')),
  slot_interval_min int CHECK (slot_interval_min IS NULL OR slot_interval_min IN (5, 10, 15, 20, 30, 60)),
  min_notice_min int CHECK (min_notice_min IS NULL OR min_notice_min BETWEEN 0 AND 43200),
  max_advance_days int CHECK (max_advance_days IS NULL OR max_advance_days BETWEEN 1 AND 366),
  color text,
  sort_order int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_party_size <= capacity),
  UNIQUE (organization_id, id)
);

CREATE TABLE service_locations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  location_id uuid NOT NULL,
  PRIMARY KEY (service_id, location_id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX service_locations_loc ON service_locations (organization_id, location_id);

CREATE TABLE service_staff (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  PRIMARY KEY (service_id, staff_id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX service_staff_staff ON service_staff (organization_id, staff_id);

CREATE TABLE service_resource_requirements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  label text NOT NULL,
  quantity int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 50),
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX service_resource_requirements_svc ON service_resource_requirements (organization_id, service_id);

CREATE TABLE service_resource_options (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  PRIMARY KEY (requirement_id, resource_id),
  FOREIGN KEY (organization_id, requirement_id) REFERENCES service_resource_requirements (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, resource_id) REFERENCES resources (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE service_fixed_times (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  location_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  UNIQUE (service_id, location_id, weekday, start_time),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE service_questions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'confirm')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  help_text text,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX service_questions_svc ON service_questions (organization_id, service_id, sort_order);

-- ---------------------------------------------------------------------------
-- シフト
-- ---------------------------------------------------------------------------

CREATE TABLE shift_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  shift_type text NOT NULL CHECK (shift_type IN ('work', 'break')),
  start_time time NOT NULL,
  end_time time NOT NULL,
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX shift_templates_staff ON shift_templates (organization_id, staff_id);

CREATE TABLE staff_shifts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL,
  location_id uuid,
  shift_type text NOT NULL CHECK (shift_type IN ('work', 'break', 'vacation', 'training', 'other_work', 'block')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('template', 'manual', 'import', 'restore')),
  note text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (shift_type <> 'work' OR location_id IS NOT NULL),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id) ON DELETE CASCADE,
  -- 同一スタッフの勤務は拠点をまたいでも重複不可(同時に2拠点で勤務できない)
  CONSTRAINT staff_shifts_no_work_overlap EXCLUDE USING gist (
    organization_id WITH =, staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (shift_type = 'work')
);
CREATE INDEX staff_shifts_staff_time ON staff_shifts (organization_id, staff_id, starts_at);
CREATE INDEX staff_shifts_loc_time ON staff_shifts (organization_id, location_id, starts_at);

-- ---------------------------------------------------------------------------
-- 顧客
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  name_kana text,
  email text,
  email_normalized text COLLATE "C",
  phone text,
  phone_normalized text COLLATE "C",
  tags text[] NOT NULL DEFAULT '{}',
  memo text,
  preferred_location_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged', 'anonymized')),
  merged_into_id uuid,
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('public', 'staff', 'import', 'restore')),
  created_by_membership_id uuid,
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 検索用正規化キー(NFKC・小文字・空白除去・カタカナ→ひらがな)はアプリで計算して保存する
  name_norm text COLLATE "C" NOT NULL DEFAULT '',
  kana_norm text COLLATE "C",
  phone_reversed text COLLATE "C" GENERATED ALWAYS AS (reverse(phone_normalized)) STORED,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, preferred_location_id) REFERENCES locations (organization_id, id),
  FOREIGN KEY (organization_id, merged_into_id) REFERENCES customers (organization_id, id)
);
CREATE INDEX customers_name_norm ON customers (organization_id, name_norm);
CREATE INDEX customers_kana_norm ON customers (organization_id, kana_norm);
CREATE INDEX customers_email ON customers (organization_id, email_normalized);
CREATE INDEX customers_phone ON customers (organization_id, phone_normalized);
CREATE INDEX customers_phone_rev ON customers (organization_id, phone_reversed);
CREATE INDEX customers_last_visit ON customers (organization_id, last_visit_at DESC NULLS LAST);
CREATE INDEX customers_created ON customers (organization_id, created_at DESC);

CREATE TABLE customer_notes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  visibility text NOT NULL DEFAULT 'general' CHECK (visibility IN ('general', 'confidential')),
  author_membership_id uuid,
  author_label text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
);
CREATE INDEX customer_notes_customer ON customer_notes (organization_id, customer_id, created_at DESC);

CREATE TABLE customer_merges (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  survivor_id uuid NOT NULL,
  merged_id uuid NOT NULL,
  moved_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  actor_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, survivor_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, merged_id) REFERENCES customers (organization_id, id)
);

-- ---------------------------------------------------------------------------
-- 占有(スタッフ/リソースの時間確保) と 予約
-- 1:1サービスは予約1件=占有1件。定員制サービスは同一(拠点,サービス,スタッフ,開始)の占有に複数予約が相乗りする。
-- ---------------------------------------------------------------------------

CREATE TABLE occupancies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  block_starts_at timestamptz NOT NULL,
  block_ends_at timestamptz NOT NULL,
  capacity int NOT NULL CHECK (capacity >= 1),
  seats_taken int NOT NULL CHECK (seats_taken >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (seats_taken <= capacity),
  CHECK (ends_at > starts_at AND block_starts_at <= starts_at AND block_ends_at >= ends_at),
  CHECK ((status = 'active') = (seats_taken > 0)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id),
  -- 最終防衛線: 同一スタッフの有効な占有は(拠点をまたいでも)時間重複できない
  CONSTRAINT occupancies_no_staff_overlap EXCLUDE USING gist (
    organization_id WITH =, staff_id WITH =, tstzrange(block_starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (status = 'active' AND staff_id IS NOT NULL)
);
CREATE INDEX occupancies_loc_time ON occupancies (organization_id, location_id, starts_at) WHERE status = 'active';
CREATE INDEX occupancies_staff_time ON occupancies (organization_id, staff_id, block_starts_at) WHERE status = 'active';

CREATE TABLE occupancy_resources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  occupancy_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  requirement_id uuid,
  units int NOT NULL CHECK (units >= 1),
  block_starts_at timestamptz NOT NULL,
  block_ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (block_ends_at > block_starts_at),
  FOREIGN KEY (organization_id, occupancy_id) REFERENCES occupancies (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, resource_id) REFERENCES resources (organization_id, id)
);
CREATE INDEX occupancy_resources_res_time ON occupancy_resources (organization_id, resource_id, block_starts_at) WHERE active;
CREATE INDEX occupancy_resources_occ ON occupancy_resources (occupancy_id);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid,
  date_from date NOT NULL,
  date_to date NOT NULL,
  time_from time,
  time_to time,
  party_size int NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'booked', 'expired', 'canceled')),
  note text,
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('public', 'staff', 'restore')),
  notified_at timestamptz,
  booked_booking_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK (time_from IS NULL OR time_to IS NULL OR time_to > time_from),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id)
);
CREATE INDEX waitlist_entries_match ON waitlist_entries (organization_id, location_id, service_id, status, date_from);
CREATE INDEX waitlist_entries_customer ON waitlist_entries (organization_id, customer_id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  location_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid,
  occupancy_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  party_size int NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  status text NOT NULL CHECK (status IN ('confirmed', 'arrived', 'in_service', 'completed', 'canceled_customer', 'canceled_business', 'no_show')),
  channel text NOT NULL CHECK (channel IN ('public', 'staff', 'reception', 'waitlist', 'import', 'restore')),
  staff_selection text NOT NULL DEFAULT 'specified' CHECK (staff_selection IN ('specified', 'auto', 'none')),
  service_snapshot jsonb NOT NULL,
  location_snapshot jsonb NOT NULL,
  staff_snapshot jsonb,
  contact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_request text,
  internal_note text,
  idempotency_key text,
  manage_token_hash text,
  manage_token_expires_at timestamptz,
  previous_booking_id uuid,
  waitlist_entry_id uuid,
  forced boolean NOT NULL DEFAULT false,
  force_reason text,
  canceled_at timestamptz,
  cancel_reason text,
  cancel_late boolean,
  arrived_at timestamptz,
  service_started_at timestamptz,
  completed_at timestamptz,
  no_show_at timestamptz,
  consumption_kind text CHECK (consumption_kind IN ('pass', 'plan')),
  consumption_entry_id uuid,
  consumption_review text CHECK (consumption_review IN ('pending', 'consumed', 'waived')),
  version int NOT NULL DEFAULT 1,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((consumption_kind IS NULL) = (consumption_entry_id IS NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id),
  FOREIGN KEY (organization_id, occupancy_id) REFERENCES occupancies (organization_id, id),
  FOREIGN KEY (organization_id, previous_booking_id) REFERENCES bookings (organization_id, id),
  FOREIGN KEY (organization_id, waitlist_entry_id) REFERENCES waitlist_entries (organization_id, id)
);
CREATE UNIQUE INDEX bookings_manage_token ON bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL;
CREATE INDEX bookings_loc_start ON bookings (organization_id, location_id, starts_at);
CREATE INDEX bookings_customer_start ON bookings (organization_id, customer_id, starts_at DESC);
CREATE INDEX bookings_staff_start ON bookings (organization_id, staff_id, starts_at);
CREATE INDEX bookings_occupancy ON bookings (occupancy_id);
CREATE INDEX bookings_start ON bookings (organization_id, starts_at);
CREATE INDEX bookings_review ON bookings (organization_id, consumption_review) WHERE consumption_review = 'pending';

ALTER TABLE waitlist_entries
  ADD FOREIGN KEY (organization_id, booked_booking_id) REFERENCES bookings (organization_id, id);

CREATE TABLE booking_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'customer', 'system')),
  actor_membership_id uuid,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
);
CREATE INDEX booking_events_booking ON booking_events (organization_id, booking_id, created_at);
CREATE INDEX booking_events_customer ON booking_events (organization_id, customer_id, created_at DESC);

CREATE TABLE booking_answers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  question_id uuid,
  question_snapshot jsonb NOT NULL,
  answer jsonb NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_answers_booking ON booking_answers (organization_id, booking_id);

CREATE TABLE service_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  location_id uuid NOT NULL,
  staff_id uuid,
  service_id uuid NOT NULL,
  service_snapshot jsonb NOT NULL,
  performed_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_min int CHECK (duration_min IS NULL OR duration_min BETWEEN 0 AND 1440),
  internal_memo text,
  customer_memo text,
  next_recommended_on date,
  next_recommended_note text,
  next_booking_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_at timestamptz,
  voided_by_membership_id uuid,
  void_reason text,
  version int NOT NULL DEFAULT 1,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations (organization_id, id),
  FOREIGN KEY (organization_id, staff_id) REFERENCES staff (organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, next_booking_id) REFERENCES bookings (organization_id, id)
);
CREATE UNIQUE INDEX service_records_one_active ON service_records (booking_id) WHERE status = 'active';
CREATE INDEX service_records_customer ON service_records (organization_id, customer_id, performed_at DESC);
CREATE INDEX service_records_staff ON service_records (organization_id, staff_id, performed_at DESC);

CREATE TABLE waitlist_matches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  waitlist_entry_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid,
  starts_at timestamptz NOT NULL,
  source_booking_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'notified', 'booked', 'dismissed', 'stale')),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (waitlist_entry_id, starts_at, staff_id),
  FOREIGN KEY (organization_id, waitlist_entry_id) REFERENCES waitlist_entries (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX waitlist_matches_org ON waitlist_matches (organization_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 回数券 (購入済み/付与済み利用権の管理。オンライン決済は扱わない)
-- ---------------------------------------------------------------------------

CREATE TABLE pass_products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text,
  total_uses int NOT NULL CHECK (total_uses BETWEEN 1 AND 1000),
  validity_days int CHECK (validity_days IS NULL OR validity_days BETWEEN 1 AND 3660),
  all_services boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE pass_product_services (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pass_product_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (pass_product_id, service_id),
  FOREIGN KEY (organization_id, pass_product_id) REFERENCES pass_products (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE customer_passes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  pass_product_id uuid NOT NULL,
  product_snapshot jsonb NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  starts_on date NOT NULL,
  expires_on date,
  initial_uses int NOT NULL CHECK (initial_uses BETWEEN 1 AND 1000),
  remaining int NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'voided')),
  memo text,
  granted_by_membership_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR expires_on >= starts_on),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, pass_product_id) REFERENCES pass_products (organization_id, id)
);
CREATE INDEX customer_passes_customer ON customer_passes (organization_id, customer_id);
CREATE INDEX customer_passes_expiry ON customer_passes (organization_id, expires_on) WHERE status = 'active';

CREATE TABLE pass_ledger_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_pass_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('grant', 'use', 'use_reversal', 'manual_add', 'manual_subtract', 'expire', 'correction')),
  delta int NOT NULL CHECK (delta <> 0),
  balance_after int NOT NULL DEFAULT 0,
  booking_id uuid,
  service_record_id uuid,
  reverses_entry_id uuid,
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'system', 'operator')),
  actor_membership_id uuid,
  actor_label text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (entry_type IN ('grant', 'manual_add', 'use_reversal') AND delta > 0)
    OR (entry_type IN ('use', 'manual_subtract', 'expire') AND delta < 0)
    OR entry_type = 'correction'
  ),
  CHECK (entry_type <> 'use_reversal' OR reverses_entry_id IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, customer_pass_id) REFERENCES customer_passes (organization_id, id),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id),
  FOREIGN KEY (organization_id, service_record_id) REFERENCES service_records (organization_id, id),
  FOREIGN KEY (organization_id, reverses_entry_id) REFERENCES pass_ledger_entries (organization_id, id)
);
CREATE UNIQUE INDEX pass_ledger_one_reversal ON pass_ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX pass_ledger_one_grant ON pass_ledger_entries (customer_pass_id) WHERE entry_type = 'grant';
CREATE INDEX pass_ledger_pass ON pass_ledger_entries (organization_id, customer_pass_id, created_at);
CREATE INDEX pass_ledger_created ON pass_ledger_entries (organization_id, created_at DESC);
CREATE INDEX pass_ledger_booking ON pass_ledger_entries (organization_id, booking_id) WHERE booking_id IS NOT NULL;

-- 残数は台帳からのみ変化する(直接上書き禁止)
CREATE OR REPLACE FUNCTION customer_passes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.remaining <> 0 THEN
      RAISE EXCEPTION 'customer_passes.remaining must start at 0 and change only via pass_ledger_entries'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.remaining IS DISTINCT FROM OLD.remaining AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'customer_passes.remaining can only change via pass_ledger_entries'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_passes_guard BEFORE INSERT OR UPDATE ON customer_passes
  FOR EACH ROW EXECUTE FUNCTION customer_passes_guard();

CREATE OR REPLACE FUNCTION pass_ledger_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur int;
BEGIN
  SELECT remaining INTO cur FROM customer_passes
   WHERE id = NEW.customer_pass_id AND organization_id = NEW.organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer pass not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cur + NEW.delta < 0 THEN
    RAISE EXCEPTION 'PASS_BALANCE_NEGATIVE' USING ERRCODE = 'check_violation';
  END IF;
  NEW.balance_after := cur + NEW.delta;
  UPDATE customer_passes SET remaining = cur + NEW.delta, updated_at = now()
   WHERE id = NEW.customer_pass_id AND organization_id = NEW.organization_id;
  RETURN NEW;
END $$;
CREATE TRIGGER pass_ledger_apply BEFORE INSERT ON pass_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION pass_ledger_apply();
CREATE TRIGGER pass_ledger_immutable BEFORE UPDATE OR DELETE ON pass_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------------
-- 期間利用プラン (決済サブスクではなく利用権管理)
-- ---------------------------------------------------------------------------

CREATE TABLE plan_products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text,
  uses_per_period int NOT NULL CHECK (uses_per_period BETWEEN 1 AND 1000),
  period_months int NOT NULL DEFAULT 1 CHECK (period_months BETWEEN 1 AND 12),
  alignment text NOT NULL DEFAULT 'calendar' CHECK (alignment IN ('calendar', 'anniversary')),
  carryover_enabled boolean NOT NULL DEFAULT false,
  carryover_max int CHECK (carryover_max IS NULL OR carryover_max >= 0),
  all_services boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE plan_product_services (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_product_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (plan_product_id, service_id),
  FOREIGN KEY (organization_id, plan_product_id) REFERENCES plan_products (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, service_id) REFERENCES services (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE customer_plans (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  plan_product_id uuid NOT NULL,
  product_snapshot jsonb NOT NULL,
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'canceled')),
  memo text,
  created_by_membership_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id),
  FOREIGN KEY (organization_id, plan_product_id) REFERENCES plan_products (organization_id, id)
);
CREATE INDEX customer_plans_customer ON customer_plans (organization_id, customer_id);

CREATE TABLE customer_plan_periods (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_plan_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  remaining int NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (organization_id, id),
  UNIQUE (customer_plan_id, period_start),
  FOREIGN KEY (organization_id, customer_plan_id) REFERENCES customer_plans (organization_id, id),
  CONSTRAINT customer_plan_periods_no_overlap EXCLUDE USING gist (
    customer_plan_id WITH =, daterange(period_start, period_end, '[]') WITH &&
  )
);

CREATE TABLE plan_ledger_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_plan_id uuid NOT NULL,
  customer_plan_period_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('grant', 'use', 'use_reversal', 'manual_add', 'manual_subtract', 'expire', 'carryover_in', 'carryover_out', 'correction')),
  delta int NOT NULL CHECK (delta <> 0),
  balance_after int NOT NULL DEFAULT 0,
  booking_id uuid,
  service_record_id uuid,
  reverses_entry_id uuid,
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'system', 'operator')),
  actor_membership_id uuid,
  actor_label text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (entry_type IN ('grant', 'manual_add', 'use_reversal', 'carryover_in') AND delta > 0)
    OR (entry_type IN ('use', 'manual_subtract', 'expire', 'carryover_out') AND delta < 0)
    OR entry_type = 'correction'
  ),
  CHECK (entry_type <> 'use_reversal' OR reverses_entry_id IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, customer_plan_id) REFERENCES customer_plans (organization_id, id),
  FOREIGN KEY (organization_id, customer_plan_period_id) REFERENCES customer_plan_periods (organization_id, id),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id),
  FOREIGN KEY (organization_id, service_record_id) REFERENCES service_records (organization_id, id),
  FOREIGN KEY (organization_id, reverses_entry_id) REFERENCES plan_ledger_entries (organization_id, id)
);
CREATE UNIQUE INDEX plan_ledger_one_reversal ON plan_ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX plan_ledger_one_grant ON plan_ledger_entries (customer_plan_period_id) WHERE entry_type = 'grant';
CREATE INDEX plan_ledger_plan ON plan_ledger_entries (organization_id, customer_plan_id, created_at);
CREATE INDEX plan_ledger_created ON plan_ledger_entries (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION customer_plan_periods_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.remaining <> 0 THEN
      RAISE EXCEPTION 'customer_plan_periods.remaining must start at 0 and change only via plan_ledger_entries'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.remaining IS DISTINCT FROM OLD.remaining AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'customer_plan_periods.remaining can only change via plan_ledger_entries'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_plan_periods_guard BEFORE INSERT OR UPDATE ON customer_plan_periods
  FOR EACH ROW EXECUTE FUNCTION customer_plan_periods_guard();

CREATE OR REPLACE FUNCTION plan_ledger_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur int;
  plan_id uuid;
BEGIN
  SELECT remaining, customer_plan_id INTO cur, plan_id FROM customer_plan_periods
   WHERE id = NEW.customer_plan_period_id AND organization_id = NEW.organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan period not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF plan_id <> NEW.customer_plan_id THEN
    RAISE EXCEPTION 'plan period does not belong to plan' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF cur + NEW.delta < 0 THEN
    RAISE EXCEPTION 'PLAN_BALANCE_NEGATIVE' USING ERRCODE = 'check_violation';
  END IF;
  NEW.balance_after := cur + NEW.delta;
  UPDATE customer_plan_periods SET remaining = cur + NEW.delta, updated_at = now()
   WHERE id = NEW.customer_plan_period_id AND organization_id = NEW.organization_id;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_ledger_apply BEFORE INSERT ON plan_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION plan_ledger_apply();
CREATE TRIGGER plan_ledger_immutable BEFORE UPDATE OR DELETE ON plan_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------------
-- 通知(送信箱) / 監査 / CSV取込 / レート制限 / ジョブ実行記録
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient text,
  customer_id uuid,
  booking_id uuid,
  location_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'canceled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  subject text,
  provider_message_id text,
  sent_at timestamptz,
  skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX notifications_org_created ON notifications (organization_id, created_at DESC);
CREATE INDEX notifications_org_status ON notifications (organization_id, status, created_at DESC);
CREATE INDEX notifications_booking ON notifications (organization_id, booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('member', 'customer', 'system', 'operator')),
  actor_user_id uuid,
  actor_membership_id uuid,
  actor_label text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  location_id uuid,
  before jsonb,
  after jsonb,
  metadata jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_target ON audit_logs (organization_id, target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_action ON audit_logs (organization_id, action, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TABLE csv_imports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('customers', 'services', 'staff')),
  file_name text,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'canceled')),
  row_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE UNIQUE INDEX csv_imports_no_duplicate ON csv_imports (organization_id, kind, file_hash) WHERE status = 'committed';

CREATE TABLE rate_limit_buckets (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count int NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_buckets_expiry ON rate_limit_buckets (expires_at);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  detail jsonb
);
CREATE INDEX job_runs_name ON job_runs (job_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at トリガ
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated_at', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row Level Security (FORCE: テーブル所有者にも適用。superuser/BYPASSRLSロールでは無効になるため起動時に検査)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org() OR app_is_system()) '
      'WITH CHECK (organization_id = app_current_org() OR app_is_system())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = app_current_org() OR app_is_system())
  WITH CHECK (id = app_current_org() OR app_is_system());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_visibility ON users
  USING (
    app_is_system()
    OR id = app_current_user()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_current_org())
  )
  WITH CHECK (app_is_system() OR id = app_current_user());
