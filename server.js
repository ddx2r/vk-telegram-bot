// server.js — HTTP-склейка и маршруты

const express = require('express');
const bodyParser = require('body-parser');

const {
  VK_GROUP_ID,
  VK_SECRET_KEY,
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
// VK шлёт JSON; увеличим лимит на всякий случай
app.use(bodyParser.json({ limit: '2mb' }));
app.use(withRequestId());

// аптайм
global.__BOT_STARTED_AT = new Date();

// Регистрация команд тг
registerCommands(bot);

// health
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

// Единая функция проверки VK + обработка
async function vkWebhookHandler(req, res) {
  const body = req.body || {};
  const { type, object, group_id, secret } = body;

  // Если пришло что-то не похоже на VK — логируем и отвечаем ok
  if (!type && !object) {
    logger.warn({
      source: 'vk',
      event: 'unknown_payload',
      request_id: req.requestId,
      summary: 'VK payload without type/object',
      payload: body
    });
    return res.status(200).send('ok');
  }

  // Безопасность
  if (String(group_id) != String(VK_GROUP_ID) || (VK_SECRET_KEY && secret !== VK_SECRET_KEY)) {
    logError('vk', 'auth', new Error('bad secret or group id'), { payload: body });
    return res.status(403).end('forbidden');
  }

  // Подтверждение сервера
  if (type === 'confirmation') {
    const code = process.env.VK_CONFIRMATION_STRING || 'confirmation-code';
    // VK требует обычную строку, не JSON
    return res.status(200).send(code);
  }

  try {
    // Идемпотентность на случай ретраев
    if (shouldProcessEvent(body)) {
      await handleVkEvent(type, object, { full: body, requestId: req.requestId });
      rememberEvent(body);
    }
    return res.status(200).send('ok');
  } catch (err) {
    logError('vk', type || 'webhook', err, { payload: body });
    return res.status(500).end('error');
  }
}

// VK webhook (новый путь)
app.post('/vk', logMiddlewareVK(), vkWebhookHandler);
// Оставим и старый путь для обратной совместимости
app.post('/webhook', logMiddlewareVK(), vkWebhookHandler);

// Старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info({
    source: 'system',
    event: 'boot',
    summary: `Bot v${BOT_VERSION} started`,
    payload: { port: PORT }
  });

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
