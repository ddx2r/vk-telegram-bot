// src/storage/redis.js
import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = (url && token) ? new Redis({ url, token }) : null;

/**
 * Антидубль по ключу. Вернёт true, если такое уже было.
 * Реализация: SET key NX EX <ttl>
 */
export async function seenOnce(key, ttlSec = 7 * 24 * 3600) {
  if (!redis) return false;
  const res = await redis.set(key, '1', { nx: true, ex: ttlSec });
  return res === null;
}

/** Быстрый счётчик (incr) по «ведёрку» */
export async function incrCounter(bucket) {
  if (!redis) return;
  await redis.incr(`cnt:${bucket}`);
}
