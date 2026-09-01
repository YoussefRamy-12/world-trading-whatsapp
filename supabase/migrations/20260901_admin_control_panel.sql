BEGIN;

ALTER TABLE public.game_settings
  ADD COLUMN IF NOT EXISTS income_mode text NOT NULL DEFAULT 'daily';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_settings_income_mode_check'
      AND conrelid = 'public.game_settings'::regclass
  ) THEN
    ALTER TABLE public.game_settings
      ADD CONSTRAINT game_settings_income_mode_check
      CHECK (income_mode IN ('daily', 'hourly'));
  END IF;
END;
$$;

ALTER TABLE public.market_settings
  ADD COLUMN IF NOT EXISTS market_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.countries
  ADD COLUMN IF NOT EXISTS market_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.admin_update_game_settings(
  p_admin_id uuid,
  p_income_mode text DEFAULT NULL,
  p_market_enabled boolean DEFAULT NULL,
  p_offer_duration_minutes integer DEFAULT NULL,
  p_min_price_percent numeric DEFAULT NULL,
  p_max_price_percent numeric DEFAULT NULL,
  p_game_active boolean DEFAULT NULL,
  p_starting_balance numeric DEFAULT NULL,
  p_max_country_level integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_settings record;
  v_mode text;
BEGIN
  SELECT id INTO v_admin
  FROM public.users
  WHERE id = p_admin_id AND COALESCE(is_admin, false) = true;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'ADMIN_NOT_FOUND';
  END IF;

  v_mode := lower(trim(COALESCE(p_income_mode, '')));
  IF p_income_mode IS NOT NULL AND v_mode NOT IN ('daily', 'hourly') THEN
    RAISE EXCEPTION 'INVALID_INCOME_MODE';
  END IF;

  IF p_offer_duration_minutes IS NOT NULL AND (p_offer_duration_minutes <= 0 OR p_offer_duration_minutes > 10080) THEN
    RAISE EXCEPTION 'INVALID_OFFER_DURATION';
  END IF;

  IF p_min_price_percent IS NOT NULL AND p_min_price_percent <= 0 THEN
    RAISE EXCEPTION 'INVALID_MIN_PRICE_PERCENT';
  END IF;

  IF p_max_price_percent IS NOT NULL AND p_max_price_percent <= 0 THEN
    RAISE EXCEPTION 'INVALID_MAX_PRICE_PERCENT';
  END IF;

  IF p_starting_balance IS NOT NULL AND (p_starting_balance < 0 OR p_starting_balance > 1000000000) THEN
    RAISE EXCEPTION 'INVALID_STARTING_BALANCE';
  END IF;

  IF p_max_country_level IS NOT NULL AND (p_max_country_level < 0 OR p_max_country_level > 5) THEN
    RAISE EXCEPTION 'INVALID_MAX_COUNTRY_LEVEL';
  END IF;

  SELECT min_price_percent, max_price_percent INTO v_settings
  FROM public.market_settings WHERE id = 1 FOR UPDATE;

  IF p_min_price_percent IS NOT NULL
     AND p_max_price_percent IS NOT NULL
     AND p_min_price_percent >= p_max_price_percent THEN
    RAISE EXCEPTION 'INVALID_PRICE_RANGE';
  END IF;

  IF p_min_price_percent IS NOT NULL
     AND p_min_price_percent >= COALESCE(p_max_price_percent, v_settings.max_price_percent) THEN
    RAISE EXCEPTION 'INVALID_PRICE_RANGE';
  END IF;

  IF p_max_price_percent IS NOT NULL
     AND p_max_price_percent <= COALESCE(p_min_price_percent, v_settings.min_price_percent) THEN
    RAISE EXCEPTION 'INVALID_PRICE_RANGE';
  END IF;

  UPDATE public.game_settings
  SET income_mode = COALESCE(v_mode, income_mode),
      game_active = COALESCE(p_game_active, game_active),
      starting_balance = COALESCE(p_starting_balance, starting_balance)
  WHERE id = 1;

  UPDATE public.market_settings
  SET market_enabled = COALESCE(p_market_enabled, market_enabled),
      offer_duration_minutes = COALESCE(p_offer_duration_minutes, offer_duration_minutes),
      min_price_percent = COALESCE(p_min_price_percent, min_price_percent),
      max_price_percent = COALESCE(p_max_price_percent, max_price_percent),
      max_country_level = COALESCE(p_max_country_level, max_country_level),
      updated_at = NOW()
  WHERE id = 1;

  RETURN jsonb_build_object(
    'income_mode', (SELECT income_mode FROM public.game_settings WHERE id = 1),
    'game_active', (SELECT game_active FROM public.game_settings WHERE id = 1),
    'starting_balance', (SELECT starting_balance FROM public.game_settings WHERE id = 1),
    'market_enabled', (SELECT market_enabled FROM public.market_settings WHERE id = 1),
    'offer_duration_minutes', (SELECT offer_duration_minutes FROM public.market_settings WHERE id = 1),
    'min_price_percent', (SELECT min_price_percent FROM public.market_settings WHERE id = 1),
    'max_price_percent', (SELECT max_price_percent FROM public.market_settings WHERE id = 1),
    'max_country_level', (SELECT max_country_level FROM public.market_settings WHERE id = 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_country_market_availability(
  p_admin_id uuid,
  p_country_id uuid,
  p_market_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_country record;
BEGIN
  SELECT id INTO v_admin FROM public.users
  WHERE id = p_admin_id AND COALESCE(is_admin, false) = true;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'ADMIN_NOT_FOUND'; END IF;

  UPDATE public.countries
  SET market_enabled = p_market_enabled
  WHERE id = p_country_id
  RETURNING id, name, market_enabled INTO v_country;

  IF v_country IS NULL THEN RAISE EXCEPTION 'COUNTRY_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('country_id', v_country.id, 'name', v_country.name, 'market_enabled', v_country.market_enabled);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_player_active(
  p_admin_id uuid,
  p_player_id uuid,
  p_is_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_player record;
BEGIN
  SELECT id INTO v_admin FROM public.users
  WHERE id = p_admin_id AND COALESCE(is_admin, false) = true;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'ADMIN_NOT_FOUND'; END IF;
  IF p_admin_id = p_player_id THEN RAISE EXCEPTION 'CANNOT_DISABLE_SELF'; END IF;

  UPDATE public.users
  SET is_active = p_is_active
  WHERE id = p_player_id
  RETURNING id, name, is_active INTO v_player;

  IF v_player IS NULL THEN RAISE EXCEPTION 'PLAYER_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('player_id', v_player.id, 'name', v_player.name, 'is_active', v_player.is_active);
END;
$$;

COMMIT;
