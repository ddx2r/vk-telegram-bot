// src/utils.js — утилиты

const axios = require('axios');
const { VK_SERVICE_KEY } = require('./config');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getVkUserName(userId) {
  try {
    const resp = await axios.get('https://api.vk.com/method/users.get', {
      params: { user_ids: userId, access_token: VK_SERVICE_KEY, v: '5.131', lang: 'ru' }
    });
    const u = resp.data?.response?.[0];
    if (!u) return `ID ${userId}`;
    if (u.deactivated) return `[Деактивирован] ID ${userId}`;
    return `${escapeHtml(u.first_name)} ${escapeHtml(u.last_name)}`;
  } catch (e) {
    console.error('VK users.get error:', e.message);
    return `ID ${userId}`;
  }
}

module.exports = { escapeHtml, getVkUserName };
