-- LiveFlow Neon Auth + Data API schema. Run as the database owner.
CREATE TABLE IF NOT EXISTS public.liveflow_profiles (
  auth_user_id text PRIMARY KEY DEFAULT auth.user_id(),
  display_name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_active boolean NOT NULL DEFAULT true,
  plan_code text NOT NULL DEFAULT 'free',
  access_starts_at timestamptz,
  access_expires_at timestamptz,
  keyboard_rule_limit integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.liveflow_user_state (
  auth_user_id text PRIMARY KEY DEFAULT auth.user_id() REFERENCES public.liveflow_profiles(auth_user_id) ON DELETE CASCADE,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liveflow_auth_chat_logs (
  id bigserial PRIMARY KEY,
  auth_user_id text NOT NULL DEFAULT auth.user_id() REFERENCES public.liveflow_profiles(auth_user_id) ON DELETE CASCADE,
  event_type text NOT NULL,
  username text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  gift_name text,
  repeat_count integer NOT NULL DEFAULT 1,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS liveflow_auth_chat_logs_user_time ON public.liveflow_auth_chat_logs(auth_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS liveflow_auth_chat_logs_created_at ON public.liveflow_auth_chat_logs(created_at);

CREATE OR REPLACE FUNCTION public.liveflow_purge_chat_logs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$ BEGIN
  DELETE FROM public.liveflow_auth_chat_logs
  WHERE created_at < now() - interval '10 minutes';

  DELETE FROM public.liveflow_auth_chat_logs
  WHERE auth_user_id = NEW.auth_user_id
    AND id NOT IN (
      SELECT id FROM public.liveflow_auth_chat_logs
      WHERE auth_user_id = NEW.auth_user_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1000
    );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS liveflow_purge_chat_logs_trigger ON public.liveflow_auth_chat_logs;
CREATE TRIGGER liveflow_purge_chat_logs_trigger
AFTER INSERT ON public.liveflow_auth_chat_logs
FOR EACH ROW EXECUTE FUNCTION public.liveflow_purge_chat_logs();

CREATE TABLE IF NOT EXISTS public.liveflow_auth_announcements (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  image_url text,
  display_mode text NOT NULL DEFAULT 'banner',
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_by text DEFAULT auth.user_id(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liveflow_auth_system_update (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  required_version text NOT NULL DEFAULT '0.1.3',
  force_update boolean NOT NULL DEFAULT false,
  update_url text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.liveflow_auth_system_update(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.liveflow_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.liveflow_profiles WHERE auth_user_id = auth.user_id() AND role = 'admin' AND is_active) $$;

CREATE OR REPLACE FUNCTION public.liveflow_profile_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$ BEGIN
  NEW.auth_user_id := auth.user_id();
  NEW.email := lower(NEW.email);
  NEW.role := CASE WHEN NEW.email = 'boonanan.namna@gmail.com' THEN 'admin' ELSE 'user' END;
  NEW.is_active := true;
  NEW.plan_code := CASE WHEN NEW.role = 'admin' THEN 'unlimited' ELSE 'free' END;
  NEW.keyboard_rule_limit := CASE WHEN NEW.role = 'admin' THEN -1 ELSE 10 END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS liveflow_profile_guard_trigger ON public.liveflow_profiles;
CREATE TRIGGER liveflow_profile_guard_trigger BEFORE INSERT ON public.liveflow_profiles FOR EACH ROW EXECUTE FUNCTION public.liveflow_profile_guard();

ALTER TABLE public.liveflow_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liveflow_user_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liveflow_auth_chat_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liveflow_auth_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liveflow_auth_system_update ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON public.liveflow_profiles;
CREATE POLICY profiles_select ON public.liveflow_profiles FOR SELECT TO authenticated USING (auth_user_id = auth.user_id() OR public.liveflow_is_admin());
DROP POLICY IF EXISTS profiles_insert ON public.liveflow_profiles;
CREATE POLICY profiles_insert ON public.liveflow_profiles FOR INSERT TO authenticated WITH CHECK (auth_user_id = auth.user_id());
DROP POLICY IF EXISTS profiles_admin_update ON public.liveflow_profiles;
CREATE POLICY profiles_admin_update ON public.liveflow_profiles FOR UPDATE TO authenticated USING (public.liveflow_is_admin()) WITH CHECK (public.liveflow_is_admin());

DROP POLICY IF EXISTS state_owner ON public.liveflow_user_state;
CREATE POLICY state_owner ON public.liveflow_user_state FOR ALL TO authenticated USING (auth_user_id = auth.user_id()) WITH CHECK (auth_user_id = auth.user_id());
DROP POLICY IF EXISTS logs_owner ON public.liveflow_auth_chat_logs;
CREATE POLICY logs_owner ON public.liveflow_auth_chat_logs FOR ALL TO authenticated USING (auth_user_id = auth.user_id()) WITH CHECK (auth_user_id = auth.user_id());
DROP POLICY IF EXISTS announcements_read ON public.liveflow_auth_announcements;
CREATE POLICY announcements_read ON public.liveflow_auth_announcements FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS announcements_admin_write ON public.liveflow_auth_announcements;
CREATE POLICY announcements_admin_write ON public.liveflow_auth_announcements FOR ALL TO authenticated USING (public.liveflow_is_admin()) WITH CHECK (public.liveflow_is_admin());
DROP POLICY IF EXISTS system_update_read ON public.liveflow_auth_system_update;
CREATE POLICY system_update_read ON public.liveflow_auth_system_update FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS system_update_admin ON public.liveflow_auth_system_update;
CREATE POLICY system_update_admin ON public.liveflow_auth_system_update FOR UPDATE TO authenticated USING (public.liveflow_is_admin()) WITH CHECK (public.liveflow_is_admin());

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.liveflow_profiles, public.liveflow_user_state, public.liveflow_auth_chat_logs, public.liveflow_auth_announcements, public.liveflow_auth_system_update TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
