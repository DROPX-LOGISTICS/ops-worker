-- Seed dedicated-station portal accounts (bypasses PostgREST schema cache).
-- Run in Supabase SQL editor AFTER force-fix-portal-accounts.sql
-- (table must already have account_key column).

insert into amazon_portal_credentials (
  account_key,
  email,
  password,
  default_station_code,
  updated_by,
  updated_at
) values
  ('KDJG', 'xguptapr@amazon.com', 'KDJG@12345', 'KDJG', 'sql-seed-station-portal', now()),
  ('JUGF', 'pattbije@amazon.com', 'JUGF@123', 'JUGF', 'sql-seed-station-portal', now()),
  ('AWEZ', 'yadukrps@amazon.com', 'DROPX@321', 'AWEZ', 'sql-seed-station-portal', now()),
  ('KGQE', 'mbibinv@amazon.com', 'Kgqe@123', 'KGQE', 'sql-seed-station-portal', now()),
  ('HBSC', 'bipradhl@amazon.com', 'Dolphin@123', 'HBSC', 'sql-seed-station-portal', now())
on conflict (account_key) do update set
  email = excluded.email,
  password = excluded.password,
  default_station_code = excluded.default_station_code,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at;

-- Reload API schema cache
notify pgrst, 'reload schema';

select account_key, email, default_station_code, updated_at
from amazon_portal_credentials
order by account_key;
