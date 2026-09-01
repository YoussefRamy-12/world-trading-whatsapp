BEGIN;

DROP FUNCTION IF EXISTS public.accept_country_offer(uuid, uuid);
DROP FUNCTION IF EXISTS public.cancel_country_offer(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_country_offer(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.buy_country(uuid, uuid);
DROP FUNCTION IF EXISTS public.sell_country(uuid, uuid);
DROP FUNCTION IF EXISTS public.upgrade_country(uuid, uuid);

CREATE OR REPLACE FUNCTION public.collect_player_hourly_income(
  p_player_id uuid
)
RETURNS TABLE (
  total_income numeric,
  details jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country record;
  v_now timestamptz := NOW();
  v_total_income numeric := 0;
  v_details jsonb := '[]'::jsonb;
  v_last_paid_at timestamptz;
  v_missed_hours integer;
  v_hourly_income numeric;
BEGIN
  FOR v_country IN
    SELECT c.*
    FROM public.countries c
    WHERE c.owner_id = p_player_id
    FOR UPDATE
  LOOP
    IF COALESCE(v_country.daily_income, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_last_paid_at := COALESCE(
      v_country.hourly_income_last_paid_at,
      v_country.daily_income_last_paid_at,
      v_country.owned_since,
      v_now
    );

    v_missed_hours := GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (v_now - v_last_paid_at)) / 3600)
    );

    IF v_missed_hours <= 0 THEN
      CONTINUE;
    END IF;

    v_hourly_income := COALESCE(v_country.daily_income, 0) / 24;
    v_total_income := v_total_income + v_hourly_income * v_missed_hours;
    v_details := v_details || jsonb_build_array(
      jsonb_build_object(
        'country_id', v_country.id,
        'country_name', v_country.name,
        'missed_hours', v_missed_hours,
        'amount', v_hourly_income * v_missed_hours
      )
    );

    UPDATE public.countries
    SET hourly_income_last_paid_at = v_now,
        daily_income_last_paid_at = v_now
    WHERE id = v_country.id;
  END LOOP;

  UPDATE public.users
  SET balance = COALESCE(balance, 0) + v_total_income
  WHERE id = p_player_id;

  RETURN QUERY
  SELECT v_total_income, v_details;
END;
$$;

CREATE OR REPLACE FUNCTION public.buy_country(
  p_player_id uuid,
  p_country_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country record;
  v_player record;
BEGIN
  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id = p_player_id THEN
    RAISE EXCEPTION 'COUNTRY_ALREADY_OWNED';
  END IF;

  IF COALESCE(v_country.current_price, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_COUNTRY_PRICE';
  END IF;

  IF COALESCE(v_player.balance, 0) - COALESCE(v_player.reserved_balance, 0) < COALESCE(v_country.current_price, 0) THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  PERFORM public.collect_player_hourly_income(p_player_id);

  UPDATE public.users
  SET balance = COALESCE(balance, 0) - COALESCE(v_country.current_price, 0)
  WHERE id = p_player_id;

  IF v_country.owner_id IS NOT NULL THEN
    UPDATE public.users
    SET balance = COALESCE(balance, 0) + COALESCE(v_country.current_price, 0)
    WHERE id = v_country.owner_id;
  END IF;

  UPDATE public.countries
  SET owner_id = p_player_id,
      current_price = COALESCE(v_country.current_price, 0),
      owned_since = NOW(),
      updated_at = NOW()
  WHERE id = p_country_id;

  RETURN json_build_object(
    'player_id', p_player_id,
    'country_id', p_country_id,
    'purchase_price', COALESCE(v_country.current_price, 0),
    'status', 'purchased'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_country_offer(
  p_buyer_id uuid,
  p_country_id uuid,
  p_price numeric
)
RETURNS TABLE (
  id uuid,
  buyer_id uuid,
  seller_id uuid,
  country_id uuid,
  price numeric,
  expires_at timestamptz,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country record;
  v_buyer record;
  v_offer_id uuid;
BEGIN
  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id = p_buyer_id THEN
    RAISE EXCEPTION 'CANNOT_OFFER_OWN_COUNTRY';
  END IF;

  IF COALESCE(v_country.upgrade_level, 0) = 0 THEN
    RAISE EXCEPTION 'LEVEL_0_COUNTRY_NOT_FOR_SALE';
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'INVALID_PRICE';
  END IF;

  SELECT * INTO v_buyer
  FROM public.users
  WHERE id = p_buyer_id
  FOR UPDATE;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_buyer.balance, 0) - COALESCE(v_buyer.reserved_balance, 0) < p_price THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  PERFORM public.collect_player_hourly_income(p_buyer_id);

  UPDATE public.users
  SET reserved_balance = COALESCE(reserved_balance, 0) + p_price
  WHERE id = p_buyer_id;

  INSERT INTO public.offers (
    buyer_id,
    seller_id,
    country_id,
    price,
    status,
    expires_at
  )
  VALUES (
    p_buyer_id,
    v_country.owner_id,
    p_country_id,
    p_price,
    'active',
    NOW() + INTERVAL '15 minutes'
  )
  RETURNING id INTO v_offer_id;

  RETURN QUERY
  SELECT o.id, o.buyer_id, o.seller_id, o.country_id, o.price, o.expires_at, o.status
  FROM public.offers o
  WHERE o.id = v_offer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sell_country(
  p_player_id uuid,
  p_country_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country record;
  v_player record;
BEGIN
  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'NOT_COUNTRY_OWNER';
  END IF;

  PERFORM public.collect_player_hourly_income(p_player_id);

  UPDATE public.users
  SET balance = COALESCE(balance, 0) + COALESCE(v_country.current_price, 0)
  WHERE id = p_player_id;

  UPDATE public.countries
  SET owner_id = NULL,
      current_price = COALESCE(v_country.current_price, 0),
      owned_since = NULL,
      updated_at = NOW()
  WHERE id = p_country_id;

  RETURN json_build_object(
    'player_id', p_player_id,
    'country_id', p_country_id,
    'sale_price', COALESCE(v_country.current_price, 0),
    'status', 'sold'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.upgrade_country(
  p_player_id uuid,
  p_country_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_country record;
  v_player record;
  v_market record;
  v_upgrade_cost numeric;
  v_next_level integer;
BEGIN
  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  SELECT * INTO v_market
  FROM public.market_settings
  WHERE id = 1
  FOR UPDATE;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'NOT_COUNTRY_OWNER';
  END IF;

  v_next_level := COALESCE(v_country.upgrade_level, 0) + 1;

  IF v_next_level > COALESCE(v_market.max_country_level, 5) THEN
    RAISE EXCEPTION 'MAX_COUNTRY_LEVEL_REACHED';
  END IF;

  v_upgrade_cost := CASE
    WHEN LOWER(COALESCE(v_country.category, 'silver')) = 'silver' THEN 100
    WHEN LOWER(COALESCE(v_country.category, 'silver')) = 'gold' THEN 150
    WHEN LOWER(COALESCE(v_country.category, 'silver')) = 'platinum' THEN 200
    ELSE 100
  END;

  v_upgrade_cost := v_upgrade_cost * v_next_level;

  IF COALESCE(v_player.balance, 0) < v_upgrade_cost THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  PERFORM public.collect_player_hourly_income(p_player_id);

  UPDATE public.users
  SET balance = COALESCE(balance, 0) - v_upgrade_cost
  WHERE id = p_player_id;

  UPDATE public.countries
  SET upgrade_level = v_next_level,
      updated_at = NOW()
  WHERE id = p_country_id;

  RETURN json_build_object(
    'player_id', p_player_id,
    'country_id', p_country_id,
    'upgrade_level', v_next_level,
    'cost', v_upgrade_cost
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_country_offer(
  p_buyer_id uuid,
  p_offer_id uuid
)
RETURNS TABLE (
  id uuid,
  buyer_id uuid,
  seller_id uuid,
  country_id uuid,
  price numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_offer record;
BEGIN
  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF v_offer IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_offer.buyer_id <> p_buyer_id THEN
    RAISE EXCEPTION 'NOT_OFFER_BUYER';
  END IF;

  IF v_offer.status <> 'active' THEN
    RAISE EXCEPTION 'OFFER_NOT_ACTIVE';
  END IF;

  UPDATE public.users
  SET reserved_balance = COALESCE(reserved_balance, 0) - v_offer.price
  WHERE id = p_buyer_id;

  UPDATE public.offers
  SET status = 'cancelled'
  WHERE id = p_offer_id;

  RETURN QUERY
  SELECT o.id, o.buyer_id, o.seller_id, o.country_id, o.price, o.status
  FROM public.offers o
  WHERE o.id = p_offer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_country_offer(
  p_seller_id uuid,
  p_offer_id uuid
)
RETURNS TABLE (
  id uuid,
  buyer_id uuid,
  seller_id uuid,
  country_id uuid,
  price numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_offer record;
  v_country record;
  v_buyer record;
BEGIN
  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF v_offer IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_offer.status <> 'active' THEN
    RAISE EXCEPTION 'OFFER_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = v_offer.country_id
  FOR UPDATE;

  IF v_country.owner_id <> p_seller_id THEN
    RAISE EXCEPTION 'NOT_COUNTRY_OWNER';
  END IF;

  SELECT * INTO v_buyer
  FROM public.users
  WHERE id = v_offer.buyer_id
  FOR UPDATE;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_buyer.reserved_balance, 0) < v_offer.price THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  PERFORM public.collect_player_hourly_income(v_offer.seller_id);
  PERFORM public.collect_player_hourly_income(v_offer.buyer_id);

  UPDATE public.users
  SET reserved_balance = COALESCE(reserved_balance, 0) - v_offer.price
  WHERE id = v_offer.buyer_id;

  UPDATE public.countries
  SET owner_id = v_offer.buyer_id,
      current_price = v_offer.price,
      owned_since = NOW(),
      updated_at = NOW()
  WHERE id = v_offer.country_id;

  UPDATE public.offers
  SET status = 'accepted'
  WHERE id = p_offer_id;

  RETURN QUERY
  SELECT o.id, o.buyer_id, o.seller_id, o.country_id, o.price, o.status
  FROM public.offers o
  WHERE o.id = p_offer_id;
END;
$$;

COMMIT;
