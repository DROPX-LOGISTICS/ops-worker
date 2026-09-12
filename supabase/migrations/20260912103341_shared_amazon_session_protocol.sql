-- Shared by cash-recon, EDD and report-auto. No credentials or historical
-- shipment observations are changed by this migration.
alter table public.amazon_portal_credentials
  add column if not exists login_lease_token uuid,
  add column if not exists login_protocol_version integer not null default 0;

-- A migrated account cannot be overwritten by an older in-flight Worker.
-- The marker is transaction-local and is set only inside the service-only RPCs.
create or replace function public.amazon_guard_session_protocol_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_protocol integer;
begin
  if current_setting('dropx.amazon_session_rpc', true) = 'v1' then return new; end if;
  if tg_table_name = 'amazon_portal_credentials' then
    if old.login_protocol_version > 0 and
      (new.login_locked_until is distinct from old.login_locked_until or
       new.login_lease_token is distinct from old.login_lease_token or
       new.login_protocol_version is distinct from old.login_protocol_version or
       new.last_login_at is distinct from old.last_login_at or
       new.last_login_error is distinct from old.last_login_error) then
      raise exception 'AMAZON_SESSION_PROTOCOL_REQUIRED' using errcode = 'P0001';
    end if;
  else
    select login_protocol_version into v_protocol
      from public.amazon_portal_credentials where account_key = new.account_key;
    if coalesce(v_protocol, 0) > 0 then
      raise exception 'AMAZON_SESSION_PROTOCOL_REQUIRED' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.amazon_guard_session_protocol_v1() from public, anon, authenticated;

create trigger amazon_credentials_protocol_guard_v1
before update on public.amazon_portal_credentials for each row
execute function public.amazon_guard_session_protocol_v1();
create trigger amazon_sessions_protocol_guard_v1
before insert or update on public.amazon_sessions for each row
execute function public.amazon_guard_session_protocol_v1();

create or replace function public.amazon_claim_login_v1(
  p_account_key text, p_token uuid, p_ttl_seconds integer default 300
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_row public.amazon_portal_credentials%rowtype;
begin
  if p_token is null or nullif(btrim(p_account_key), '') is null then
    raise exception 'INVALID_LOGIN_LEASE' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('amazon-session:' || p_account_key, 0));
  select * into v_row from public.amazon_portal_credentials
    where account_key = p_account_key for update;
  if not found then return false; end if;
  if v_row.login_locked_until > clock_timestamp() then
    return v_row.login_lease_token is not distinct from p_token;
  end if;
  perform set_config('dropx.amazon_session_rpc', 'v1', true);
  update public.amazon_portal_credentials set
    login_lease_token = p_token, login_protocol_version = 1,
    login_locked_until = clock_timestamp() + make_interval(secs => greatest(30, least(600, coalesce(p_ttl_seconds, 300))))
    where account_key = p_account_key;
  return true;
end $$;

create or replace function public.amazon_finish_login_v1(
  p_account_key text, p_token uuid, p_ok boolean,
  p_error text default null, p_cooldown_seconds integer default 0
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_token is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('amazon-session:' || p_account_key, 0));
  perform set_config('dropx.amazon_session_rpc', 'v1', true);
  update public.amazon_portal_credentials set
    login_lease_token = null,
    login_locked_until = case when not p_ok and p_cooldown_seconds > 0
      then clock_timestamp() + make_interval(secs => least(p_cooldown_seconds, 3600)) else null end,
    last_login_at = case when p_ok then clock_timestamp() else last_login_at end,
    last_login_error = case when p_ok then null else left(coalesce(p_error, 'Login failed'), 1000) end
    where account_key = p_account_key and login_lease_token = p_token;
  return found;
end $$;

create or replace function public.amazon_replace_session_v1(
  p_account_key text, p_session_id uuid, p_cookie text,
  p_api_key text, p_uploaded_by text, p_token uuid default null
) returns setof public.amazon_sessions language plpgsql security invoker set search_path = '' as $$
declare v_existing public.amazon_sessions%rowtype; v_lease public.amazon_portal_credentials%rowtype;
begin
  if p_session_id is null or nullif(btrim(p_account_key), '') is null or
     nullif(btrim(p_cookie), '') is null or nullif(btrim(p_api_key), '') is null or
     nullif(btrim(p_uploaded_by), '') is null then
    raise exception 'INVALID_AMAZON_SESSION' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('amazon-session:' || p_account_key, 0));
  select * into v_existing from public.amazon_sessions where id = p_session_id;
  if found then
    if v_existing.account_key <> p_account_key or v_existing.cookie <> p_cookie or
       v_existing.x_api_usage_key <> p_api_key or v_existing.status <> 'active' then
      raise exception 'SESSION_RECEIPT_SUPERSEDED' using errcode = 'P0001';
    end if;
    return next v_existing; return;
  end if;
  select * into v_lease from public.amazon_portal_credentials
    where account_key = p_account_key for update;
  if p_token is not null and (v_lease.login_lease_token is distinct from p_token or
     v_lease.login_locked_until is null or v_lease.login_locked_until <= clock_timestamp()) then
    raise exception 'LOGIN_LEASE_LOST' using errcode = 'P0001';
  end if;
  perform set_config('dropx.amazon_session_rpc', 'v1', true);
  -- Both writes commit together. A failed insert rolls back the expiry.
  update public.amazon_sessions set status = 'expired', expired_at = clock_timestamp()
    where account_key = p_account_key and status = 'active';
  insert into public.amazon_sessions(id, account_key, cookie, x_api_usage_key, uploaded_by, status)
    values(p_session_id, p_account_key, p_cookie, p_api_key, p_uploaded_by, 'active')
    returning * into v_existing;
  update public.amazon_portal_credentials set login_protocol_version = 1,
    last_login_at = clock_timestamp(), last_login_error = null,
    login_lease_token = case when p_token is null then null else login_lease_token end,
    login_locked_until = case when p_token is null then null else login_locked_until end
    where account_key = p_account_key;
  return next v_existing;
end $$;

create or replace function public.amazon_expire_session_v1(p_account_key text, p_session_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_session_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('amazon-session:' || p_account_key, 0));
  perform set_config('dropx.amazon_session_rpc', 'v1', true);
  update public.amazon_sessions set status = 'expired', expired_at = clock_timestamp()
    where id = p_session_id and account_key = p_account_key and status = 'active';
  return found;
end $$;

revoke all on function public.amazon_claim_login_v1(text,uuid,integer) from public, anon, authenticated;
revoke all on function public.amazon_finish_login_v1(text,uuid,boolean,text,integer) from public, anon, authenticated;
revoke all on function public.amazon_replace_session_v1(text,uuid,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.amazon_expire_session_v1(text,uuid) from public, anon, authenticated;
grant execute on function public.amazon_claim_login_v1(text,uuid,integer) to service_role;
grant execute on function public.amazon_finish_login_v1(text,uuid,boolean,text,integer) to service_role;
grant execute on function public.amazon_replace_session_v1(text,uuid,text,text,text,uuid) to service_role;
grant execute on function public.amazon_expire_session_v1(text,uuid) to service_role;
