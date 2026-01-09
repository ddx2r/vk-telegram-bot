
// src/lib/logger.js (CommonJS)
// Структурированный логгер, который пишет пакетные записи в Supabase (дружелюбно к бесплатному тарифу)
const { supabase } = require('./db');
const { randomUUID } = require('crypto');

/** @typedef {'debug'|'info'|'warn'|'error'} Level */
/** @typedef {'in'|'out'|'none'} Direction */

class SupabaseLogger {
  constructor () {
    this.queue = [];
    this.timer = null;
    this.dropping = false;
    this.BATCH_MAX = 50;
    this.FLUSH_MS  = 1000;
    this.QUEUE_HARD_LIMIT = 1000;
  }

  startTimer () {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), this.FLUSH_MS);
  }

  stopTimer () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  push (rec) {
    if (this.queue.length >= this.QUEUE_HARD_LIMIT) {
      this.queue.shift();
      if (!this.dropping) {
        this.dropping = true;
        console.warn('[logger] Переполнение очереди, отбрасываем самые старые записи');
      }
    }
    this.queue.push(rec);
    if (this.queue.length >= this.BATCH_MAX) {
      // не ждём завершения
      this.flush().catch(() => {});
    }
    this.startTimer();
  }

  async flush () {
    if (this.queue.length === 0) {
      this.stopTimer();
      return;
    }
    const batch = this.queue.splice(0, this.BATCH_MAX);
    try {
      const { error } = await supabase
        .from('bot_logs')
        .insert(batch.map(r => ({
          ts: r.ts || new Date().toISOString(),
          level: r.level,
          source: r.source,
          event: r.event,
          request_id: r.request_id || randomUUID(),
          chat_id: r.chat_id || null,
          user_id: r.user_id || null,
          direction: r.direction || 'none',
          summary: r.summary || null,
          payload: r.payload || null,
          error: r.error || null,
        })));
      if (error) {
        console.error('[logger] Ошибка вставки в Supabase:', error.message);
        for (const rec of batch) console.log('[log-fallback]', JSON.stringify(rec));
      }
    } catch (e) {
      console.error('[logger] Исключение при flush:', e && e.message ? e.message : e);
      for (const rec of batch) console.log('[log-fallback]', JSON.stringify(rec));
    }
  }

  write (level, rec) { this.push({ level, ...rec }); }
  debug (rec) { this.write('debug', rec); }
  info  (rec) { this.write('info',  rec); }
  warn  (rec) { this.write('warn',  rec); }
  error (rec) { this.write('error', rec); }
}

const logger = new SupabaseLogger();

// Хелперы для Express
function withRequestId () {
  return (req, _res, next) => {
    req.requestId = req.headers['x-request-id'] || randomUUID();
    next();
  };
}

function logMiddlewareTelegram () {
  return (req, _res, next) => {
    const body = req.body || {};
    const chatId = body?.message?.chat?.id ?? body?.callback_query?.message?.chat?.id;
    const userId = body?.message?.from?.id ?? body?.callback_query?.from?.id;
    logger.info({
      source: 'telegram',
      event: 'incoming_update',
      request_id: req.requestId,
      direction: 'in',
      chat_id: chatId ? String(chatId) : undefined,
      user_id: userId ? String(userId) : undefined,
      summary: body?.message?.text || body?.callback_query?.data || 'update',
      payload: body,
    });
    next();
  };
}

function logMiddlewareVK () {
  return (req, _res, next) => {
    const body = req.body || {};
    const obj  = body?.object || {};
    const peer = obj?.peer_id || obj?.message?.peer_id || obj?.chat_id;
    const from = obj?.from_id || obj?.message?.from_id;
    logger.info({
      source: 'vk',
      event: 'incoming_update',
      request_id: req.requestId,
      direction: 'in',
      chat_id: peer ? String(peer) : undefined,
      user_id: from ? String(from) : undefined,
      summary: (obj && obj.message && obj.message.text) || body?.type || 'vk_event',
      payload: body,
    });
    next();
  };
}

// Хелперы для исходящих сообщений и ошибок
function logOutgoingMessage (platform, chatId, summary, payload) {
  logger.info({
    source: platform,
    event: 'outgoing_message',
    direction: 'out',
    chat_id: chatId,
    summary,
    payload,
  });
}

function logError (source, event, err, extra = {}) {
  logger.error({
    source,
    event,
    summary: extra.summary || (err && err.message) || 'error',
    error: (err && err.stack) ? String(err.stack) : String(err),
    payload: extra.payload,
    chat_id: extra.chat_id,
    user_id: extra.user_id,
    request_id: extra.request_id,
    direction: extra.direction || 'none',
  });
}

module.exports = {
  logger,
  withRequestId,
  logMiddlewareTelegram,
  logMiddlewareVK,
  logOutgoingMessage,
  logError,
};
