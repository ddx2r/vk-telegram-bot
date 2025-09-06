// src/storage/firebase.js
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Разрешаем «мягкий старт», чтобы локально/на Railway не падало без ключа
const credsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!credsJson) {
  console.warn('[Firestore] FIREBASE_SERVICE_ACCOUNT_JSON is not set — Firestore disabled');
}

if (!getApps().length && credsJson) {
  initializeApp({ credential: cert(JSON.parse(credsJson)) });
}

export const db = credsJson ? getFirestore() : null;

/**
 * Лог события в коллекцию events + инкремент дневного счётчика (daily_counters)
 * @param {{
 *   type: string,
 *   vk_owner_id?: number,
 *   vk_post_id?: number,
 *   tg_chat_id?: number,
 *   tg_message_id?: number,
 *   status?: string,
 *   meta?: object
 * }} ev
 */
export async function logEventFirestore(ev) {
  if (!db) return;
  const ts = new Date();
  await db.collection('events').add({ ...ev, ts });

  const day = ts.toISOString().slice(0, 10);
  const key = `${day}_${ev.type}`;
  await db.collection('daily_counters').doc(key).set({
    day,
    type: ev.type,
    count: FieldValue.increment(1),
    updatedAt: ts
  }, { merge: true });
}

/** Получить агрегат за последние N дней (пример) */
export async function getRecentCounts(days = 7) {
  if (!db) return [];
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const snap = await db.collection('daily_counters')
    .where('day', '>=', since)
    .get();
  return snap.docs.map(d => d.data());
}
