-- Cash-TID snapshot — run in Supabase SQL editor (also in supabase/migrations).
--
-- Ledger of which business date each cash tracking ID belongs to, per station. A TID is
-- anchored to the first date it is seen on (Cash In Associate on a reconciliation view of
-- that date, or the 23:00 IST nightly capture) and never re-dated. When yesterday's cash
-- is handed to the station this morning its ageing lastUpdatedTime moves to today; the
-- anchor keeps it on yesterday and out of today's expected cash. Rows are kept until
-- retention (not deleted when the cash is resolved) so past dates can be re-opened.

create table if not exists cod_cash_tid_snapshots (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  tracking_id text not null,
  business_date date not null,
  captured_state text,
  expected_amount numeric(12, 2) not null default 0,
  driver_id text,
  first_captured_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_code, tracking_id)
);

-- One row per tracking ID per station; inserts are insert-if-absent (see anchorTids), so
-- business_date from the first sighting — the true collection day — is preserved.

create index if not exists cod_cash_tid_snapshots_station_idx
  on cod_cash_tid_snapshots (station_code);

create index if not exists cod_cash_tid_snapshots_business_date_idx
  on cod_cash_tid_snapshots (business_date desc);

create index if not exists cod_cash_tid_snapshots_first_captured_idx
  on cod_cash_tid_snapshots (first_captured_at);

alter table cod_cash_tid_snapshots enable row level security;
