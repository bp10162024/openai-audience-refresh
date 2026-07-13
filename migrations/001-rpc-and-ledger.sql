-- openai-audience-refresh: snapshot-rebuild RPC + run ledger
-- Applied to the Oracle warehouse Supabase project.

create or replace function public.rebuild_openai_audience_export()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare cnt integer;
begin
  drop table if exists public.tmp_openai_audience_export;
  create table public.tmp_openai_audience_export as
    select row_number() over (order by email_sha256) as rn, email_sha256
    from public.openai_ads_exclusion_hashes;
  create index on public.tmp_openai_audience_export (rn);
  grant select on public.tmp_openai_audience_export to service_role;
  select count(*) into cnt from public.tmp_openai_audience_export;
  return cnt;
end
$$;

revoke execute on function public.rebuild_openai_audience_export() from public, anon, authenticated;
grant execute on function public.rebuild_openai_audience_export() to service_role;

create table if not exists public.openai_audience_refresh_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz default now(),
  trigger text,
  audience_name text,
  hash_count integer,
  status text,
  matched_display text,
  campaigns_updated integer,
  old_archived integer,
  error text,
  hash_fingerprint text  -- sha256 of the uploaded hash list; enables the daily no-change skip (added July 13 2026)
);

grant select, insert on public.openai_audience_refresh_runs to service_role;
