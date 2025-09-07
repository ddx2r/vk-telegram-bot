// server.js — HTTP-склейка и маршруты

const express = require('express');
const bodyParser = require('body-parser');

const {
  VK_GROUP_ID,
  VK_SECRET_KEY,
  TELEGRAM_CHAT_ID,
  DEBUG_CHAT_ID,
  BOT_VERSION
} = require('./src/config');

const { bot, sendTelegramMessageWithRetry } = require('./src/telegram');
const { registerCommands } = require('./src/commands');
const { shouldProcessEvent, rememberEvent } = require('./src/vk/dedup');
const { handleVkEvent } = require('./src/vk/events');

// Логгер Supabase
const { withRequestId, logMiddlewareTelegram, logMiddlewareVK, logger, logError } = require('./src/lib/logger');

const app = express();
app.use(withRequestId());
app.use(bodyParser.json());

// глобальный аптайм
global.__BOT_STARTED_AT = new Date();

// Регистрация команд
registerCommands(bot);

// Health
app.get('/health', (req, res) => {
  const up = Math.floor((Date.now() - (global.__BOT_STARTED_AT?.getTime() || Date.now())) / 1000);
  res.status(200).json({ ok: true, uptime_sec: up, ts: new Date().toISOString() });
});

// VK webhook
app.post('/webhook', logMiddlewareVK(), async (req, res) => {
  const { type, object, group_id, secret } = req.body || {};
  console.log(`[${new Date().toISOString()}] VK событие: ${type}`);

  // Проверка секрета
  if (secret !== VK_SECRET_KEY) return res.status(403).send('Forbidden');

  // confirmation/шум — быстрый ACK
  if (type === 'confirmation' || type === 'typing_status' || type === 'message_read') {
    return res.send('ok');
  }

  // Быстрый ACK, чтобы VK не ретраил
  res.send('ok');

  try {
    // Дедуп
    if (!shouldProcessEvent({ type, object, group_id })) {
      console.log('Дубликат — пропуск.');
      return;
    }
    rememberEvent({ type, object, group_id });

    // Обработка события
    await handleVkEvent({ type, object });

  } catch (e) {
    console.error('Ошибка обработки VK-события:', e.message);
    if (DEBUG_CHAT_ID) {
      await sendTelegramMessageWithRetry(DEBUG_CHAT_ID, `❌ Ошибка: ${e.message}`);
    }
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] Сервер на порту ${PORT}`);
  // стартовое сообщение в DEBUG
  if (DEBUG_CHAT_ID) {
    const lines = [
      '🟢 Система запущена!',
      `Сообщество: https://vk.com/public${VK_GROUP_ID}`,
      `Версия: ${BOT_VERSION}`,
      `Время: ${new Date().toLocaleString('ru-RU')}`,
      `Основной чат: ${TELEGRAM_CHAT_ID}`
    ];
    await sendTelegramMessageWithRetry(DEBUG_CHAT_ID, lines.join('\n'));ф
  }
});
