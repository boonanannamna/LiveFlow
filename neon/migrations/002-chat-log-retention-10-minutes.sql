BEGIN;

CREATE INDEX IF NOT EXISTS liveflow_auth_chat_logs_created_at
  ON public.liveflow_auth_chat_logs(created_at);

CREATE OR REPLACE FUNCTION public.liveflow_purge_chat_logs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.liveflow_auth_chat_logs
  WHERE created_at < now() - interval '10 minutes';

  DELETE FROM public.liveflow_auth_chat_logs
  WHERE auth_user_id = NEW.auth_user_id
    AND id NOT IN (
      SELECT id
      FROM public.liveflow_auth_chat_logs
      WHERE auth_user_id = NEW.auth_user_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1000
    );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS liveflow_purge_chat_logs_trigger
  ON public.liveflow_auth_chat_logs;

CREATE TRIGGER liveflow_purge_chat_logs_trigger
AFTER INSERT ON public.liveflow_auth_chat_logs
FOR EACH ROW
EXECUTE FUNCTION public.liveflow_purge_chat_logs();

DELETE FROM public.liveflow_auth_chat_logs
WHERE created_at < now() - interval '10 minutes';

COMMIT;
