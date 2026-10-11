-- One-off per environment (dev, then prod): schedule push delivery. Run manually in the Supabase
-- SQL editor. Do NOT commit values: the repo is public.
--
-- Before running:
--   1. Deploy the function:        supabase functions deploy send-push
--   2. Set its secrets:            supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:...
--   3. Store the project URL and service-role key in Vault (type the real values in the editor):
--        select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
--        select vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'service_role_key');
--
-- generate_reminders() is already scheduled by the notifications migration (every 5 minutes).
-- This job calls the Edge Function every minute to send whatever is waiting.

create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'send-push';

select cron.schedule(
  'send-push',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := '{}'::jsonb
    );
  $job$
);
