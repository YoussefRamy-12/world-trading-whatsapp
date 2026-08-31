import { supabase } from "./supabase.js";
import {
  buyCountry,
  sellCountry,
  collectPlayerIncome,
  getLeaderboard,
  createCountryOffer,
  acceptCountryOffer,
  cancelCountryOffer,
  upgradeCountry,
} from "./game.js";
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not configured");
}

const telegramApi = `https://api.telegram.org/bot${token}`;

async function telegramRequest(
  method: string,
  body?: Record<string, unknown>
) {
  const response = await fetch(
    `${telegramApi}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      ...(body
        ? { body: JSON.stringify(body) }
        : {}),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram API error: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function sendMessage(
  chatId: number,
  text: string,
  keyboard?: unknown[][]
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (keyboard) {
    body.reply_markup = {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  return telegramRequest("sendMessage", body);
}

async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
) {
  return telegramRequest(
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }
  );
}

async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  inlineKeyboard?: unknown[][]
) {
  return telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(inlineKeyboard
        ? {
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
        }
        : {}),
    }
  );
}

function mainMenu() {
  return [
    [
      { text: "💰 My Balance" },
      { text: "🌍 My Countries" },
    ],
    [
      { text: "📊 Leaderboard" },
      { text: "🏪 Market" },
    ],
    [
      { text: "📩 My Offers" },
      { text: "🔨 Upgrade Country" },
    ],
  ];
}

async function getUpdates(offset?: number) {
  return telegramRequest(
    "getUpdates",
    {
      timeout: 30,
      ...(offset !== undefined
        ? { offset }
        : {}),
    }
  );
}

/*
 * Players who have started registration
 * but haven't entered their phone number yet.
 *
 * This is only temporary development state.
 */
type RegistrationStep =
  | "phone"
  | "name";

const registrationState =
  new Map<number, "phone" | "name">();

const pendingRegistrationPhones =
  new Map<number, string>();

/*
* Player is currently entering an offer price
* for this country.
*/
const pendingOfferCountry =
  new Map<number, string>();

const pendingOfferPrice =
  new Map<number, number>();

async function findUserByTelegramId(
  telegramUserId: number
) {
  const { data, error } = await supabase
    .from("users")
    .select(
      "id,name,telegram_user_id,telegram_username"
    )
    .eq(
      "telegram_user_id",
      telegramUserId
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase lookup failed: ${error.message}`
    );
  }

  return data;
}

async function getPlayerBalance(
  telegramUserId: number
) {
  const { data, error } = await supabase
    .from("users")
    .select("id,name,balance,reserved_balance")
    .eq(
      "telegram_user_id",
      telegramUserId
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `Balance lookup failed: ${error.message}`
    );
  }

  return data;
}

async function getPlayerCountries(
  telegramUserId: number
) {
  const { data: player, error: playerError } =
    await supabase
      .from("users")
      .select("id,name")
      .eq(
        "telegram_user_id",
        telegramUserId
      )
      .maybeSingle();

  if (playerError) {
    throw new Error(
      `Player lookup failed: ${playerError.message}`
    );
  }

  if (!player) {
    return null;
  }

  const { data: countries, error } =
    await supabase
      .from("countries")
      .select(
        "id,name,code,current_price,hourly_income,upgrade_level"
      )
      .eq("owner_id", player.id)
      .order("name");

  if (error) {
    throw new Error(
      `Countries lookup failed: ${error.message}`
    );
  }

  return {
    player,
    countries: countries ?? [],
  };
}

async function getMarketCountries() {
  const { data, error } = await supabase
    .from("countries")
    .select(
      "id,name,code,current_price,hourly_income,upgrade_level"
    )
    .is("owner_id", null)
    .order("name");

  if (error) {
    throw new Error(
      `Market lookup failed: ${error.message}`
    );
  }

  return data ?? [];
}

async function getOtherPlayersCountries(
  telegramUserId: number
) {
  const { data: player, error: playerError } =
    await supabase
      .from("users")
      .select("id")
      .eq(
        "telegram_user_id",
        telegramUserId
      )
      .maybeSingle();

  if (playerError) {
    throw new Error(
      `Player lookup failed: ${playerError.message}`
    );
  }

  if (!player) {
    return [];
  }

  const { data, error } = await supabase
    .from("countries")
    .select(
      `
      id,
      name,
      code,
      current_price,
      hourly_income,
      upgrade_level,
      owner_id,
      owner:users!countries_owner_id_fkey(
        name
      )
      `
    )
    .not("owner_id", "is", null)
    .neq("owner_id", player.id)
    .order("name");

  if (error) {
    throw new Error(
      `Other players countries lookup failed: ${error.message}`
    );
  }

  return data ?? [];
}

async function sendMarketPage(
  chatId: number,
  telegramUserId: number,
  availablePage: number = 0,
  playerPage: number = 0
) {
  const availableCountries =
    await getMarketCountries();

  const playerCountries =
    await getOtherPlayersCountries(
      telegramUserId
    );

  const pageSize = 8;

  const availableTotalPages =
    Math.max(
      1,
      Math.ceil(
        availableCountries.length /
        pageSize
      )
    );

  const playerTotalPages =
    Math.max(
      1,
      Math.ceil(
        playerCountries.length /
        pageSize
      )
    );

  // Keep requested pages inside valid range
  availablePage = Math.max(
    0,
    Math.min(
      availablePage,
      availableTotalPages - 1
    )
  );

  playerPage = Math.max(
    0,
    Math.min(
      playerPage,
      playerTotalPages - 1
    )
  );

  const availableStart =
    availablePage * pageSize;

  const playerStart =
    playerPage * pageSize;

  const pageAvailableCountries =
    availableCountries.slice(
      availableStart,
      availableStart + pageSize
    );

  const pagePlayerCountries =
    playerCountries.slice(
      playerStart,
      playerStart + pageSize
    );

  let marketMessage =
    "🏪 MARKET\n\n";

  const buttons: unknown[][] = [];

  /*
   * ==========================================
   * AVAILABLE COUNTRIES
   * ==========================================
   */

  marketMessage +=
    "🟢 AVAILABLE COUNTRIES\n\n";

  if (
    availableCountries.length === 0
  ) {
    marketMessage +=
      "No unowned countries are currently available.\n\n";
  } else {
    for (
      const country of pageAvailableCountries
    ) {
      const price =
        Number(country.current_price);

      const income =
        Number(country.hourly_income);

      const level =
        Number(country.upgrade_level);

      const code =
        country.code
          ? `🌐 ${country.code}`
          : "🌍";

      marketMessage +=
        `${code} ${country.name}\n` +
        `💵 Price: $${price.toFixed(2)}\n` +
        `📈 Level: ${level}\n` +
        `💰 Income: $${income.toFixed(2)}/hour\n\n`;

      buttons.push([
        {
          text:
            `🛒 Buy ${country.name}`,
          callback_data:
            `buy_country:${country.id}`,
        },
      ]);
    }

    /*
     * Available countries pagination
     */

    if (availableTotalPages > 1) {
      const paginationRow: unknown[] = [];

      if (availablePage > 0) {
        paginationRow.push({
          text: "⬅️ Previous",
          callback_data:
            `market:${availablePage - 1}:${playerPage}`,
        });
      }

      paginationRow.push({
        text:
          `🟢 ${availablePage + 1}/${availableTotalPages}`,
        callback_data:
          "market_noop",
      });

      if (
        availablePage <
        availableTotalPages - 1
      ) {
        paginationRow.push({
          text: "Next ➡️",
          callback_data:
            `market:${availablePage + 1}:${playerPage}`,
        });
      }

      buttons.push(
        paginationRow
      );
    }
  }

  marketMessage +=
    "━━━━━━━━━━━━━━\n\n";

  /*
   * ==========================================
   * PLAYER COUNTRIES
   * ==========================================
   */

  marketMessage +=
    "🤝 PLAYER COUNTRIES\n\n";

  if (
    playerCountries.length === 0
  ) {
    marketMessage +=
      "No other players currently own countries.\n\n";
  } else {
    for (
      const country of pagePlayerCountries
    ) {
      const price =
        Number(country.current_price);

      const income =
        Number(country.hourly_income);

      const level =
        Number(country.upgrade_level);

      const code =
        country.code
          ? `🌐 ${country.code}`
          : "🌍";

      const ownerData =
        country.owner as
        | { name?: string }
        | { name?: string }[]
        | null;

      const ownerName =
        Array.isArray(ownerData)
          ? ownerData[0]?.name
          : ownerData?.name;

      marketMessage +=
        `${code} ${country.name}\n` +
        `👤 Owner: ${ownerName ?? "Unknown"}\n` +
        `💵 Value: $${price.toFixed(2)}\n` +
        `📈 Level: ${level}\n` +
        `💰 Income: $${income.toFixed(2)}/hour\n\n`;

      buttons.push([
        {
          text:
            `💰 Make Offer — ${country.name}`,
          callback_data:
            `make_offer:${country.id}`,
        },
      ]);
    }

    /*
     * Player countries pagination
     */

    if (playerTotalPages > 1) {
      const paginationRow: unknown[] = [];

      if (playerPage > 0) {
        paginationRow.push({
          text: "⬅️ Previous",
          callback_data:
            `market:${availablePage}:${playerPage - 1}`,
        });
      }

      paginationRow.push({
        text:
          `🤝 ${playerPage + 1}/${playerTotalPages}`,
        callback_data:
          "market_noop",
      });

      if (
        playerPage <
        playerTotalPages - 1
      ) {
        paginationRow.push({
          text: "Next ➡️",
          callback_data:
            `market:${availablePage}:${playerPage + 1}`,
        });
      }

      buttons.push(
        paginationRow
      );
    }
  }

  await telegramRequest(
    "sendMessage",
    {
      chat_id: chatId,
      text: marketMessage,
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function getPlayerOffers(
  telegramUserId: number
) {
  const { data: player, error: playerError } =
    await supabase
      .from("users")
      .select("id,name")
      .eq("telegram_user_id", telegramUserId)
      .maybeSingle();

  if (playerError) {
    throw new Error(
      `Player lookup failed: ${playerError.message}`
    );
  }

  if (!player) {
    return null;
  }

  // Offers received on the player's countries
  const { data: receivedOffers, error: receivedError } =
    await supabase
      .from("offers")
      .select(`
        id,
        country_id,
        buyer_id,
        seller_id,
        price,
        status,
        created_at,
        expires_at,
        countries (
          id,
          name,
          code,
          current_price
        ),
        buyer:users!offers_buyer_id_fkey (
          id,
          name
        )
      `)
      .eq("seller_id", player.id)
      .order("created_at", {
        ascending: false,
      });

  if (receivedError) {
    throw new Error(
      `Received offers lookup failed: ${receivedError.message}`
    );
  }

  // Offers created by the player
  const { data: sentOffers, error: sentError } =
    await supabase
      .from("offers")
      .select(`
        id,
        country_id,
        buyer_id,
        seller_id,
        price,
        status,
        created_at,
        expires_at,
        countries (
          id,
          name,
          code,
          current_price
        ),
        seller:users!offers_seller_id_fkey (
          id,
          name
        )
      `)
      .eq("buyer_id", player.id)
      .order("created_at", {
        ascending: false,
      });

  if (sentError) {
    throw new Error(
      `Sent offers lookup failed: ${sentError.message}`
    );
  }

  return {
    player,
    receivedOffers: receivedOffers ?? [],
    sentOffers: sentOffers ?? [],
  };
}

async function getPlayerSentOffers(
  telegramUserId: number
) {
  const { data: player, error: playerError } =
    await supabase
      .from("users")
      .select("id,name")
      .eq("telegram_user_id", telegramUserId)
      .maybeSingle();

  if (playerError) {
    throw new Error(
      `Player lookup failed: ${playerError.message}`
    );
  }

  if (!player) {
    return null;
  }

  const { data: offers, error } =
    await supabase
      .from("offers")
      .select(`
        id,
        country_id,
        seller_id,
        buyer_id,
        price,
        status,
        created_at,
        expires_at,
        countries (
          id,
          name,
          code,
          current_price
        ),
        seller:users!offers_seller_id_fkey (
          id,
          name,
          telegram_user_id
        )
      `)
      .eq("buyer_id", player.id)
      .order("created_at", {
        ascending: false,
      });

  if (error) {
    throw new Error(
      `Sent offers lookup failed: ${error.message}`
    );
  }

  return {
    player,
    offers: offers ?? [],
  };
}

async function purchaseCountry(
  telegramUserId: number,
  countryId: string
) {
  const { data: player, error } =
    await supabase
      .from("users")
      .select("id")
      .eq(
        "telegram_user_id",
        telegramUserId
      )
      .maybeSingle();

  if (error) {
    throw new Error(
      `Player lookup failed: ${error.message}`
    );
  }

  if (!player) {
    throw new Error(
      "TELEGRAM_ACCOUNT_NOT_LINKED"
    );
  }

  return buyCountry(
    player.id,
    countryId
  );
}

async function findUserByPhone(
  phone: string
) {
  // Normalize phone number
  let normalizedPhone = phone.replace(/\D/g, "");

  // Convert 00XXXXXXXXXX → XXXXXXXXXX
  if (normalizedPhone.startsWith("00")) {
    normalizedPhone =
      normalizedPhone.substring(2);
  }

  console.log(
    "Phone lookup:",
    phone,
    "→",
    normalizedPhone
  );

  // First try the normalized number
  const { data, error } = await supabase
    .from("users")
    .select(
      "id,name,whatsapp_number,telegram_user_id,telegram_username"
    )
    .eq("whatsapp_number", normalizedPhone)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase phone lookup failed: ${error.message}`
    );
  }

  return data;
}
async function createUserFromTelegram(
  phone: string,
  name: string,
  telegramUserId: number,
  telegramUsername?: string
) {
  const { data, error } = await supabase
    .from("users")
    .insert({
      whatsapp_number: phone,
      name: name,
      balance: 10000,
      reserved_balance: 0,
      is_admin: false,
      telegram_user_id: telegramUserId,
      telegram_username:
        telegramUsername ?? null,
    })
    .select(
      "id,name,whatsapp_number,balance,reserved_balance,telegram_user_id,telegram_username"
    )
    .single();

  if (error) {
    throw new Error(
      `Supabase user creation failed: ${error.message}`
    );
  }

  return data;
}

async function linkTelegramAccount(
  userId: string,
  telegramUserId: number,
  telegramUsername?: string
) {
  const { error } = await supabase
    .from("users")
    .update({
      telegram_user_id: telegramUserId,
      telegram_username:
        telegramUsername ?? null,
    })
    .eq("id", userId);

  if (error) {
    throw new Error(
      `Supabase link failed: ${error.message}`
    );
  }
}

async function getPlayerIdByTelegramId(
  telegramUserId: number
) {
  const { data, error } = await supabase
    .from("users")
    .select("id,name")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Player lookup failed: ${error.message}`
    );
  }

  return data;
}

async function createPlayerCountryOffer(
  telegramUserId: number,
  countryId: string,
  price: number
) {
  const player =
    await getPlayerIdByTelegramId(
      telegramUserId
    );

  if (!player) {
    throw new Error(
      "TELEGRAM_ACCOUNT_NOT_LINKED"
    );
  }

  return createCountryOffer(
    player.id,
    countryId,
    price
  );
}

async function acceptPlayerCountryOffer(
  telegramUserId: number,
  offerId: string
) {
  const player =
    await getPlayerIdByTelegramId(
      telegramUserId
    );

  if (!player) {
    throw new Error(
      "TELEGRAM_ACCOUNT_NOT_LINKED"
    );
  }

  return acceptCountryOffer(
    player.id,
    offerId
  );
}

async function cancelPlayerCountryOffer(
  telegramUserId: number,
  offerId: string
) {
  const player =
    await getPlayerIdByTelegramId(
      telegramUserId
    );

  if (!player) {
    throw new Error(
      "TELEGRAM_ACCOUNT_NOT_LINKED"
    );
  }

  return cancelCountryOffer(
    player.id,
    offerId
  );
}

async function rejectCountryOffer(
  telegramUserId: number,
  offerId: string
) {
  const { data: player, error: playerError } =
    await supabase
      .from("users")
      .select("id")
      .eq(
        "telegram_user_id",
        telegramUserId
      )
      .maybeSingle();

  if (playerError) {
    throw new Error(
      `Player lookup failed: ${playerError.message}`
    );
  }

  if (!player) {
    throw new Error(
      "TELEGRAM_ACCOUNT_NOT_LINKED"
    );
  }

  const { data, error } =
    await supabase.rpc(
      "reject_country_offer",
      {
        p_seller_id: player.id,
        p_offer_id: offerId,
      }
    );

  if (error) {
    throw error;
  }

  return data;
}

async function startTelegramBot() {
  console.log(
    "Telegram bot started successfully."
  );

  let offset: number | undefined;

  while (true) {
    try {
      const result =
        await getUpdates(offset);

      for (const update of result.result) {
        offset =
          update.update_id + 1;

        const callbackQuery =
          update.callback_query;

        if (callbackQuery) {
          const callbackData =
            callbackQuery.data;

          const callbackChatId =
            callbackQuery.message?.chat.id;

          const callbackMessageId =
            callbackQuery.message?.message_id;

          const callbackTelegramUserId =
            callbackQuery.from.id;

          if (
            callbackData?.startsWith(
              "upgrade_country:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "upgrade_country:".length
              );

            try {
              const { data: country, error } =
                await supabase
                  .from("countries")
                  .select(
                    "id,name,current_price,hourly_income,upgrade_level,owner_id"
                  )
                  .eq("id", countryId)
                  .single();

              if (error || !country) {
                throw new Error(
                  "COUNTRY_NOT_FOUND"
                );
              }

              const { data: player } =
                await supabase
                  .from("users")
                  .select("id,balance,reserved_balance")
                  .eq(
                    "telegram_user_id",
                    callbackTelegramUserId
                  )
                  .maybeSingle();

              if (!player) {
                throw new Error(
                  "TELEGRAM_ACCOUNT_NOT_LINKED"
                );
              }

              if (country.owner_id !== player.id) {
                await answerCallbackQuery(
                  callbackQuery.id,
                  "❌ You don't own this country."
                );

                continue;
              }

              const currentLevel =
                Number(country.upgrade_level ?? 1);

              if (currentLevel >= 5) {
                await answerCallbackQuery(
                  callbackQuery.id,
                  "🏆 This country is already max level."
                );

                continue;
              }

              const nextLevel =
                currentLevel + 1;

              const { data: building, error: buildingError } =
                await supabase
                  .from("building_levels")
                  .select(
                    "level,building_name,upgrade_cost,value_increase,income_increase"
                  )
                  .eq("level", nextLevel)
                  .single();

              if (buildingError || !building) {
                throw new Error(
                  "BUILDING_CONFIGURATION_NOT_FOUND"
                );
              }

              const available =
                Number(player.balance ?? 0) -
                Number(player.reserved_balance ?? 0);

              const cost =
                Number(building.upgrade_cost);

              if (available < cost) {
                await answerCallbackQuery(
                  callbackQuery.id,
                  "❌ Not enough available balance."
                );

                if (callbackChatId !== undefined) {
                  await sendMessage(
                    callbackChatId,
                    `❌ You don't have enough available balance.\n\n` +
                    `💳 Available: $${available.toFixed(2)}\n` +
                    `💵 Upgrade cost: $${cost.toFixed(2)}\n\n` +
                    `You need $${(
                      cost - available
                    ).toFixed(2)} more.`,
                    mainMenu()
                  );
                }

                continue;
              }

              await answerCallbackQuery(
                callbackQuery.id
              );

              if (callbackChatId !== undefined) {
                await telegramRequest(
                  "sendMessage",
                  {
                    chat_id: callbackChatId,
                    text:
                      `🔨 UPGRADE ${country.name}\n\n` +
                      `📈 Current Level: ${currentLevel}\n` +
                      `📈 New Level: ${nextLevel}\n\n` +
                      `🏗️ Building: ${building.building_name}\n` +
                      `💵 Cost: $${cost.toFixed(2)}\n` +
                      `📊 Country Value: +$${Number(
                        building.value_increase
                      ).toFixed(2)}\n` +
                      `💰 Hourly Income: +$${Number(
                        building.income_increase
                      ).toFixed(2)}/hour\n\n` +
                      `Are you sure you want to upgrade?`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "✅ Confirm Upgrade",
                            callback_data:
                              `confirm_upgrade:${country.id}`,
                          },
                          {
                            text: "❌ Cancel",
                            callback_data:
                              "cancel_upgrade",
                          },
                        ],
                      ],
                    },
                  }
                );
              }
            } catch (error) {
              console.error(
                "Upgrade confirmation error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Unable to prepare upgrade."
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "confirm_upgrade:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "confirm_upgrade:".length
              );

            try {
              const { data: player, error } =
                await supabase
                  .from("users")
                  .select("id")
                  .eq(
                    "telegram_user_id",
                    callbackTelegramUserId
                  )
                  .maybeSingle();

              if (error || !player) {
                throw new Error(
                  "TELEGRAM_ACCOUNT_NOT_LINKED"
                );
              }

              const result =
                await upgradeCountry(
                  player.id,
                  countryId
                );

              console.log(
                "Country upgraded:",
                result
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "✅ Upgrade successful!"
              );

              if (
                callbackChatId !== undefined
              ) {
                const upgradedCountry =
                  await supabase
                    .from("countries")
                    .select(
                      "name,current_price,hourly_income,upgrade_level"
                    )
                    .eq("id", countryId)
                    .maybeSingle();

                const country =
                  upgradedCountry.data;

                await sendMessage(
                  callbackChatId,
                  `🎉 Country upgraded successfully!\n\n` +
                  `🌍 ${country?.name ?? "Country"}\n` +
                  `📈 New Level: ${Number(
                    country?.upgrade_level ?? 0
                  )}\n` +
                  `💵 New Value: $${Number(
                    country?.current_price ?? 0
                  ).toFixed(2)}\n` +
                  `💰 New Income: $${Number(
                    country?.hourly_income ?? 0
                  ).toFixed(2)}/hour\n\n` +
                  `🏗️ Your country has been upgraded successfully.`,
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Country upgrade error:",
                error
              );

              let message =
                "❌ I couldn't upgrade this country.";

              const errorMessage =
                error instanceof Error
                  ? error.message
                  : String(error);

              if (
                errorMessage.includes(
                  "INSUFFICIENT_AVAILABLE_BALANCE"
                )
              ) {
                message =
                  "❌ You don't have enough available balance for this upgrade.";
              } else if (
                errorMessage.includes(
                  "COUNTRY_NOT_FOUND"
                )
              ) {
                message =
                  "❌ This country could not be found.";
              } else if (
                errorMessage.includes(
                  "NOT_COUNTRY_OWNER"
                )
              ) {
                message =
                  "❌ You don't own this country.";
              } else if (
                errorMessage.includes(
                  "MAX_LEVEL"
                )
              ) {
                message =
                  "🏆 This country is already at the maximum level.";
              }

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Upgrade failed."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  message,
                  mainMenu()
                );
              }
            }

            continue;
          }

          if (
            callbackData === "cancel_upgrade"
          ) {
            await answerCallbackQuery(
              callbackQuery.id,
              "Upgrade cancelled."
            );

            if (callbackChatId !== undefined) {
              await sendMessage(
                callbackChatId,
                "❌ Upgrade cancelled.",
                mainMenu()
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "market_page:"
            )
          ) {
            const pageText =
              callbackData.substring(
                "market_page:".length
              );

            const page =
              Number(pageText);

            const countries =
              await getMarketCountries();

            const pageSize = 8;

            const totalPages =
              Math.ceil(
                countries.length / pageSize
              );

            if (
              !Number.isInteger(page) ||
              page < 0 ||
              page >= totalPages
            ) {
              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Invalid market page."
              );

              continue;
            }

            const start =
              page * pageSize;

            const pageCountries =
              countries.slice(
                start,
                start + pageSize
              );

            let marketMessage =
              `🏪 MARKET — Page ${page + 1}/${totalPages}\n\n`;

            const buttons: unknown[][] = [];

            for (const country of pageCountries) {
              const price =
                Number(country.current_price);

              const income =
                Number(country.hourly_income);

              const level =
                Number(country.upgrade_level);

              const code =
                country.code
                  ? `🌐 ${country.code}`
                  : "🌍";

              marketMessage +=
                `${code} ${country.name}\n` +
                `💵 Price: $${price.toFixed(2)}\n` +
                `📈 Level: ${level}\n` +
                `💰 Income: $${income.toFixed(2)}/hour\n\n`;

              buttons.push([
                {
                  text: `🛒 Buy ${country.name}`,
                  callback_data:
                    `buy_country:${country.id}`,
                },
              ]);
            }

            const navigationButtons: unknown[] = [];

            if (page > 0) {
              navigationButtons.push({
                text: "◀️ Previous",
                callback_data:
                  `market_page:${page - 1}`,
              });
            }

            if (page < totalPages - 1) {
              navigationButtons.push({
                text: "Next ▶️",
                callback_data:
                  `market_page:${page + 1}`,
              });
            }

            if (navigationButtons.length > 0) {
              buttons.push(navigationButtons);
            }

            if (
              callbackChatId !== undefined &&
              callbackMessageId !== undefined
            ) {
              await editMessage(
                callbackChatId,
                callbackMessageId,
                marketMessage,
                buttons
              );
            }

            await answerCallbackQuery(
              callbackQuery.id
            );

            continue;
          }
          if (
            callbackData?.startsWith(
              "buy_country:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "buy_country:".length
              );

            try {
              const { data: country, error } =
                await supabase
                  .from("countries")
                  .select(
                    "id,name,code,current_price,hourly_income,upgrade_level"
                  )
                  .eq("id", countryId)
                  .single();

              if (error || !country) {
                throw new Error(
                  "COUNTRY_NOT_FOUND"
                );
              }

              await answerCallbackQuery(
                callbackQuery.id
              );

              if (
                callbackChatId !== undefined
              ) {
                await telegramRequest(
                  "sendMessage",
                  {
                    chat_id: callbackChatId,
                    text:
                      `🛒 ${country.name}\n\n` +
                      `💵 Price: $${Number(country.current_price).toFixed(2)}\n` +
                      `📈 Level: ${Number(country.upgrade_level)}\n` +
                      `💰 Income: $${Number(country.hourly_income).toFixed(2)}/hour\n\n` +
                      `Are you sure you want to buy ${country.name}?`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "✅ Confirm Purchase",
                            callback_data:
                              `confirm_buy:${country.id}`,
                          },
                          {
                            text: "❌ Cancel",
                            callback_data:
                              "cancel_buy",
                          },
                        ],
                      ],
                    },
                  }
                );
              }
            } catch (error) {
              console.error(
                "Purchase confirmation error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Unable to load country"
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "confirm_buy:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "confirm_buy:".length
              );

            try {
              const result =
                await purchaseCountry(
                  callbackTelegramUserId,
                  countryId
                );

              await answerCallbackQuery(
                callbackQuery.id,
                "✅ Purchase successful!"
              );

              if (
                callbackChatId !== undefined
              ) {
                const { data: country } =
                  await supabase
                    .from("countries")
                    .select(
                      "name,current_price,hourly_income"
                    )
                    .eq("id", countryId)
                    .maybeSingle();

                const countryName =
                  country?.name ?? "country";

                const price =
                  Number(
                    country?.current_price ?? 0
                  );

                await sendMessage(
                  callbackChatId,
                  `🎉 Country purchased successfully!\n\n` +
                  `🌍 ${countryName}\n` +
                  `💵 Purchase price: $${price.toFixed(2)}\n\n` +
                  `You now own this country and will receive its hourly income.`,
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Country purchase error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Purchase failed."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ I couldn't complete this purchase.\n\n" +
                  "The country may already be owned or you may not have enough available balance.",
                  mainMenu()
                );
              }
            }

            continue;
          }

          if (
            callbackData === "cancel_buy"
          ) {
            await answerCallbackQuery(
              callbackQuery.id,
              "Purchase cancelled."
            );

            if (
              callbackChatId !== undefined
            ) {
              await sendMessage(
                callbackChatId,
                "❌ Purchase cancelled.",
                mainMenu()
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "sell_country:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "sell_country:".length
              );

            try {
              const { data: country, error } =
                await supabase
                  .from("countries")
                  .select(
                    "id,name,current_price,hourly_income,upgrade_level,owner_id"
                  )
                  .eq("id", countryId)
                  .single();

              if (error || !country) {
                throw new Error(
                  "COUNTRY_NOT_FOUND"
                );
              }

              const { data: player, error: playerError } =
                await supabase
                  .from("users")
                  .select("id")
                  .eq(
                    "telegram_user_id",
                    callbackTelegramUserId
                  )
                  .maybeSingle();

              if (playerError || !player) {
                throw new Error(
                  "TELEGRAM_ACCOUNT_NOT_LINKED"
                );
              }

              if (country.owner_id !== player.id) {
                await answerCallbackQuery(
                  callbackQuery.id,
                  "❌ You don't own this country."
                );

                continue;
              }

              await answerCallbackQuery(
                callbackQuery.id
              );

              if (
                callbackChatId !== undefined
              ) {
                await telegramRequest(
                  "sendMessage",
                  {
                    chat_id: callbackChatId,
                    text:
                      `🏷️ Sell ${country.name}\n\n` +
                      `🌍 ${country.name}\n` +
                      `💵 Current value: $${Number(
                        country.current_price
                      ).toFixed(2)}\n` +
                      `📈 Level: ${Number(
                        country.upgrade_level
                      )}\n` +
                      `💰 Income: $${Number(
                        country.hourly_income
                      ).toFixed(2)}/hour\n\n` +
                      `Are you sure you want to sell this country?`,
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "✅ Confirm Sale",
                            callback_data:
                              `confirm_sell:${country.id}`,
                          },
                          {
                            text: "❌ Cancel",
                            callback_data:
                              "cancel_sell",
                          },
                        ],
                      ],
                    },
                  }
                );
              }
            } catch (error) {
              console.error(
                "Sell country confirmation error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Unable to load country."
              );
            }

            continue;
          }
          if (
            callbackData?.startsWith(
              "confirm_sell:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "confirm_sell:".length
              );

            try {
              const { data: player, error } =
                await supabase
                  .from("users")
                  .select("id")
                  .eq(
                    "telegram_user_id",
                    callbackTelegramUserId
                  )
                  .maybeSingle();

              if (error || !player) {
                throw new Error(
                  "TELEGRAM_ACCOUNT_NOT_LINKED"
                );
              }

              const result =
                await sellCountry(
                  player.id,
                  countryId
                );

              await answerCallbackQuery(
                callbackQuery.id,
                "✅ Country sold!"
              );

              if (
                callbackChatId !== undefined
              ) {
                const { data: country } =
                  await supabase
                    .from("countries")
                    .select(
                      "name,current_price"
                    )
                    .eq("id", countryId)
                    .maybeSingle();

                const countryName =
                  country?.name ?? "country";

                const salePrice =
                  Number(
                    country?.current_price ?? 0
                  );

                await sendMessage(
                  callbackChatId,
                  `💰 Country sold successfully!\n\n` +
                  `🌍 ${countryName}\n` +
                  `💵 Sale value: $${salePrice.toFixed(2)}\n\n` +
                  `The country is now available in the market.`,
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Country sale error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Sale failed."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ I couldn't sell this country.\n\n" +
                  "The country may no longer be owned by you.",
                  mainMenu()
                );
              }
            }

            continue;
          }
          if (
            callbackData === "cancel_sell"
          ) {
            await answerCallbackQuery(
              callbackQuery.id,
              "Sale cancelled."
            );

            if (
              callbackChatId !== undefined
            ) {
              await sendMessage(
                callbackChatId,
                "❌ Sale cancelled.",
                mainMenu()
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "reject_offer:"
            )
          ) {
            const offerId =
              callbackData.substring(
                "reject_offer:".length
              );

            try {
              const result =
                await rejectCountryOffer(
                  callbackTelegramUserId,
                  offerId
                );

              console.log(
                "Country offer rejected:",
                result
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Offer rejected."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ Offer rejected successfully.\n\n" +
                  "💳 The buyer's reserved money has been released.",
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Reject offer error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Could not reject offer."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ I couldn't reject this offer.\n\n" +
                  "The offer may have expired, already been accepted, rejected, or cancelled.",
                  mainMenu()
                );
              }
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "cancel_offer:"
            )
          ) {
            const offerId =
              callbackData.substring(
                "cancel_offer:".length
              );

            try {
              const buyer = await findUserByTelegramId(
                callbackTelegramUserId
              );

              if (!buyer) {
                throw new Error("PLAYER_NOT_FOUND");
              }

              const result =
                await cancelCountryOffer(
                  buyer.id,
                  offerId
                );

              console.log(
                "Country offer cancelled:",
                result
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "✅ Offer cancelled."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ Offer cancelled successfully.\n\n" +
                  "The reserved money has been released.",
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Cancel offer error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Could not cancel offer."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  "❌ I couldn't cancel this offer.\n\n" +
                  "It may have already been accepted, cancelled, or expired.",
                  mainMenu()
                );
              }
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "make_offer:"
            )
          ) {
            const countryId =
              callbackData.substring(
                "make_offer:".length
              );

            try {
              const { data: country, error } =
                await supabase
                  .from("countries")
                  .select(
                    "id,name,current_price,owner_id"
                  )
                  .eq("id", countryId)
                  .single();

              if (error || !country) {
                throw new Error(
                  "COUNTRY_NOT_FOUND"
                );
              }

              await answerCallbackQuery(
                callbackQuery.id
              );

              pendingOfferCountry.set(
                callbackTelegramUserId,
                country.id
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  `💰 Make an offer for ${country.name}\n\n` +
                  `Current value: $${Number(
                    country.current_price
                  ).toFixed(2)}\n\n` +
                  `Please enter your offer amount.\n\n` +
                  `Example:\n25000`
                );
              }
            } catch (error) {
              console.error(
                "Make offer error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Unable to create offer"
              );
            }

            continue;
          }

          if (
            callbackData?.startsWith(
              "market:"
            )
          ) {
            const parts =
              callbackData.split(":");

            const availablePage =
              Number(parts[1]);

            const playerPage =
              Number(parts[2]);

            if (
              !Number.isInteger(
                availablePage
              ) ||
              !Number.isInteger(
                playerPage
              )
            ) {
              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Invalid page."
              );

              continue;
            }

            try {
              await answerCallbackQuery(
                callbackQuery.id
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMarketPage(
                  callbackChatId,
                  callbackTelegramUserId,
                  availablePage,
                  playerPage
                );
              }
            } catch (error) {
              console.error(
                "Market pagination error:",
                error
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Unable to load page."
              );
            }

            continue;
          }

          if (
            callbackData ===
            "market_noop"
          ) {
            await answerCallbackQuery(
              callbackQuery.id
            );

            continue;
          }

          if (
            callbackData ===
            "confirm_offer"
          ) {
            const countryId =
              pendingOfferCountry.get(
                callbackTelegramUserId
              );

            const price =
              pendingOfferPrice.get(
                callbackTelegramUserId
              );

            if (!countryId || price === undefined) {
              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Offer session expired."
              );

              continue;
            }

            try {
              const result =
                await createPlayerCountryOffer(
                  callbackTelegramUserId,
                  countryId,
                  price
                );

              pendingOfferCountry.delete(
                callbackTelegramUserId
              );

              pendingOfferPrice.delete(
                callbackTelegramUserId
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "✅ Offer sent!"
              );

              if (
                callbackChatId !== undefined
              ) {
                const expiresAt =
                  result?.expiresAt
                    ? new Date(result.expiresAt).toLocaleString(
                      "en-GB",
                      {
                        timeZone: "Africa/Cairo",
                        hour12: false,
                      }
                    )
                    : "soon";
                await sendMessage(
                  callbackChatId,
                  `📩 Offer sent successfully!\n\n` +
                  `🌍 ${result?.country ?? "Country"}\n` +
                  `💰 Offer: $${Number(
                    result?.price ?? price
                  ).toFixed(2)}\n\n` +
                  `💳 The amount has been reserved.\n` +
                  `⏰ Expires: ${expiresAt}`,
                  mainMenu()
                );
              }
            } catch (error) {
              console.error(
                "Create offer error:",
                error
              );

              pendingOfferCountry.delete(
                callbackTelegramUserId
              );

              pendingOfferPrice.delete(
                callbackTelegramUserId
              );

              await answerCallbackQuery(
                callbackQuery.id,
                "❌ Offer failed."
              );

              if (
                callbackChatId !== undefined
              ) {
                await sendMessage(
                  callbackChatId,
                  `❌ Couldn't create the offer.\n\n` +
                  `${formatOfferError(error)}`,
                  mainMenu()
                );
              }
            }

            continue;
          }

          if (
            callbackData ===
            "cancel_offer_input"
          ) {
            pendingOfferCountry.delete(
              callbackTelegramUserId
            );

            pendingOfferPrice.delete(
              callbackTelegramUserId
            );

            await answerCallbackQuery(
              callbackQuery.id,
              "Offer cancelled."
            );

            if (
              callbackChatId !== undefined
            ) {
              await sendMessage(
                callbackChatId,
                "❌ Offer creation cancelled.",
                mainMenu()
              );
            }

            continue;
          }
        }
        function formatOfferError(
          error: unknown
        ) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          if (
            message.includes(
              "PRICE_BELOW_MINIMUM"
            )
          ) {
            return (
              "❌ Your offer is below the allowed minimum price.\n\n" +
              "Please enter an offer within the allowed price range."
            );
          }

          if (
            message.includes(
              "PRICE_ABOVE_MAXIMUM"
            )
          ) {
            return (
              "❌ Your offer is above the allowed maximum price.\n\n" +
              "Please enter an offer within the allowed price range."
            );
          }

          if (
            message.includes(
              "INSUFFICIENT_AVAILABLE_BALANCE"
            )
          ) {
            return (
              "❌ You don't have enough available balance."
            );
          }

          if (
            message.includes(
              "CANNOT_OFFER_ON_OWN_COUNTRY"
            )
          ) {
            return (
              "❌ You cannot make an offer on your own country."
            );
          }

          if (
            message.includes(
              "COUNTRY_NOT_OWNED"
            )
          ) {
            return (
              "❌ This country is not currently owned by another player."
            );
          }

          return (
            "❌ Something went wrong while creating the offer.\n\n" +
            "Please try again."
          );
        }


        const message =
          update.message;

        if (!message?.text) {
          continue;
        }

        const chatId =
          message.chat.id;

        const telegramUserId =
          message.from?.id;

        if (!telegramUserId) {
          continue;
        }

        const telegramUsername =
          message.from?.username;

        const text =
          message.text.trim();

        /*
 * /start
 */
        if (text === "/start") {
          const existingUser =
            await findUserByTelegramId(
              telegramUserId
            );

          if (existingUser) {
            await sendMessage(
              chatId,
              `🎮 Welcome back, ${existingUser.name}!`,
              mainMenu()
            );

            registrationState.delete(
              telegramUserId
            );

            pendingRegistrationPhones.delete(
              telegramUserId
            );

            continue;
          }

          /*
           * New Telegram user:
           * first ask for their phone number.
           */
          registrationState.set(
            telegramUserId,
            "phone"
          );

          pendingRegistrationPhones.delete(
            telegramUserId
          );

          await sendMessage(
            chatId,
            "🎮 Welcome to Mission Impossible!\n\n" +
            "Let's create your game account.\n\n" +
            "Please send your phone number.\n\n" +
            "Example:\n" +
            "201000000001"
          );

          continue;
        }

        /*
         * Registration
         */
        const registrationStep =
          registrationState.get(
            telegramUserId
          );

        if (registrationStep === "phone") {
          let phone =
            text.replace(/\D/g, "");

          if (phone.startsWith("00")) {
            phone = phone.substring(2);
          }

          if (
            phone.length < 10 ||
            phone.length > 15
          ) {
            await sendMessage(
              chatId,
              "❌ Invalid phone number.\n\n" +
              "Please send a valid phone number."
            );

            continue;
          }

          const existingUser =
            await findUserByPhone(phone);

          if (existingUser) {
            /*
             * Existing game account:
             * link this Telegram account.
             */

            if (
              existingUser.telegram_user_id &&
              existingUser.telegram_user_id !==
              telegramUserId
            ) {
              await sendMessage(
                chatId,
                "❌ This game account is already linked to another Telegram account."
              );

              registrationState.delete(
                telegramUserId
              );

              continue;
            }

            await linkTelegramAccount(
              existingUser.id,
              telegramUserId,
              telegramUsername
            );

            registrationState.delete(
              telegramUserId
            );

            await sendMessage(
              chatId,
              `🎉 Welcome, ${existingUser.name}! 🎮\n\n` +
              "Your Telegram account has been linked successfully.",
              mainMenu()
            );

            continue;
          }

          /*
           * New player:
           * phone is not registered,
           * so ask for the player's name.
           */

          pendingRegistrationPhones.set(
            telegramUserId,
            phone
          );

          registrationState.set(
            telegramUserId,
            "name"
          );

          console.log(
            "Registration waiting for name:",
            {
              telegramUserId,
              phone,
              step: registrationState.get(
                telegramUserId
              ),
            }
          );

          await sendMessage(
            chatId,
            "🎉 Great! We couldn't find an existing game account, so let's create one.\n\n" +
            "Please enter your player name.\n\n" +
            "This is the name that will appear in the game and leaderboard."
          );

          continue;
        }
        if (registrationStep === "name") {
          const phone =
            pendingRegistrationPhones.get(
              telegramUserId
            );

          console.log(
            "Name registration:",
            {
              telegramUserId,
              phone,
              step: registrationStep,
            }
          );

          if (!phone) {
            registrationState.delete(
              telegramUserId
            );

            await sendMessage(
              chatId,
              "⚠️ Your registration session expired.\n\n" +
              "Please send /start to register again."
            );

            continue;
          }

          const name = text.trim();

          if (
            name.length < 2 ||
            name.length > 50
          ) {
            await sendMessage(
              chatId,
              "❌ Invalid name.\n\n" +
              "Please enter a name between 2 and 50 characters."
            );

            continue;
          }

          try {
            const newUser =
              await createUserFromTelegram(
                phone,
                name,
                telegramUserId,
                telegramUsername
              );

            pendingRegistrationPhones.delete(
              telegramUserId
            );

            registrationState.delete(
              telegramUserId
            );

            await sendMessage(
              chatId,
              `🎉 Account created successfully!\n\n` +
              `Welcome, ${newUser.name}! 🎮\n\n` +
              `💰 Starting balance: $${Number(
                newUser.balance
              ).toFixed(2)}\n\n` +
              "Your Telegram account is now linked to your game account.",
              mainMenu()
            );

            continue;
          } catch (error) {
            console.error(
              "Registration error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ I couldn't create your account.\n\n" +
              "Please try again."
            );

            continue;
          }
        }

        const pendingCountryId =
          pendingOfferCountry.get(
            telegramUserId
          );

        if (pendingCountryId) {
          const priceText =
            text.replace(/[$,\s]/g, "");

          const price =
            Number(priceText);

          if (
            !Number.isFinite(price) ||
            price <= 0
          ) {
            await sendMessage(
              chatId,
              "❌ Invalid offer amount.\n\n" +
              "Please enter a positive number.\n\n" +
              "Example: 25000"
            );

            continue;
          }

          try {
            const { data: country, error } =
              await supabase
                .from("countries")
                .select(
                  "id,name,current_price"
                )
                .eq("id", pendingCountryId)
                .single();

            if (error || !country) {
              throw new Error(
                "COUNTRY_NOT_FOUND"
              );
            }

            const { data: marketSettings, error: settingsError } =
              await supabase
                .from("market_settings")
                .select(
                  "min_price_percent,max_price_percent"
                )
                .eq("id", 1)
                .single();

            if (settingsError || !marketSettings) {
              throw new Error(
                "MARKET_SETTINGS_NOT_FOUND"
              );
            }

            const currentPrice =
              Number(country.current_price);

            const minimumPrice =
              currentPrice *
              Number(
                marketSettings.min_price_percent
              );

            const maximumPrice =
              currentPrice *
              Number(
                marketSettings.max_price_percent
              );

            const { data: player } =
              await supabase
                .from("users")
                .select(
                  "id,balance,reserved_balance"
                )
                .eq(
                  "telegram_user_id",
                  telegramUserId
                )
                .maybeSingle();

            if (!player) {
              throw new Error(
                "TELEGRAM_ACCOUNT_NOT_LINKED"
              );
            }

            if (price < minimumPrice) {
              await sendMessage(
                chatId,
                `❌ OFFER TOO LOW\n\n` +
                `🌍 ${country.name}\n` +
                `💵 Current value: $${currentPrice.toFixed(2)}\n\n` +
                `Your offer: $${price.toFixed(2)}\n\n` +
                `📉 Minimum allowed: $${minimumPrice.toFixed(2)}\n` +
                `📈 Maximum allowed: $${maximumPrice.toFixed(2)}\n\n` +
                `Please enter an amount within this range.`
              );

              continue;
            }

            if (price > maximumPrice) {
              await sendMessage(
                chatId,
                `❌ OFFER TOO HIGH\n\n` +
                `🌍 ${country.name}\n` +
                `💵 Current value: $${currentPrice.toFixed(2)}\n\n` +
                `Your offer: $${price.toFixed(2)}\n\n` +
                `📉 Minimum allowed: $${minimumPrice.toFixed(2)}\n` +
                `📈 Maximum allowed: $${maximumPrice.toFixed(2)}\n\n` +
                `Please enter an amount within this range.`
              );

              continue;
            }

            const available =
              Number(player.balance ?? 0) -
              Number(player.reserved_balance ?? 0);

            if (available < price) {
              await sendMessage(
                chatId,
                `❌ Insufficient available balance.\n\n` +
                `Your available balance: $${available.toFixed(2)}\n` +
                `Your offer: $${price.toFixed(2)}`
              );

              pendingOfferCountry.delete(
                telegramUserId
              );

              continue;
            }

            await telegramRequest(
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  `📩 Offer Preview\n\n` +
                  `🌍 ${country.name}\n` +
                  `💵 Current value: $${Number(
                    country.current_price
                  ).toFixed(2)}\n` +
                  `💰 Your offer: $${price.toFixed(2)}\n\n` +
                  `If you confirm, this amount will be reserved from your balance.`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "✅ Confirm Offer",
                        callback_data:
                          "confirm_offer",
                      },
                      {
                        text: "❌ Cancel",
                        callback_data:
                          "cancel_offer_input",
                      },
                    ],
                  ],
                },
              }
            );

            /*
             * Store the price temporarily using a
             * second map.
             */

            pendingOfferPrice.set(
              telegramUserId,
              price
            );

            continue;
          } catch (error) {
            console.error(
              "Offer preparation error:",
              error
            );

            pendingOfferCountry.delete(
              telegramUserId
            );

            await sendMessage(
              chatId,
              "❌ I couldn't prepare this offer.\n\n" +
              "Please try again."
            );

            continue;
          }
        }

        if (text === "🔨 Upgrade Country") {
          try {
            const result = await getPlayerCountries(
              telegramUserId
            );

            if (!result) {
              await sendMessage(
                chatId,
                "❌ Your Telegram account is not linked to a game account.",
                mainMenu()
              );

              continue;
            }

            const { countries } = result;

            if (countries.length === 0) {
              await sendMessage(
                chatId,
                "🔨 UPGRADE COUNTRY\n\n" +
                "You don't own any countries yet.\n\n" +
                "Buy a country first from 🏪 Market.",
                mainMenu()
              );

              continue;
            }

            let message =
              "🔨 UPGRADE COUNTRY\n\n" +
              "Choose a country to upgrade:\n\n";

            const buttons: unknown[][] = [];

            for (const country of countries) {
              const level = Number(
                country.upgrade_level ?? 1
              );

              if (level >= 5) {
                message +=
                  `🌍 ${country.name}\n` +
                  `📈 Level: ${level} — MAX LEVEL\n\n`;

                continue;
              }

              const nextLevel = level + 1;

              const { data: building, error } =
                await supabase
                  .from("building_levels")
                  .select(
                    "level,building_name,upgrade_cost,value_increase,income_increase"
                  )
                  .eq("level", nextLevel)
                  .maybeSingle();

              if (error) {
                throw error;
              }

              if (!building) {
                message +=
                  `🌍 ${country.name}\n` +
                  `📈 Level: ${level}\n` +
                  `⚠️ Upgrade configuration unavailable.\n\n`;

                continue;
              }

              message +=
                `🌍 ${country.name}\n` +
                `📈 Current Level: ${level}\n` +
                `🏗️ Next: ${building.building_name}\n` +
                `💵 Cost: $${Number(
                  building.upgrade_cost
                ).toFixed(2)}\n` +
                `📊 Value: +$${Number(
                  building.value_increase
                ).toFixed(2)}\n` +
                `💰 Income: +$${Number(
                  building.income_increase
                ).toFixed(2)}/hour\n\n`;

              buttons.push([
                {
                  text: `🔨 Upgrade ${country.name}`,
                  callback_data:
                    `upgrade_country:${country.id}`,
                },
              ]);
            }

            await telegramRequest(
              "sendMessage",
              {
                chat_id: chatId,
                text: message,
                reply_markup: {
                  inline_keyboard: buttons,
                },
              }
            );
          } catch (error) {
            console.error(
              "Upgrade country menu error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ Unable to load upgrade options right now.",
              mainMenu()
            );
          }

          continue;
        }

        if (text === "💰 My Balance") {
          const player =
            await getPlayerBalance(
              telegramUserId
            );

          if (!player) {
            await sendMessage(
              chatId,
              "❌ Your Telegram account is not linked to a game account.",
              mainMenu()
            );

            continue;
          }

          try {
            // Collect any pending country income.
            await collectPlayerIncome(
              player.id
            );

            // Get the fresh balance after income collection.
            const updatedPlayer =
              await getPlayerBalance(
                telegramUserId
              );

            if (!updatedPlayer) {
              throw new Error(
                "PLAYER_NOT_FOUND"
              );
            }

            const balance =
              Number(updatedPlayer.balance ?? 0);

            const reserved =
              Number(
                updatedPlayer.reserved_balance ?? 0
              );

            const total =
              balance + reserved;

            await sendMessage(
              chatId,
              `💰 My Balance\n\n` +
              `Available: $${balance.toFixed(2)}\n` +
              `Reserved: $${reserved.toFixed(2)}\n` +
              `Total: $${total.toFixed(2)}`,
              mainMenu()
            );
          } catch (error) {
            console.error(
              "Balance error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ I couldn't load your balance right now.\n\nPlease try again.",
              mainMenu()
            );
          }

          continue;
        }

        if (text === "🌍 My Countries") {
          const result =
            await getPlayerCountries(
              telegramUserId
            );

          if (!result) {
            await sendMessage(
              chatId,
              "❌ Your Telegram account is not linked to a game account.",
              mainMenu()
            );

            continue;
          }

          const { countries } = result;

          if (countries.length === 0) {
            await sendMessage(
              chatId,
              "🌍 My Countries\n\n" +
              "You don't own any countries yet.\n\n" +
              "Visit 🏪 Market to find a country to buy.",
              mainMenu()
            );

            continue;
          }

          let message =
            "🌍 MY COUNTRIES\n\n";

          let totalHourlyIncome = 0;
          let totalValue = 0;

          const buttons: unknown[][] = [];

          for (const country of countries) {
            const price =
              Number(country.current_price);

            const income =
              Number(country.hourly_income);

            const level =
              Number(country.upgrade_level);

            totalValue += price;
            totalHourlyIncome += income;

            const flag =
              country.code
                ? `🌐 ${country.code}`
                : "🌍";

            message +=
              `${flag} ${country.name}\n` +
              `💵 Value: $${price.toFixed(2)}\n` +
              `📈 Level: ${level}\n` +
              `💰 Income: $${income.toFixed(2)}/hour\n\n`;

            buttons.push([
              {
                text: `💰 Sell ${country.name}`,
                callback_data:
                  `sell_country:${country.id}`,
              },
              {
                text: `📩 Offers ${country.name}`,
                callback_data:
                  `country_offers:${country.id}`,
              },
            ]);
          }

          message +=
            "━━━━━━━━━━━━━━\n" +
            `🌍 Countries: ${countries.length}\n` +
            `💵 Total value: $${totalValue.toFixed(2)}\n` +
            `💰 Hourly income: $${totalHourlyIncome.toFixed(2)}`;

          await telegramRequest(
            "sendMessage",
            {
              chat_id: chatId,
              text: message,
              reply_markup: {
                inline_keyboard: buttons,
              },
            }
          );

          continue;
        }

        if (text === "📊 Leaderboard") {
          try {
            const leaderboard =
              await getLeaderboard();

            if (
              !leaderboard ||
              leaderboard.length === 0
            ) {
              await sendMessage(
                chatId,
                "📊 Leaderboard\n\n" +
                "No players found yet.",
                mainMenu()
              );

              continue;
            }

            let message =
              "🏆 LEADERBOARD\n\n";

            for (
              let i = 0;
              i < leaderboard.length;
              i++
            ) {
              const player =
                leaderboard[i];

              const rank =
                Number(
                  player.rank ?? i + 1
                );

              const name =
                player.name ??
                "Unknown Player";

              const netWorth =
                Number(
                  player.net_worth ??
                  player.total_value ??
                  0
                );

              let medal = "";

              if (rank === 1) {
                medal = "🥇 ";
              } else if (rank === 2) {
                medal = "🥈 ";
              } else if (rank === 3) {
                medal = "🥉 ";
              }

              message +=
                `${medal}${rank}. ${name}\n` +
                `💰 Net Worth: $${netWorth.toFixed(2)}\n\n`;
            }

            await sendMessage(
              chatId,
              message,
              mainMenu()
            );
          } catch (error) {
            console.error(
              "Leaderboard error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ Unable to load the leaderboard right now.",
              mainMenu()
            );
          }

          continue;
        }

        if (text === "🏪 Market") {
          try {
            await sendMarketPage(
              chatId,
              telegramUserId,
              0,
              0
            );
          } catch (error) {
            console.error(
              "Market error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ Unable to load the market right now.",
              mainMenu()
            );
          }

          continue;
        }

        if (text === "📩 My Offers") {
          try {
            const result =
              await getPlayerOffers(
                telegramUserId
              );

            if (!result) {
              await sendMessage(
                chatId,
                "❌ Your Telegram account is not linked.",
                mainMenu()
              );

              continue;
            }

            const {
              receivedOffers,
              sentOffers,
            } = result;

            let message =
              "📩 MY OFFERS\n\n";

            const buttons: unknown[][] = [];

            /*
             * ==========================================
             * OFFERS I RECEIVED
             * ==========================================
             */

            message +=
              "📥 OFFERS RECEIVED\n\n";

            if (
              receivedOffers.length === 0
            ) {
              message +=
                "You have no offers on your countries.\n\n";
            } else {
              for (
                const offer of receivedOffers
              ) {
                const countryData =
                  offer.countries as
                  | {
                    name?: string;
                    code?: string;
                    current_price?: number;
                  }
                  | {
                    name?: string;
                    code?: string;
                    current_price?: number;
                  }[]
                  | null;

                const country =
                  Array.isArray(countryData)
                    ? countryData[0]
                    : countryData;

                const buyerData =
                  offer.buyer as
                  | {
                    id?: string;
                    name?: string;
                  }
                  | {
                    id?: string;
                    name?: string;
                  }[]
                  | null;

                const buyer =
                  Array.isArray(buyerData)
                    ? buyerData[0]
                    : buyerData;

                const countryName =
                  country?.name ??
                  "Unknown country";

                const buyerName =
                  buyer?.name ??
                  "Unknown player";

                const price =
                  Number(offer.price);

                const status =
                  String(offer.status)
                    .toLowerCase();

                message +=
                  `🌍 ${countryName}\n` +
                  `👤 From: ${buyerName}\n` +
                  `💰 Offer: $${price.toFixed(2)}\n` +
                  `📌 Status: ${status.toUpperCase()}\n`;

                if (
                  offer.expires_at
                ) {
                  const expiresAt =
                    new Date(
                      offer.expires_at
                    ).toLocaleString(
                      "en-GB",
                      {
                        timeZone:
                          "Africa/Cairo",
                        hour12: false,
                      }
                    );

                  message +=
                    `⏰ Expires: ${expiresAt}\n`;
                }

                message += "\n";

                if (
                  status === "active"
                ) {
                  buttons.push([
                    {
                      text:
                        `✅ Accept — ${countryName}`,
                      callback_data:
                        `accept_offer:${offer.id}`,
                    },
                    {
                      text:
                        `❌ Reject`,
                      callback_data:
                        `reject_offer:${offer.id}`,
                    },
                  ]);
                }
              }
            }

            message +=
              "━━━━━━━━━━━━━━\n\n";

            /*
             * ==========================================
             * OFFERS I MADE
             * ==========================================
             */

            message +=
              "📤 OFFERS I MADE\n\n";

            if (
              sentOffers.length === 0
            ) {
              message +=
                "You haven't made any offers yet.\n\n";
            } else {
              for (
                const offer of sentOffers
              ) {
                const countryData =
                  offer.countries as
                  | {
                    name?: string;
                    code?: string;
                    current_price?: number;
                  }
                  | {
                    name?: string;
                    code?: string;
                    current_price?: number;
                  }[]
                  | null;

                const country =
                  Array.isArray(countryData)
                    ? countryData[0]
                    : countryData;

                const sellerData =
                  offer.seller as
                  | {
                    id?: string;
                    name?: string;
                  }
                  | {
                    id?: string;
                    name?: string;
                  }[]
                  | null;

                const seller =
                  Array.isArray(sellerData)
                    ? sellerData[0]
                    : sellerData;

                const countryName =
                  country?.name ??
                  "Unknown country";

                const sellerName =
                  seller?.name ??
                  "Unknown player";

                const price =
                  Number(offer.price);

                const status =
                  String(offer.status)
                    .toLowerCase();

                message +=
                  `🌍 ${countryName}\n` +
                  `👤 Owner: ${sellerName}\n` +
                  `💰 Your offer: $${price.toFixed(2)}\n` +
                  `📌 Status: ${status.toUpperCase()}\n`;

                if (
                  offer.expires_at &&
                  status === "active"
                ) {
                  const expiresAt =
                    new Date(
                      offer.expires_at
                    ).toLocaleString(
                      "en-GB",
                      {
                        timeZone:
                          "Africa/Cairo",
                        hour12: false,
                      }
                    );

                  message +=
                    `⏰ Expires: ${expiresAt}\n`;
                }

                message += "\n";

                if (
                  status === "active"
                ) {
                  buttons.push([
                    {
                      text:
                        `❌ Cancel — ${countryName}`,
                      callback_data:
                        `cancel_offer:${offer.id}`,
                    },
                  ]);
                }
              }
            }

            if (
              buttons.length === 0
            ) {
              buttons.push([
                {
                  text: "🔄 Refresh",
                  callback_data:
                    "refresh_my_offers",
                },
              ]);
            }

            await telegramRequest(
              "sendMessage",
              {
                chat_id: chatId,
                text: message,
                reply_markup: {
                  inline_keyboard:
                    buttons,
                },
              }
            );
          } catch (error) {
            console.error(
              "My Offers error:",
              error
            );

            await sendMessage(
              chatId,
              "❌ Unable to load your offers right now.",
              mainMenu()
            );
          }

          continue;
        }


        /*
* Unknown command/message
*/
        await sendMessage(
          chatId,
          "I don't recognize that command yet.\n\n" +
          "Send /start to begin."
        );
      } // closes for (const update of result.result)
    } catch (error) {
      console.error(
        "Telegram polling error:",
        error
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            3000
          )
      );
    }
  }
}

startTelegramBot();