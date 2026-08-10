-- Cash In Associate daily snapshots — run in Supabase SQL editor.
-- Populated by the 06:00 IST cron; read APIs serve from these tables.

create table if not exists cia_snapshot_runs (
  id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  window_from date not null,
  window_to date not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'completed_with_errors', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stations_total integer not null default 0,
  stations_ok integer not null default 0,
  stations_failed integer not null default 0,
  next_station_index integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists cia_snapshot_runs_as_of_status_idx
  on cia_snapshot_runs (as_of_date desc, status);

create index if not exists cia_snapshot_runs_status_started_idx
  on cia_snapshot_runs (status, started_at desc);

alter table cia_snapshot_runs enable row level security;

create table if not exists cia_station_snapshots (
  run_id uuid not null references cia_snapshot_runs (id) on delete cascade,
  station_code text not null,
  account_key text not null default 'default',
  status text not null check (status in ('ok', 'error')),
  error text,
  fetched_at timestamptz not null default now(),
  summary jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  primary key (run_id, station_code)
);

create index if not exists cia_station_snapshots_run_status_idx
  on cia_station_snapshots (run_id, status);

create index if not exists cia_station_snapshots_station_idx
  on cia_station_snapshots (station_code, fetched_at desc);

alter table cia_station_snapshots enable row level security;
