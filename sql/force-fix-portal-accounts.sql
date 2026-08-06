-- Force-fix amazon_portal_credentials / amazon_sessions for multi-account.
-- Run in Supabase SQL editor, then: npm run credentials:seed-stations
--
-- Safe if tables are empty / only hold sessions you can re-login.
-- If you need to keep an existing default email/password row, it is copied
-- into the new table as account_key = 'default'.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Backup any existing default credentials (legacy id=1 or already multi-account)
-- ---------------------------------------------------------------------------
create temporary table if not exists _portal_creds_backup (
  account_key text,
  email text,
  password text,
  default_station_code text,
  updated_by text,
  updated_at timestamptz,
  login_locked_until timestamptz,
  last_login_at timestamptz,
  last_login_error text
);

delete from _portal_creds_backup;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'amazon_portal_credentials'
  ) then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'amazon_portal_credentials'
        and column_name = 'account_key'
    ) then
      insert into _portal_creds_backup
      select
        account_key,
        email,
        password,
        default_station_code,
        updated_by,
        updated_at,
        login_locked_until,
        last_login_at,
        last_login_error
      from amazon_portal_credentials;
    elsif exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'amazon_portal_credentials'
        and column_name = 'id'
    ) then
      insert into _portal_creds_backup
      select
        'default',
        email,
        password,
        default_station_code,
        updated_by,
        updated_at,
        login_locked_until,
        last_login_at,
        last_login_error
      from amazon_portal_credentials;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Recreate credentials table with account_key PK
-- ---------------------------------------------------------------------------
drop table if exists amazon_portal_credentials cascade;

create table amazon_portal_credentials (
  account_key text primary key default 'default',
  email text not null,
  password text not null,
  default_station_code text not null default 'TIRC',
  updated_by text not null default 'josephmathew072@gmail.com',
  updated_at timestamptz not null default now(),
  login_locked_until timestamptz,
  last_login_at timestamptz,
  last_login_error text
);

alter table amazon_portal_credentials enable row level security;

insert into amazon_portal_credentials (
  account_key, email, password, default_station_code,
  updated_by, updated_at, login_locked_until, last_login_at, last_login_error
)
select distinct on (account_key)
  account_key, email, password, default_station_code,
  updated_by, updated_at, login_locked_until, last_login_at, last_login_error
from _portal_creds_backup
where account_key is not null and email is not null and password is not null
on conflict (account_key) do nothing;

-- ---------------------------------------------------------------------------
-- Sessions: ensure account_key exists (keep existing rows)
-- ---------------------------------------------------------------------------
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

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'amazon_sessions'
      and column_name = 'account_key'
  ) then
    alter table amazon_sessions
      add column account_key text not null default 'default';
  end if;
end $$;

create index if not exists amazon_sessions_status_idx
  on amazon_sessions (status, created_at desc);

create index if not exists amazon_sessions_account_status_idx
  on amazon_sessions (account_key, status, created_at desc);

-- Refresh PostgREST schema cache (fixes "schema cache" errors from the API)
notify pgrst, 'reload schema';

-- Verify
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'amazon_portal_credentials'
order by ordinal_position;
