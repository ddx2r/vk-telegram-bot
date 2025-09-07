// src/state.js — состояние бота: тумблеры событий, основной чат, админы

const { TELEGRAM_CHAT_ID, ADMIN_USER_IDS } = require('./config');

const state = {
  CURRENT_MAIN_CHAT_ID: TELEGRAM_CHAT_ID,
  eventToggleState: {
    'lead_forms_new': true,
    'message_reply': true,
    'message_new': true,

    'wall_post_new': true,
    'wall_repost': true,
    'wall_reply_new': true,
    'wall_reply_edit': true,
    'wall_reply_delete': true,
    'wall_reply_restore': true,

    'photo_comment_new': true,
    'photo_comment_edit': true,
    'photo_comment_delete': true,
    'photo_comment_restore': true,

    'video_comment_new': true,
    'video_comment_edit': true,
    'video_comment_delete': true,
    'video_comment_restore': true
  }
};

function isAdmin(id) {
  return ADMIN_USER_IDS.includes(String(id));
}

function setMainChat(id) {
  state.CURRENT_MAIN_CHAT_ID = String(id);
}

module.exports = { state, isAdmin, setMainChat };
