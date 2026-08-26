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
      body: body
        ? JSON.stringify(body)
        : undefined,
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
  text: string
) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
  });
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
        offset = update.update_id + 1;

        const message =
          update.message;

        if (!message?.text) {
          continue;
        }

        const chatId =
          message.chat.id;

        if (
          message.text.trim() === "/start"
        ) {
          await sendMessage(
            chatId,
            "🎮 Welcome to Mission Impossible!\n\n" +
              "Your Telegram game bot is connected successfully."
          );
        }
      }
    } catch (error) {
      console.error(
        "Telegram polling error:",
        error
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 3000)
      );
    }
  }
}

startTelegramBot();