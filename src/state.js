// src/state.js — состояние бота: тумблеры событий, основной чат, админы

const { TELEGRAM_CHAT_ID, ADMIN_USER_IDS } = require('./config');

const state = {
  CURRENT_MAIN_CHAT_ID: TELEGRAM_CHAT_ID,

  // Включаем максимум известных типов событий VK (можно дополнять)
  eventToggleState: {
    // Сообщения
    message_new: true,
    message_reply: true,
    message_allow: true,
    message_deny: true,
    typing_status: false,   // шум
    message_read: false,    // шум

    // Стена
    wall_post_new: true,
    wall_repost: true,
    wall_reply_new: true,
    wall_reply_edit: true,
    wall_reply_delete: true,
    wall_reply_restore: true,

    // Фото
    photo_new: true,
    photo_comment_new: true,
    photo_comment_edit: true,
    photo_comment_delete: true,
    photo_comment_restore: true,

    // Видео
    video_new: true,
    video_comment_new: true,
    video_comment_edit: true,
    video_comment_delete: true,
    video_comment_restore: true,

    // Аудио
    audio_new: true,

    // Обсуждения
    board_post_new: true,
    board_post_edit: true,
    board_post_delete: true,

    // Маркет
    market_order_new: true,
    market_comment_new: true,
    market_comment_edit: true,
    market_comment_delete: true,

    // Опросы
    poll_vote_new: true,

    // Группа/участники
    group_join: true,
    group_leave: true,
    group_change_photo: true,
    group_change_settings: true,
    group_officers_edit: true,
    user_block: true,
    user_unblock: true,

    // Лайки
    like_add: true,
    like_remove: true,

    // Лиды
    lead_forms_new: true
  }
};

function isAdmin(id) {
  return ADMIN_USER_IDS.includes(String(id));
}

function setMainChat(id) {
  state.CURRENT_MAIN_CHAT_ID = String(id);
}

module.exports = { state, isAdmin, setMainChat };
