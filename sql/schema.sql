-- Run this in the Supabase SQL editor before deploying.
-- Uses the service-role key from the Worker, so RLS can stay strict/off for
-- anon/authenticated roles — the Worker is the only writer.

create extension if not exists "pgcrypto";

create table if not exists validation_runs (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  business_date date not null,
  denomination_total numeric not null,
  status text not null check (status in ('passed', 'blocked')),
  blocked_at text check (blocked_at in ('pendingRecon', 'remittanceMatch', 'liability')),
  steps jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists validation_runs_station_date_idx
  on validation_runs (station_code, business_date);

create table if not exists validation_overrides (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references validation_runs (id) on delete set null,
  station_code text not null,
  business_date date not null,
  check_name text not null check (check_name in ('pendingRecon', 'remittanceMatch', 'liability')),
  reason text not null,
  overridden_by text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists validation_overrides_station_date_idx
  on validation_overrides (station_code, business_date);

create index if not exists validation_overrides_run_id_idx
  on validation_overrides (run_id);

-- Lock down direct table access; the Worker uses the service-role key which
-- bypasses RLS entirely, so these policies matter only if you ever expose
-- these tables to the anon/authenticated Supabase roles.
alter table validation_runs enable row level security;
alter table validation_overrides enable row level security;


-- Owner-uploaded Amazon station-portal session (cookie + x-api-usage-key).
-- One active session per portal account_key; uploading a new one supersedes
-- the previous active row for that account (audit trail kept).
create table if not exists amazon_sessions (
  id uuid primary key default gen_random_uuid(),
  cookie text not null,
  x_api_usage_key text not null,
  uploaded_by text not null,
  status text not null default 'active' check (status in ('active', 'expired')),
  account_key text not null default 'default',
  created_at timestamptz not null default now(),
  expired_at timestamptz
);

create index if not exists amazon_sessions_status_idx
  on amazon_sessions (status, created_at desc);

create index if not exists amazon_sessions_account_status_idx
  on amazon_sessions (account_key, status, created_at desc);

-- Owner-facing alerts (session expiry, etc.) the frontend dashboard polls.
create table if not exists owner_notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  message text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  meta jsonb,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists owner_notifications_ack_idx
  on owner_notifications (acknowledged, created_at desc);

-- Editable Amazon portal login credentials used by Puppeteer auto-login.
-- Multiple accounts keyed by account_key (`default` + dedicated stations).
-- Password is stored server-side only; admin GET never returns the raw password.
create table if not exists amazon_portal_credentials (
  account_key text primary key default 'default',
  email text not null,
  password text not null,
  default_station_code text not null default 'TIRC',
  updated_by text not null default 'josephmathew072@gmail.com',
  updated_at timestamptz not null default now(),
  -- Simple lock so concurrent validate/refresh calls don't launch two browsers
  -- for the same account.
  login_locked_until timestamptz,
  last_login_at timestamptz,
  last_login_error text
);

alter table amazon_portal_credentials enable row level security;