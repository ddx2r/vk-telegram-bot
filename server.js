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
app.use(bodyParser.json());
app.use(withRequestId());

// глобальный аптайм
global.__BOT_STARTED_AT = new Date();

// Регистрация команд
registerCommands(bot);

// Health
app.get('/health', (req, res) => {
  const up = Math.floor((Date.now() - (global.__BOT_STARTED_AT?.getTime() || Date.now())) / 1000);
  res.status(200).json({ ok: true, uptime_sec: up, ts: new Date().toISOString() });
});

// Telegram webhook
app.post('/telegram', logMiddlewareTelegram(), async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    logError('telegram', 'webhook', err, { payload: req.body });
    res.sendStatus(500);
  }
});

// VK webhook
app.post('/webhook', logMiddlewareVK(), async (req, res) => {
  const { type, object, group_id, secret } = req.body || {};
  if (group_id != VK_GROUP_ID || secret !== VK_SECRET_KEY) {
    logError('vk', 'auth', new Error('bad secret or group id'), { payload: req.body });
    return res.status(403).end('forbidden');
  }
  if (type === 'confirmation') {
    // VK confirmation string (укажи реальную строку подтверждения)
    return res.status(200).send(process.env.VK_CONFIRMATION_STRING || 'confirmation-code');
  }
  try {
    if (shouldProcessEvent(req.body)) {
      await handleVkEvent(type, object);
      rememberEvent(req.body);
    }
    res.status(200).send('ok');
  } catch (err) {
    logError('vk', type || 'webhook', err, { payload: req.body });
    res.status(500).end('error');
  }
});

// Старт сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  // Запишем событие в Supabase
  logger.info({
    source: 'system',
    event: 'boot',
    summary: `Bot v${BOT_VERSION} started`,
    payload: { port: PORT }
  });

  // Отправим уведомление в Telegram
  if (DEBUG_CHAT_ID) {
    try {
      await sendTelegramMessageWithRetry(
        DEBUG_CHAT_ID,
        `🟢 Бот успешно запущен!\nВерсия: ${BOT_VERSION}\nПорт: ${PORT}\nВремя: ${new Date().toISOString()}`
      );
    } catch (err) {
      logError('system', 'notify_startup', err, { chat_id: DEBUG_CHAT_ID });
    }
  }

  console.log(`[server] Bot v${BOT_VERSION} listening on ${PORT}`);
});
