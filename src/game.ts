import { supabase } from "./supabase.js";

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
    if (!country.owned_since) {
      continue;
    }

    const calculatedUntil = country.income_calculated_until
      ? new Date(country.income_calculated_until)
      : new Date(country.owned_since);

    const elapsedMilliseconds =
      now.getTime() - calculatedUntil.getTime();

    const elapsedHours =
      elapsedMilliseconds / (1000 * 60 * 60);

    if (elapsedHours <= 0) {
      continue;
    }

    const income =
      elapsedHours * Number(country.hourly_income);

    totalIncome += income;

    incomeDetails.push({
      country: country.name,
      hours: elapsedHours,
      income,
    });

    await supabase
      .from("countries")
      .update({
        income_calculated_until: now.toISOString(),
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

    const newBalance =
      Number(player.balance) + totalIncome;

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

export async function buyCountry(
  playerId: string,
  countryId: string
) {
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
  const { data, error } = await supabase.rpc(
    "admin_update_country",
    {
      p_admin_id: adminId,
      p_country_id: countryId,
      p_current_price: currentPrice,
      p_hourly_income: hourlyIncome,
      p_reason: reason,
    }
  );

  if (error) {
    throw error;
  }

  return data;
}