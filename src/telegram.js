// src/telegram.js — инициализация бота и отправка сообщений

const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN, DEBUG_CHAT_ID } = require('./config');

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

async function sendTelegramMessageWithRetry(chatId, text, options = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
      return;
    } catch (err) {
      const msg = `Ошибка sendMessage (${i + 1}/3) в чат ${chatId}: ${err.message}`;
      console.error(msg);
      if (DEBUG_CHAT_ID && String(chatId) !== String(DEBUG_CHAT_ID)) {
        try { await bot.sendMessage(DEBUG_CHAT_ID, `⚠️ ${msg}`); } catch {}
      }
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

module.exports = { bot, sendTelegramMessageWithRetry };
