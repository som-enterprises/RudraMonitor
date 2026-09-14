-- 0157_directory_sync_tick_self_hosted_url.sql
-- Fix directory_sync_tick() to POST to the self-hosted API host instead of
-- the stale Cloud Supabase URL baked into 0033. That URL was never
-- rewritten when the stack moved from Cloud to the EC2 self-hosted
-- deployment, so for two months the 5-minute pg_cron tick was firing
-- against a Cloud project that no longer exists — silently 404-ing (well,
-- 401 from Cloud's Kong which still resolves that hostname) and never
-- reaching the real edge-functions container on 18.145.223.204. Result:
-- Directory Integrations page stuck showing "Last sync: 17/07/2026" and
-- the M365 row wedged at status='syncing' for weeks.
--
-- Also documents the second concurrent gotcha we hit today: the vault
-- secret `directory_sync_service_role_jwt` may still hold the OLD
-- Cloud-project JWT and must be rotated to the current self-hosted
-- service_role JWT before this tick starts succeeding. Rotation SQL:
--   select vault.update_secret(
--     (select id from vault.secrets where name='directory_sync_service_role_jwt'),
--     '<current SERVICE_ROLE_KEY from /opt/rudrans/supabase/docker/.env>',
--     'directory_sync_service_role_jwt',
--     'Post-migration rotation.'
--   );

create or replace function public.directory_sync_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_url text;
begin
  select decrypted_secret into v_jwt
    from vault.decrypted_secrets
   where name = 'directory_sync_service_role_jwt'
   limit 1;

  if v_jwt is null then
    return;
  end if;

  -- Self-hosted API host on prod EC2. If a future customer deploys this
  -- to a different subdomain (see DEPLOY.md), also update DIRECTORY_SYNC_URL
  -- in the docker .env and mirror the change here.
  v_url := 'https://api-ems.wellnessextract.com/functions/v1/directory-sync';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_jwt,
      'Content-Type', 'application/json'
    )::jsonb,
    body := jsonb_build_object('scheduled', true)
  );
end$$;

revoke all on function public.directory_sync_tick() from public, anon, authenticated;
