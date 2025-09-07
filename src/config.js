// src/config.js — переменные окружения и валидация

const required = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`ENV ${name} отсутствует`);
    process.exit(1);
  }
  return v;
};

const VK_GROUP_ID        = required('VK_GROUP_ID');
const VK_SECRET_KEY      = required('VK_SECRET_KEY');
const VK_SERVICE_KEY     = required('VK_SERVICE_KEY');
const TELEGRAM_BOT_TOKEN = required('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID   = required('TELEGRAM_CHAT_ID');

const LEAD_CHAT_ID   = process.env.LEAD_CHAT_ID || null;
const DEBUG_CHAT_ID  = process.env.DEBUG_CHAT_ID || null;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const BOT_VERSION    = process.env.BOT_VERSION || '2.0.0';

module.exports = {
  VK_GROUP_ID,
  VK_SECRET_KEY,
  VK_SERVICE_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  LEAD_CHAT_ID,
  DEBUG_CHAT_ID,
  ADMIN_USER_IDS,
  BOT_VERSION
};
