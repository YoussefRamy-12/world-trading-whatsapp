import { supabase } from "../config/supabase.js";


export async function createPlayer(
  whatsappNumber: string,
  name: string
) {
  const { data: existingPlayer, error: existingError } = await supabase
    .from("users")
    .select("*")
    .eq("whatsapp_number", whatsappNumber)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingPlayer) {
    return {
      player: existingPlayer,
      created: false,
    };
  }

  const { data: settings, error: settingsError } = await supabase
    .from("game_settings")
    .select("starting_balance")
    .eq("id", 1)
    .single();

  if (settingsError) {
    throw settingsError;
  }

  const { data: player, error: createError } = await supabase
    .from("users")
    .insert({
      whatsapp_number: whatsappNumber,
      name,
      balance: settings.starting_balance,
    })
    .select()
    .single();

  if (createError) {
    throw createError;
  }

  return {
    player,
    created: true,
  };
}

export async function getPlayer(whatsappNumber: string) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("whatsapp_number", whatsappNumber)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

const COUNTRY_BUILDING_CONFIG = {
  silver: {
    1: { name: "Ministry of Defense", cost: 100, income: 25 },
    2: { name: "Army Base", cost: 75, income: 15 },
    3: { name: "Missile Base", cost: 100, income: 20 },
    4: { name: "Air Force Base", cost: 75, income: 15 },
    5: { name: "Naval Fleet", cost: 100, income: 20 },
  },
  gold: {
    1: { name: "Ministry of Defense", cost: 150, income: 35 },
    2: { name: "Army Base", cost: 125, income: 25 },
    3: { name: "Missile Base", cost: 150, income: 30 },
    4: { name: "Air Force Base", cost: 125, income: 25 },
    5: { name: "Naval Fleet", cost: 150, income: 25 },
  },
  platinum: {
    1: { name: "Ministry of Defense", cost: 200, income: 45 },
    2: { name: "Army Base", cost: 175, income: 35 },
    3: { name: "Missile Base", cost: 200, income: 40 },
    4: { name: "Air Force Base", cost: 175, income: 35 },
    5: { name: "Naval Fleet", cost: 200, income: 40 },
  },
} as const;

function normalizeCountryCategory(category?: string | null) {
  return String(category ?? "silver").trim().toLowerCase();
}

async function assertPlayerActive(playerId: string) {
  const { data, error } = await supabase
    .from("users")
    .select("is_active")
    .eq("id", playerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("PLAYER_NOT_FOUND");
  if (data.is_active === false) throw new Error("PLAYER_DISABLED");
}

export function getCountryHourlyIncome(country: {
  base_daily_income?: number | string | null;
  daily_income?: number | string | null;
  category?: string | null;
  upgrade_level?: number | string | null;
}) {
  const currentLevel = Number(country.upgrade_level ?? 0);
  const category = normalizeCountryCategory(country.category);
  const buildingConfig =
    COUNTRY_BUILDING_CONFIG[
      category as keyof typeof COUNTRY_BUILDING_CONFIG
    ] ?? COUNTRY_BUILDING_CONFIG.silver;

  let baseIncome = Number(
    country.base_daily_income ??
      country.daily_income ??
      0
  );

  let completedBuildingIncome = 0;

  for (let level = 1; level <= currentLevel; level += 1) {
    completedBuildingIncome += Number(
      buildingConfig[level as keyof typeof buildingConfig]?.income ?? 0
    );
  }

  if (baseIncome <= 0 && country.daily_income !== undefined) {
    baseIncome =
      Number(country.daily_income ?? 0) - completedBuildingIncome;
  }

  return Math.max(0, baseIncome + completedBuildingIncome) / 24;
}

export const getCountryDailyIncome = getCountryHourlyIncome;

function getCairoPeriodKey(date: Date, mode: "daily" | "hourly") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(mode === "hourly" ? { hour: "2-digit", hourCycle: "h23" as const } : {}),
  }).formatToParts(date);

  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return mode === "hourly"
    ? `${values.year}-${values.month}-${values.day}-${values.hour}`
    : `${values.year}-${values.month}-${values.day}`;
}

function getMissedPayoutCount(
  lastPaidAt: Date | null,
  now: Date,
  mode: "daily" | "hourly"
) {
  if (!lastPaidAt) {
    return 0;
  }

  const lastPaidKey = getCairoPeriodKey(lastPaidAt, mode);
  const currentKey = getCairoPeriodKey(now, mode);
  const toComparableDate = (key: string) => {
    if (mode === "hourly") {
      const [year, month, day, hour] = key.split("-");
      return new Date(`${year}-${month}-${day}T${hour}:00:00Z`);
    }

    return new Date(`${key}T00:00:00Z`);
  };
  const lastPaidDate = new Date(
    toComparableDate(lastPaidKey)
  );
  const currentDate = new Date(
    toComparableDate(currentKey)
  );

  const millisecondsPerPeriod = mode === "hourly"
    ? 1000 * 60 * 60
    : 1000 * 60 * 60 * 24;

  return Math.max(
    0,
    Math.floor(
      (currentDate.getTime() - lastPaidDate.getTime()) /
        millisecondsPerPeriod
    )
  );
}

export async function collectPlayerIncome(playerId: string) {
  const { data: countries, error } = await supabase
    .from("countries")
    .select("*")
    .eq("owner_id", playerId);

  if (error) {
    throw error;
  }

  if (!countries || countries.length === 0) {
    return {
      income: 0,
      countries: [],
    };
  }

  const now = new Date();
  let totalIncome = 0;
  const incomeDetails = [];

  for (const country of countries) {
    if (!country.owner_id || !country.owned_since) {
      continue;
    }

    const hourlyIncome = getCountryHourlyIncome(country);

    if (hourlyIncome <= 0) {
      continue;
    }

    const lastPaidAt = country.hourly_income_last_paid_at ?? country.daily_income_last_paid_at
      ? new Date(country.hourly_income_last_paid_at ?? country.daily_income_last_paid_at)
      : new Date(country.owned_since);

    const missedPeriods = getMissedPayoutCount(lastPaidAt, now, "hourly");

    if (missedPeriods <= 0) {
      continue;
    }

    const income = hourlyIncome * missedPeriods;

    totalIncome += income;

    incomeDetails.push({
      country: country.name,
      periods: missedPeriods,
      income,
    });

    await supabase
      .from("countries")
      .update({
        daily_income: hourlyIncome * 24,
        daily_income_last_paid_at: now.toISOString(),
        hourly_income_last_paid_at: now.toISOString(),
      })
      .eq("id", country.id);
  }

  if (totalIncome > 0) {
    const { data: player, error: playerError } = await supabase
      .from("users")
      .select("balance")
      .eq("id", playerId)
      .single();

    if (playerError) {
      throw playerError;
    }

    const newBalance = Number(player.balance) + totalIncome;

    const { error: updateError } = await supabase
      .from("users")
      .update({
        balance: newBalance,
      })
      .eq("id", playerId);

    if (updateError) {
      throw updateError;
    }

    const { error: transactionError } = await supabase
      .from("transactions")
      .insert({
        user_id: playerId,
        type: "hourly_income",
        amount: totalIncome,
        description: "Country hourly income",
      });

    if (transactionError) {
      throw transactionError;
    }
  }

  return {
    income: totalIncome,
    countries: incomeDetails,
  };
}

async function getCountryById(countryId: string) {
  const { data, error } = await supabase
    .from("countries")
    .select(
      "id,name,code,base_price,current_price,daily_income,owner_id,owned_since,upgrade_level,category,market_enabled"
    )
    .eq("id", countryId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function assertCountryTradeAllowed(
  countryId: string,
  { requireOwner, ownerId, allowLevelZero = false }: {
    requireOwner?: boolean;
    ownerId?: string;
    allowLevelZero?: boolean;
  } = {}
) {
  const country = await getCountryById(countryId);

  if (!country) {
    throw new Error("COUNTRY_NOT_FOUND");
  }

  if (requireOwner && country.owner_id !== ownerId) {
    throw new Error("NOT_COUNTRY_OWNER");
  }

  const level = Number(country.upgrade_level ?? 0);

  if (!allowLevelZero && level === 0) {
    throw new Error("LEVEL_0_COUNTRY_NOT_FOR_SALE");
  }

  return country;
}

export async function buyCountry(
  playerId: string,
  countryId: string
) {
  await assertPlayerActive(playerId);
  const settings = await getGameSettings();
  if (settings.market_enabled === false) {
    throw new Error("MARKET_CLOSED");
  }

  const country = await getCountryById(countryId);

  if (!country) {
    throw new Error("COUNTRY_NOT_FOUND");
  }

  if (country.owner_id === playerId) {
    throw new Error("COUNTRY_ALREADY_OWNED");
  }

  if (country.market_enabled === false) {
    throw new Error("COUNTRY_MARKET_DISABLED");
  }

  const { data, error } = await supabase.rpc(
    "buy_country",
    {
      p_player_id: playerId,
      p_country_id: countryId,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function sellCountry(
  playerId: string,
  countryId: string
) {
  await assertCountryTradeAllowed(countryId, {
    requireOwner: true,
    ownerId: playerId,
  });

  const { data, error } = await supabase.rpc(
    "sell_country",
    {
      p_player_id: playerId,
      p_country_id: countryId,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function createCountryOffer(
  buyerId: string,
  countryId: string,
  price: number
) {
  await assertPlayerActive(buyerId);
  const settings = await getGameSettings();
  if (settings.market_enabled === false) {
    throw new Error("MARKET_CLOSED");
  }

  const country = await getCountryById(countryId);

  if (!country) {
    throw new Error("COUNTRY_NOT_FOUND");
  }

  if (country.owner_id === buyerId) {
    throw new Error("CANNOT_OFFER_OWN_COUNTRY");
  }

  const level = Number(country.upgrade_level ?? 0);

  if (level === 0) {
    throw new Error("LEVEL_0_COUNTRY_NOT_FOR_SALE");
  }

  if (country.market_enabled === false) {
    throw new Error("COUNTRY_MARKET_DISABLED");
  }

  const { data, error } = await supabase.rpc(
    "create_country_offer",
    {
      p_buyer_id: buyerId,
      p_country_id: countryId,
      p_price: price,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function acceptCountryOffer(
  sellerId: string,
  offerId: string
) {
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("country_id")
    .eq("id", offerId)
    .maybeSingle();

  if (offerError) {
    throw offerError;
  }

  if (!offer) {
    throw new Error("OFFER_NOT_FOUND");
  }

  await assertCountryTradeAllowed(offer.country_id, {
    requireOwner: true,
    ownerId: sellerId,
  });

  const { data, error } = await supabase.rpc(
    "accept_country_offer",
    {
      p_seller_id: sellerId,
      p_offer_id: offerId,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function cancelCountryOffer(
  buyerId: string,
  offerId: string
) {
  const { data, error } = await supabase.rpc(
    "cancel_country_offer",
    {
      p_buyer_id: buyerId,
      p_offer_id: offerId,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function upgradeCountry(
  playerId: string,
  countryId: string
) {
  await assertPlayerActive(playerId);
  const { data, error } = await supabase.rpc(
    "upgrade_country",
    {
      p_player_id: playerId,
      p_country_id: countryId,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function getLeaderboard() {
  const { data, error } = await supabase.rpc(
    "get_leaderboard"
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function getDailyLeaderboard(
  date?: string
) {
  let query = supabase
    .from("daily_leaderboard")
    .select("*")
    .order("rank", { ascending: true });

  if (date) {
    query = query.eq("snapshot_date", date);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data;
}

export async function getGameSettings() {
  const [{ data: gameSettings, error: gameError }, { data: marketSettings, error: marketError }] =
    await Promise.all([
      supabase.from("game_settings").select("starting_balance,game_active").eq("id", 1).single(),
      supabase.from("market_settings").select("market_enabled,offer_duration_minutes,min_price_percent,max_price_percent,max_country_level").eq("id", 1).single(),
    ]);

  if (gameError) throw gameError;
  if (marketError) throw marketError;

  return { ...gameSettings, ...marketSettings };
}

export async function adminUpdateGameSettings(
  adminId: string,
  settings: {
    marketEnabled?: boolean;
    offerDurationMinutes?: number;
    minPricePercent?: number;
    maxPricePercent?: number;
    gameActive?: boolean;
    startingBalance?: number;
    maxCountryLevel?: number;
  }
) {
  const { data, error } = await supabase.rpc("admin_update_game_settings", {
    p_admin_id: adminId,
    p_market_enabled: settings.marketEnabled ?? null,
    p_offer_duration_minutes: settings.offerDurationMinutes ?? null,
    p_min_price_percent: settings.minPricePercent ?? null,
    p_max_price_percent: settings.maxPricePercent ?? null,
    p_game_active: settings.gameActive ?? null,
    p_starting_balance: settings.startingBalance ?? null,
    p_max_country_level: settings.maxCountryLevel ?? null,
  });

  if (error) throw error;
  return data;
}

export async function adminSetCountryMarketAvailability(
  adminId: string,
  countryId: string,
  marketEnabled: boolean
) {
  const { data, error } = await supabase.rpc("admin_set_country_market_availability", {
    p_admin_id: adminId,
    p_country_id: countryId,
    p_market_enabled: marketEnabled,
  });

  if (error) throw error;
  return data;
}

export async function adminSetPlayerActive(
  adminId: string,
  playerId: string,
  isActive: boolean
) {
  const { data, error } = await supabase.rpc("admin_set_player_active", {
    p_admin_id: adminId,
    p_player_id: playerId,
    p_is_active: isActive,
  });

  if (error) throw error;
  return data;
}

export async function adminAdjustBalance(
  adminId: string,
  targetUserId: string,
  amount: number,
  reason: string
) {
  const { data, error } = await supabase.rpc(
    "admin_adjust_balance",
    {
      p_admin_id: adminId,
      p_target_user_id: targetUserId,
      p_amount: amount,
      p_reason: reason,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}

export async function adminUpdateCountry(
  adminId: string,
  countryId: string,
  currentPrice: number,
  hourlyIncome: number,
  reason: string
) {
  const baseArgs = {
    p_admin_id: adminId,
    p_country_id: countryId,
    p_current_price: currentPrice,
    p_reason: reason,
  } as const;

  let result = await supabase.rpc(
    "admin_update_country",
    {
      ...baseArgs,
      p_hourly_income: hourlyIncome,
    }
  );

  if (result.error) {
    const fallbackResult = await supabase.rpc(
      "admin_update_country",
      {
        ...baseArgs,
        p_daily_income: hourlyIncome,
      }
    );

    if (fallbackResult.error) {
      throw fallbackResult.error;
    }

    result = fallbackResult;
  }

  return result.data;
}