-- Workforce portal (logistics.amazon.in) — run in Supabase SQL editor.
-- Separate from amazonlogistics.eu station-portal sessions.

create table if not exists workforce_sessions (
  id uuid primary key default gen_random_uuid(),
  cookie text not null,
  uploaded_by text not null,
  status text not null default 'active' check (status in ('active', 'expired')),
  account_key text not null default 'default',
  created_at timestamptz not null default now(),
  expired_at timestamptz
);

create index if not exists workforce_sessions_account_status_idx
  on workforce_sessions (account_key, status, created_at desc);

alter table workforce_sessions enable row level security;

-- Cached DSP associate roster (synced from fetchDSPAssociates).
create table if not exists workforce_associates (
  transporter_id text primary key,
  full_name text not null,
  provider_id text,
  roles text,
  qualifications text,
  operational_status text,
  personal_phone_number text,
  work_phone_number text,
  email_address text,
  driver_license_expiration_date text,
  photo_url text,
  synced_at timestamptz not null default now()
);

create index if not exists workforce_associates_status_idx
  on workforce_associates (operational_status);

create index if not exists workforce_associates_name_idx
  on workforce_associates (full_name);

alter table workforce_associates enable row level security;

-- Login lock / last-error for Puppeteer auto-login (env credentials).
create table if not exists workforce_login_state (
  account_key text primary key default 'default',
  login_locked_until timestamptz,
  last_login_at timestamptz,
  last_login_error text,
  updated_at timestamptz not null default now()
);

alter table workforce_login_state enable row level security;
