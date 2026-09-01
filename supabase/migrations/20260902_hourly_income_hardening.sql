BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'game_settings'
      AND column_name = 'income_mode'
  ) THEN
    ALTER TABLE public.game_settings
      DROP CONSTRAINT IF EXISTS game_settings_income_mode_check;

    ALTER TABLE public.game_settings
      DROP COLUMN IF EXISTS income_mode;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.admin_update_game_settings(
  p_admin_id uuid,
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
BEGIN
  SELECT id INTO v_admin
  FROM public.users
  WHERE id = p_admin_id
    AND COALESCE(is_admin, false) = true;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'ADMIN_NOT_FOUND';
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
  FROM public.market_settings
  WHERE id = 1
  FOR UPDATE;

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
  SET game_active = COALESCE(p_game_active, game_active),
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

COMMENT ON FUNCTION public.admin_update_game_settings(
  uuid,
  boolean,
  integer,
  numeric,
  numeric,
  boolean,
  numeric,
  integer
) IS 'Hourly-income-only admin settings update. income_mode was removed from the schema.';

COMMIT;
