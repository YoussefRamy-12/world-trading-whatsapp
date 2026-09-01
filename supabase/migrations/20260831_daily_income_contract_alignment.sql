-- Daily-income compatibility migration.
-- This file intentionally preserves legacy hourly columns and documents the staged migration
-- to the daily-income model without executing any destructive changes on the live database.

BEGIN;

ALTER TABLE public.countries
  ADD COLUMN IF NOT EXISTS base_daily_income numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_income numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_income_last_paid_at timestamptz;

-- NOTE:
-- Do not drop public.countries.hourly_income or public.countries.income_calculated_until yet.
-- These legacy columns remain for backward compatibility while the daily-income model is adopted.
-- Existing hourly values should be backfilled into daily_income as a one-time migration and then
-- checked against the country-level daily income rules before the old columns are retired.

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
  SELECT
    o.id,
    o.buyer_id,
    o.seller_id,
    o.country_id,
    o.price,
    o.expires_at,
    o.status
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
  SELECT
    o.id,
    o.buyer_id,
    o.seller_id,
    o.country_id,
    o.price,
    o.status
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

  IF COALESCE(v_country.upgrade_level, 0) = 0 THEN
    RAISE EXCEPTION 'LEVEL_0_COUNTRY_NOT_FOR_SALE';
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
  SELECT
    o.id,
    o.buyer_id,
    o.seller_id,
    o.country_id,
    o.price,
    o.status
  FROM public.offers o
  WHERE o.id = p_offer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_country(
  p_admin_id uuid,
  p_country_id uuid,
  p_current_price numeric,
  p_daily_income numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin record;
  v_country record;
BEGIN
  SELECT * INTO v_admin
  FROM public.users
  WHERE id = p_admin_id
    AND COALESCE(is_admin, false) = true
  FOR UPDATE;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'ADMIN_NOT_FOUND';
  END IF;

  SELECT * INTO v_country
  FROM public.countries
  WHERE id = p_country_id
  FOR UPDATE;

  IF v_country IS NULL THEN
    RAISE EXCEPTION 'COUNTRY_NOT_FOUND';
  END IF;

  UPDATE public.countries
  SET current_price = COALESCE(p_current_price, current_price),
      daily_income = COALESCE(p_daily_income, daily_income),
      updated_at = NOW()
  WHERE id = p_country_id;

  RETURN jsonb_build_object(
    'country_id', p_country_id,
    'current_price', COALESCE(p_current_price, v_country.current_price),
    'daily_income', COALESCE(p_daily_income, v_country.daily_income),
    'reason', p_reason
  );
END;
$$;

-- Compatibility for the legacy admin RPC name if the existing database still exposes hourly_income
-- CREATE OR REPLACE FUNCTION public.admin_update_country_legacy(
--   p_admin_id uuid,
--   p_country_id uuid,
--   p_current_price numeric,
--   p_hourly_income numeric,
--   p_reason text
-- )
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- AS $$
-- BEGIN
--   RETURN public.admin_update_country(
--     p_admin_id,
--     p_country_id,
--     p_current_price,
--     p_hourly_income,
--     p_reason
--   );
-- END;
-- $$;

COMMIT;
