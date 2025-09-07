// src/vk/dedup.js — дедупликация
const crypto = require('crypto');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

function buildKey({ type, object, group_id }) {
  const objectId =
    object?.id || object?.comment_id || object?.video_id || object?.photo_id ||
    object?.post_id || object?.message?.id || object?.user_id;

  const payload = {
    type,
    objectId,
    groupId: group_id || 'nogrp',
    date: object?.date || null
  };
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

function shouldProcessEvent(ctx) {
  const key = buildKey(ctx);
  return !cache.has(key);
}

function rememberEvent(ctx) {
  const key = buildKey(ctx);
  cache.set(key, true);
}

module.exports = { shouldProcessEvent, rememberEvent };
