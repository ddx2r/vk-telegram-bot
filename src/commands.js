// src/commands.js — регистрация Telegram-команд

const { sendTelegramMessageWithRetry } = require('./telegram');
const { state, isAdmin, setMainChat } = require('./state');
const { escapeHtml } = require('./utils');
const { DEBUG_CHAT_ID, BOT_VERSION } = require('./config');

function registerCommands(bot) {
  bot.onText(/^\/help$/, async (msg) => {
    const text = [
      '👋 Доступные команды:',
      '/status — статус',
      '/help — помощь',
      '/my_chat_id — ID чата',
      '/whoami — информация о тебе',
      '/ping — задержка',
      '/version — версия и аптайм',
      '/test_notification — тест (админ)',
      '/list_events — список событий (админ)',
      '/toggle_event <тип> — вкл/выкл событие (админ)',
      '/set_main_chat <id> — основной чат (админ)',
      '/send_main <текст> — отправить в основной (админ)'
    ].join('\n');
    await sendTelegramMessageWithRetry(msg.chat.id, text);
  });

  bot.onText(/^\/status$/, msg =>
    sendTelegramMessageWithRetry(msg.chat.id, '✅ Бот активен.')
  );

  bot.onText(/^\/my_chat_id$/, msg =>
    sendTelegramMessageWithRetry(msg.chat.id, `ID: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' })
  );

  bot.onText(/^\/whoami$/, msg => {
    const u = msg.from || {};
    const lines = [
      `Ты: <b>${escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || '—')}</b>`,
      `username: @${u.username || '—'}`,
      `id: <code>${u.id}</code>`,
      `is_admin: <b>${isAdmin(u.id)}</b>`
    ];
    sendTelegramMessageWithRetry(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/ping$/, async (msg) => {
    const t0 = Date.now();
    const m = await bot.sendMessage(msg.chat.id, 'pong…');
    const dt = Date.now() - t0;
    await bot.editMessageText(`🏓 pong (${dt}ms)`, { chat_id: m.chat.id, message_id: m.message_id });
  });

  bot.onText(/^\/version$/, msg => {
    const started = global.__BOT_STARTED_AT || new Date();
    const uptimeSec = Math.floor((Date.now() - started.getTime()) / 1000);
    const lines = [
      `🟢 Версия: <b>${BOT_VERSION}</b>`,
      `Основной чат: <code>${state.CURRENT_MAIN_CHAT_ID}</code>`,
      `Uptime: ${uptimeSec}s`
    ];
    sendTelegramMessageWithRetry(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ==== Админ-команды ====
  bot.onText(/^\/test_notification$/, msg => {
    if (!isAdmin(msg.from?.id)) return;
    sendTelegramMessageWithRetry(DEBUG_CHAT_ID || msg.chat.id, '🔔 Тестовое уведомление OK');
  });

  bot.onText(/^\/list_events$/, msg => {
    if (!isAdmin(msg.from?.id)) return;
    const lines = ['✨ Статус событий:'];
    Object.keys(state.eventToggleState).sort().forEach(t => {
      lines.push(`${t}: ${state.eventToggleState[t] ? '✅' : '❌'}`);
    });
    sendTelegramMessageWithRetry(msg.chat.id, lines.join('\n'));
  });

  bot.onText(/^\/toggle_event\s+(\S+)$/, (msg, m) => {
    if (!isAdmin(msg.from?.id)) return;
    const key = m[1];
    if (!(key in state.eventToggleState)) {
      sendTelegramMessageWithRetry(msg.chat.id, `Неизвестный тип: <code>${escapeHtml(key)}</code>`, { parse_mode: 'HTML' });
      return;
    }
    state.eventToggleState[key] = !state.eventToggleState[key];
    sendTelegramMessageWithRetry(msg.chat.id, `${key}: ${state.eventToggleState[key] ? '✅ включено' : '❌ отключено'}`);
  });

  bot.onText(/^\/set_main_chat\s+(-?\d+)$/, (msg, m) => {
    if (!isAdmin(msg.from?.id)) return;
    setMainChat(m[1]);
    sendTelegramMessageWithRetry(msg.chat.id, `Основной чат: <code>${state.CURRENT_MAIN_CHAT_ID}</code>`, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/send_main\s+([\s\S]+)$/, (msg, m) => {
    if (!isAdmin(msg.from?.id)) return;
    const text = m[1].trim();
    if (!text) return;
    sendTelegramMessageWithRetry(state.CURRENT_MAIN_CHAT_ID, text);
    sendTelegramMessageWithRetry(msg.chat.id, '✅ Отправлено.');
  });

  // неизвестные команды
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (/^\//.test(msg.text) && !/^\/(help|status|my_chat_id|whoami|ping|version|test_notification|list_events|toggle_event|set_main_chat|send_main)\b/.test(msg.text)) {
      await sendTelegramMessageWithRetry(msg.chat.id, 'Команда не найдена. Напиши /help');
    }
  });
}

module.exports = { registerCommands };
