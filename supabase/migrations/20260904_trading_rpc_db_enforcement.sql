BEGIN;

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
  v_game public.game_settings%ROWTYPE;
  v_market public.market_settings%ROWTYPE;
  v_country public.countries%ROWTYPE;
  v_player public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_player.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  SELECT * INTO v_market
  FROM public.market_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_market IS NULL THEN
    RAISE EXCEPTION 'MARKET_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_market.market_enabled, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'MARKET_DISABLED';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'COUNTRY_ALREADY_OWNED';
  END IF;

  IF COALESCE(v_country.market_enabled, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'COUNTRY_MARKET_DISABLED';
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
  v_game public.game_settings%ROWTYPE;
  v_country public.countries%ROWTYPE;
  v_player public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_player.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
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
  v_game public.game_settings%ROWTYPE;
  v_country public.countries%ROWTYPE;
  v_player public.users%ROWTYPE;
  v_market public.market_settings%ROWTYPE;
  v_upgrade_cost numeric;
  v_next_level integer;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_player
  FROM public.users
  WHERE id = p_player_id
  FOR UPDATE;

  IF v_player IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_player.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  SELECT * INTO v_market
  FROM public.market_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_market IS NULL THEN
    RAISE EXCEPTION 'MARKET_SETTINGS_NOT_FOUND';
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

  IF COALESCE(v_player.balance, 0) - COALESCE(v_player.reserved_balance, 0) < v_upgrade_cost THEN
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
  v_game public.game_settings%ROWTYPE;
  v_market public.market_settings%ROWTYPE;
  v_country public.countries%ROWTYPE;
  v_buyer public.users%ROWTYPE;
  v_offer_id uuid;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_market
  FROM public.market_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_market IS NULL THEN
    RAISE EXCEPTION 'MARKET_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_market.market_enabled, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'MARKET_DISABLED';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF COALESCE(v_country.market_enabled, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'COUNTRY_MARKET_DISABLED';
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

  IF COALESCE(v_buyer.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
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
  v_game public.game_settings%ROWTYPE;
  v_offer public.offers%ROWTYPE;
  v_buyer public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

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

  SELECT * INTO v_buyer
  FROM public.users
  WHERE id = p_buyer_id
  FOR UPDATE;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_buyer.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  PERFORM public.collect_player_hourly_income(p_buyer_id);

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
  v_game public.game_settings%ROWTYPE;
  v_offer public.offers%ROWTYPE;
  v_country public.countries%ROWTYPE;
  v_seller public.users%ROWTYPE;
  v_buyer public.users%ROWTYPE;
  v_competing_offer public.offers%ROWTYPE;
BEGIN
  SELECT * INTO v_game
  FROM public.game_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_game IS NULL THEN
    RAISE EXCEPTION 'GAME_SETTINGS_NOT_FOUND';
  END IF;

  IF COALESCE(v_game.game_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'GAME_NOT_ACTIVE';
  END IF;

  SELECT * INTO v_offer
  FROM public.offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF v_offer IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_offer.seller_id IS DISTINCT FROM p_seller_id THEN
    RAISE EXCEPTION 'NOT_OFFER_SELLER';
  END IF;

  IF v_offer.status <> 'active' THEN
    RAISE EXCEPTION 'OFFER_NOT_ACTIVE';
  END IF;

  IF v_offer.expires_at IS NOT NULL AND NOW() > v_offer.expires_at THEN
    UPDATE public.users
    SET reserved_balance = COALESCE(reserved_balance, 0) - v_offer.price
    WHERE id = v_offer.buyer_id;

    UPDATE public.offers
    SET status = 'expired'
    WHERE id = p_offer_id;

    RAISE EXCEPTION 'OFFER_EXPIRED';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = v_offer.country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  IF v_country.owner_id IS DISTINCT FROM p_seller_id THEN
    RAISE EXCEPTION 'NOT_COUNTRY_OWNER';
  END IF;

  IF COALESCE(v_country.market_enabled, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'COUNTRY_MARKET_DISABLED';
  END IF;

  SELECT * INTO v_seller
  FROM public.users
  WHERE id = p_seller_id
  FOR UPDATE;

  IF v_seller IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_seller.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  SELECT * INTO v_buyer
  FROM public.users
  WHERE id = v_offer.buyer_id
  FOR UPDATE;

  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'PLAYER_NOT_FOUND';
  END IF;

  IF COALESCE(v_buyer.is_active, false) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'PLAYER_INACTIVE';
  END IF;

  IF COALESCE(v_buyer.reserved_balance, 0) < v_offer.price THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  PERFORM public.collect_player_hourly_income(v_offer.seller_id);
  PERFORM public.collect_player_hourly_income(v_offer.buyer_id);

  UPDATE public.users
  SET reserved_balance = COALESCE(reserved_balance, 0) - v_offer.price
  WHERE id = v_offer.buyer_id;

  FOR v_competing_offer IN
    SELECT o.*
    FROM public.offers o
    WHERE o.country_id = v_offer.country_id
      AND o.id <> p_offer_id
      AND o.status = 'active'
    FOR UPDATE
  LOOP
    UPDATE public.users
    SET reserved_balance = COALESCE(reserved_balance, 0) - v_competing_offer.price
    WHERE id = v_competing_offer.buyer_id;

    UPDATE public.offers
    SET status = 'cancelled'
    WHERE id = v_competing_offer.id;
  END LOOP;

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
