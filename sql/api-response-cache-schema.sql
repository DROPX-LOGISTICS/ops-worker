-- Short-TTL response cache for executive / CIA read APIs.
-- Shared across Worker isolates so concurrent dashboard hits within ~60s
-- reuse one Amazon/Supabase compute.

create table if not exists api_response_cache (
  cache_key text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists api_response_cache_expires_idx
  on api_response_cache (expires_at);

alter table api_response_cache enable row level security;
