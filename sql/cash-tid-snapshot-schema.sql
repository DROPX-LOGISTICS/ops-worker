-- Cash-TID snapshot — run in Supabase SQL editor.
--
-- Nightly (11 PM IST) capture of tracking IDs still CASH_AT_STATION at each station.
-- Fixes: a store that hands cash to the station a day late moves that package's
-- lastUpdatedTime to the day it actually pays, so the ageing feed (which buckets by
-- lastUpdatedTime) silently reassigns the cash to the wrong business day. This table
-- anchors each tracking ID to the business date it was captured on; a resolve job then
-- re-checks each row by ID (batchGetPackageSummary) rather than by date, and deletes it
-- once the package has moved out of CASH_AT_STATION.

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

-- One row per tracking ID per station: a TID still open on night 2 is re-captured via
-- upsert (last_checked_at/captured_state refresh), but business_date/first_captured_at
-- from night 1 — the true delivery day — are preserved (see upsertOpenTids' onConflict).

create index if not exists cod_cash_tid_snapshots_station_idx
  on cod_cash_tid_snapshots (station_code);

create index if not exists cod_cash_tid_snapshots_business_date_idx
  on cod_cash_tid_snapshots (business_date desc);

create index if not exists cod_cash_tid_snapshots_first_captured_idx
  on cod_cash_tid_snapshots (first_captured_at);

alter table cod_cash_tid_snapshots enable row level security;
