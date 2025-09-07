// src/lib/logger.ts
// Drop-in structured logger that writes to Supabase (free tier friendly).
// Batches inserts to minimize overhead and adds graceful backpressure.
// Usage:
//   import { logger, withRequestId, logMiddlewareTelegram, logMiddlewareVK } from './logger';
//   app.use(withRequestId());
//   app.post('/telegram', logMiddlewareTelegram(), telegramHandler);
//   app.post('/vk', logMiddlewareVK(), vkHandler);
//   logger.info({ source: 'system', event: 'boot', summary: 'Bot started' });

import { supabase } from './db';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Direction = 'in' | 'out' | 'none';

export interface LogRecord {
  ts?: string; // optional override
  level: Level;
  source: string;      // 'telegram' | 'vk' | 'system' | 'worker' | ...
  event: string;       // 'incoming_update' | 'outgoing_message' | 'webhook' | ...
  request_id?: string; // auto-filled by middleware
  chat_id?: string;
  user_id?: string;
  direction?: Direction;
  summary?: string;
  payload?: any;
  error?: string;
}

const BATCH_MAX = 50;
const FLUSH_MS = 1000;
const QUEUE_HARD_LIMIT = 1000;

class SupabaseLogger {
  private queue: LogRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dropping = false;

  private startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private push(rec: LogRecord) {
    if (this.queue.length >= QUEUE_HARD_LIMIT) {
      // Drop oldest to prevent OOM
      this.queue.shift();
      if (!this.dropping) {
        this.dropping = true;
        // eslint-disable-next-line no-console
        console.warn('[logger] Queue overflow, dropping oldest records');
      }
    }
    this.queue.push(rec);
    if (this.queue.length >= BATCH_MAX) {
      // Fire-and-forget flush
      void this.flush();
    }
    this.startTimer();
  }

  async flush() {
    if (this.queue.length === 0) {
      this.stopTimer();
      return;
    }
    const batch = this.queue.splice(0, BATCH_MAX);
    try {
      const { error } = await supabase.from('bot_logs').insert(
        batch.map(r => ({
          ts: r.ts ?? new Date().toISOString(),
          level: r.level,
          source: r.source,
          event: r.event,
          request_id: r.request_id ?? randomUUID(),
          chat_id: r.chat_id ?? null,
          user_id: r.user_id ?? null,
          direction: r.direction ?? 'none',
          summary: r.summary ?? null,
          payload: r.payload ?? null,
          error: r.error ?? null,
        }))
      );
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[logger] Supabase insert error:', error.message);
        // Fallback: dump to console as JSON
        for (const rec of batch) {
          // eslint-disable-next-line no-console
          console.log('[log-fallback]', JSON.stringify(rec));
        }
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[logger] flush exception:', e?.message || e);
      for (const rec of batch) {
        // eslint-disable-next-line no-console
        console.log('[log-fallback]', JSON.stringify(rec));
      }
    }
  }

  private write(level: Level, rec: Omit<LogRecord, 'level'>) {
    this.push({ level, ...rec });
  }

  debug(rec: Omit<LogRecord, 'level'>) { this.write('debug', rec); }
  info(rec: Omit<LogRecord, 'level'>)  { this.write('info', rec); }
  warn(rec: Omit<LogRecord, 'level'>)  { this.write('warn', rec); }
  error(rec: Omit<LogRecord, 'level'>) { this.write('error', rec); }
}

export const logger = new SupabaseLogger();

// Express helpers
declare global {
  // Augment Request to carry requestId
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function withRequestId() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.requestId = (req.headers['x-request-id'] as string) || randomUUID();
    next();
  };
}

export function logMiddlewareTelegram() {
  return (req: Request, _res: Response, next: NextFunction) => {
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

export function logMiddlewareVK() {
  return (req: Request, _res: Response, next: NextFunction) => {
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
      summary: obj?.message?.text || body?.type || 'vk_event',
      payload: body,
    });
    next();
  };
}

// Outgoing helpers
export function logOutgoingMessage(platform: 'telegram'|'vk', chatId: string, summary: string, payload?: any) {
  logger.info({
    source: platform,
    event: 'outgoing_message',
    direction: 'out',
    chat_id: chatId,
    summary,
    payload,
  });
}

export function logError(source: string, event: string, err: any, extra?: Partial<LogRecord>) {
  logger.error({
    source,
    event,
    summary: extra?.summary || (err?.message || 'error'),
    error: (err && err.stack) ? String(err.stack) : String(err),
    payload: extra?.payload,
    chat_id: extra?.chat_id,
    user_id: extra?.user_id,
    request_id: extra?.request_id,
    direction: extra?.direction ?? 'none',
  });
}
