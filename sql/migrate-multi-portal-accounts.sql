-- Multi-account Amazon portal credentials + per-account sessions.
-- Safe to run on a fresh DB or an existing one (create / alter guards).
-- Run this in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Fresh install: create tables if missing (new multi-account shape)
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

create index if not exists amazon_sessions_status_idx
  on amazon_sessions (status, created_at desc);

create index if not exists amazon_sessions_account_status_idx
  on amazon_sessions (account_key, status, created_at desc);

create table if not exists amazon_portal_credentials (
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

-- ---------------------------------------------------------------------------
-- Existing DBs: migrate legacy singleton (id=1) → account_key
-- ---------------------------------------------------------------------------
do $$
begin
  -- Legacy column id existed on older installs.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'amazon_portal_credentials'
      and column_name = 'id'
  ) then
    alter table amazon_portal_credentials drop constraint if exists amazon_portal_credentials_id_check;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'amazon_portal_credentials'
        and column_name = 'account_key'
    ) then
      alter table amazon_portal_credentials add column account_key text;
    end if;

    update amazon_portal_credentials
    set account_key = 'default'
    where account_key is null;

    -- Drop old PK on id if present, then ensure account_key is unique/PK.
    begin
      alter table amazon_portal_credentials drop constraint if exists amazon_portal_credentials_pkey;
    exception when others then null;
    end;

    begin
      alter table amazon_portal_credentials alter column account_key set not null;
      alter table amazon_portal_credentials alter column account_key set default 'default';
    exception when others then null;
    end;

    begin
      alter table amazon_portal_credentials add primary key (account_key);
    exception when others then
      create unique index if not exists amazon_portal_credentials_account_key_uidx
        on amazon_portal_credentials (account_key);
    end;

    begin
      alter table amazon_portal_credentials alter column id drop not null;
    exception when others then null;
    end;
  end if;
end $$;

create unique index if not exists amazon_portal_credentials_account_key_uidx
  on amazon_portal_credentials (account_key);

-- Existing amazon_sessions without account_key
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'amazon_sessions'
      and column_name = 'account_key'
  ) then
    alter table amazon_sessions
      add column account_key text not null default 'default';
  end if;
end $$;

create index if not exists amazon_sessions_account_status_idx
  on amazon_sessions (account_key, status, created_at desc);
