import { supabase } from "./supabase.js";
import { buyCountry } from "./game.js";
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
    .select("name,balance,reserved_balance")
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

        if (text === "💰 My Balance") {
          const player =
            await getPlayerBalance(
              telegramUserId
            );



          if (!player) {
            await sendMessage(
              chatId,
              "❌ Your Telegram account is not linked to a game account."
            );

            continue;
          }

          const balance =
            Number(player.balance ?? 0);

          const reserved =
            Number(
              player.reserved_balance ?? 0
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
            "🌍 My Countries\n\n";

          let totalHourlyIncome = 0;
          let totalValue = 0;

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
          }

          message +=
            "━━━━━━━━━━━━━━\n" +
            `🌍 Countries: ${countries.length}\n` +
            `💵 Total value: $${totalValue.toFixed(2)}\n` +
            `💰 Hourly income: $${totalHourlyIncome.toFixed(2)}`;

          await sendMessage(
            chatId,
            message,
            mainMenu()
          );

          continue;
        }

        if (text === "🏪 Market") {
          const countries =
            await getMarketCountries();

          if (countries.length === 0) {
            await sendMessage(
              chatId,
              "🏪 Market\n\n" +
              "There are currently no countries available for purchase.",
              mainMenu()
            );

            continue;
          }

          const pageSize = 8;
          const page = 0;
          const totalPages =
            Math.ceil(countries.length / pageSize);

          const start = page * pageSize;

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

          marketMessage +=
            "━━━━━━━━━━━━━━\n" +
            `Showing ${start + 1}-${Math.min(
              start + pageSize,
              countries.length
            )} of ${countries.length}`;

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