const axios = require('axios');

module.exports = (bot) => {
  const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY;
  const VK_GROUP_ID = process.env.VK_GROUP_ID;

  function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function getVkUserName(userId) {
    if (!userId) return null;
    try {
      if (!/^\d+$/.test(userId)) {
        throw new Error(`Некорректный ID пользователя: ${userId}`);
      }
      const response = await axios.get(`https://api.vk.com/method/users.get`, {
        params: {
          user_ids: userId,
          access_token: VK_SERVICE_KEY,
          v: '5.131',
          lang: 'ru'
        },
        timeout: 5000
      });
      if (response.data.error) {
        throw new Error(`VK API: ${response.data.error.error_msg}`);
      }
      if (response.data.response && response.data.response.length > 0) {
        const user = response.data.response[0];
        if (user.deactivated) {
          return `[Деактивирован] ID: ${userId}`;
        }
        return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
      }
      return `ID: ${userId}`;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Ошибка при получении имени (ID: ${userId}):`, error.response?.data || error.message);
      if (error.response?.data?.error?.error_code === 38) {
        return `⚠️ [Ошибка ключа VK] ID: ${userId}`;
      }
      return `ID: ${userId}`;
    }
  }

  async function getVkLikesCount(ownerId, itemId, itemType) {
    try {
      const response = await axios.get(`https://api.vk.com/method/likes.getList`, {
        params: {
          type: itemType,
          owner_id: ownerId,
          item_id: itemId,
          access_token: VK_SERVICE_KEY,
          v: '5.131'
        },
        timeout: 5000
      });
      if (response.data && response.data.response && response.data.response.count !== undefined) {
        return response.data.response.count;
      }
      console.warn(`[${new Date().toISOString()}] VK API не вернул количество лайков. Ответ:`, response.data);
      return null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Ошибка при получении лайков:`, error.response?.data || error.message);
      if (error.response?.data?.error?.error_code === 38) {
        return -1;
      }
      return null;
    }
  }

  async function sendTelegramMessageWithRetry(chatId, text, options = {}) {
    let sent = false;
    for (let i = 0; i < 3; i++) {
      try {
        await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
        sent = true;
        break;
      } catch (telegramSendError) {
        console.error(`[${new Date().toISOString()}] Ошибка при отправке сообщения в Telegram (попытка ${i + 1}):`, telegramSendError.response ? telegramSendError.response.data : telegramSendError.message);
        if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    if (!sent) {
      console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram после нескольких попыток.`);
    }
  }

  async function sendTelegramMedia(chatId, type, fileUrl, caption, options = {}) {
    try {
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const fileBuffer = Buffer.from(response.data);
      let sent = false;
      for (let i = 0; i < 3; i++) {
        try {
          switch (type) {
            case 'photo':
              await bot.sendPhoto(chatId, fileBuffer, { caption, parse_mode: 'HTML', ...options });
              break;
            case 'video':
              await bot.sendVideo(chatId, fileBuffer, { caption, parse_mode: 'HTML', ...options });
              break;
            case 'audio':
              await bot.sendAudio(chatId, fileBuffer, { caption, parse_mode: 'HTML', ...options });
              break;
            case 'document':
              await bot.sendDocument(chatId, fileBuffer, { caption, parse_mode: 'HTML', ...options });
              break;
            default:
              console.warn(`[${new Date().toISOString()}] Неподдерживаемый тип медиа для прямой отправки: ${type}`);
              return;
          }
          sent = true;
          console.log(`[${new Date().toISOString()}] Мультимедиа (${type}) успешно отправлено в Telegram. Попытка: ${i + 1}`);
          break;
        } catch (mediaSendError) {
          console.error(`[${new Date().toISOString()}] Ошибка при отправке мультимедиа (${type}) в Telegram (попытка ${i + 1}):`, mediaSendError.response ? mediaSendError.response.data : mediaSendError.message);
          if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
      if (!sent) {
        console.error(`[${new Date().toISOString()}] Не удалось отправить мультимедиа (${type}) в Telegram после нескольких попыток.`);
        await sendTelegramMessageWithRetry(chatId, `⚠️ Не удалось оправить мультимедиа (${type}) в Telegram. Возможно, файл слишком большой или возникла временная ошибка.`, { parse_mode: 'HTML' });
      }
    } catch (downloadError) {
      console.error(`[${new Date().toISOString()}] Ошибка при скачивании мультимедиа с VK URL (${fileUrl}):`, downloadError.message);
      await sendTelegramMessageWithRetry(chatId, `⚠️ Ошибка при скачивании мультимедиа с VK: ${escapeHtml(downloadError.message)}. Возможно, ссылка устарела или недоступна.`, { parse_mode: 'HTML' });
    }
  }

  async function processAttachments(attachments, chatId, captionPrefix = '') {
    let attachmentsSummary = '';
    if (!attachments || attachments.length === 0) {
      return attachmentsSummary;
    }
    attachmentsSummary += '\n\n<b>Вложения:</b>\n';
    for (const attach of attachments) {
      let sentDirectly = false;
      let fallbackLink = '';
      let mediaCaption = '';
      switch (attach.type) {
        case 'photo': {
          const photo = attach.photo;
          const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
          if (photoUrl) {
            mediaCaption = `${captionPrefix} Фото: ${escapeHtml(photo.text || '')}`;
            await sendTelegramMedia(chatId, 'photo', photoUrl, mediaCaption);
            sentDirectly = true;
            fallbackLink = photoUrl;
          }
          attachmentsSummary += `📸 <a href="${fallbackLink || 'javascript:void(0)'}">Фото</a>`;
          if (photo.text) attachmentsSummary += ` <i>(${escapeHtml(photo.text)})</i>`;
          attachmentsSummary += '\n';
          break;
        }
        case 'video': {
          const video = attach.video;
          let directVideoUrl = null;
          if (video.owner_id && video.id) {
            try {
              const videoResp = await axios.get(`https://api.vk.com/method/video.get`, {
                params: {
                  videos: `${video.owner_id}_${video.id}`,
                  access_token: VK_SERVICE_KEY,
                  v: '5.131'
                },
                timeout: 5000
              });
              if (videoResp.data?.response?.items?.[0]?.files) {
                directVideoUrl = videoResp.data.response.items[0].files.mp4_1080 ||
                  videoResp.data.response.items[0].files.mp4_720 ||
                  videoResp.data.response.items[0].files.mp4_480 ||
                  videoResp.data.response.items[0].files.mp4_360 ||
                  videoResp.data.response.items[0].files.mp4_240;
              }
            } catch (error) {
              console.error(`[${new Date().toISOString()}] Ошибка при получении URL видео через VK API:`, error.message);
            }
          }
          if (directVideoUrl) {
            mediaCaption = `${captionPrefix} Видео: ${escapeHtml(video.title || 'Без названия')}`;
            await sendTelegramMedia(chatId, 'video', directVideoUrl, mediaCaption);
            sentDirectly = true;
            fallbackLink = directVideoUrl;
          } else if (video.player) {
            fallbackLink = video.player;
          } else if (video.owner_id && video.id) {
            fallbackLink = `https://vk.com/video${video.owner_id}_${video.id}`;
          }
          attachmentsSummary += `🎥 <a href="${fallbackLink || 'javascript:void(0)'}">Видео: ${escapeHtml(video.title || 'Без названия')}</a>`;
          if (!sentDirectly) attachmentsSummary += ' (прямая отправка недоступна)';
          attachmentsSummary += '\n';
          break;
        }
        case 'audio': {
          const audio = attach.audio;
          if (audio.url) {
            mediaCaption = `${captionPrefix} Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}`;
            await sendTelegramMedia(chatId, 'audio', audio.url, mediaCaption);
            sentDirectly = true;
            fallbackLink = audio.url;
          }
          attachmentsSummary += `🎵 <a href="${fallbackLink || 'javascript:void(0)'}">Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}</a>\n`;
          break;
        }
        case 'doc': {
          const doc = attach.doc;
          if (doc.url) {
            mediaCaption = `${captionPrefix} Документ: ${escapeHtml(doc.title || 'Без названия')}`;
            await sendTelegramMedia(chatId, 'document', doc.url, mediaCaption);
            sentDirectly = true;
            fallbackLink = doc.url;
          }
          attachmentsSummary += `📄 <a href="${fallbackLink || 'javascript:void(0)'}">Документ: ${escapeHtml(doc.title || 'Без названия')}</a>\n`;
          break;
        }
        case 'link': {
          const link = attach.link;
          if (link.url) {
            attachmentsSummary += `🔗 <a href="${link.url}">${escapeHtml(link.title || 'Ссылка')}</a>\n`;
          }
          break;
        }
        case 'poll': {
          const poll = attach.poll;
          if (poll.id) {
            attachmentsSummary += `📊 Опрос: ${escapeHtml(poll.question || 'Без вопроса')}\n`;
          }
          break;
        }
        case 'wall': {
          const wallPost = attach.wall;
          if (wallPost.owner_id && wallPost.id) {
            attachmentsSummary += `📝 Вложенный пост: <a href="https://vk.com/wall${wallPost.owner_id}_${wallPost.id}">Ссылка</a>\n`;
          }
          break;
        }
        case 'graffiti': {
          const graffiti = attach.graffiti;
          if (graffiti && graffiti.url) {
            mediaCaption = `${captionPrefix} Граффити`;
            await sendTelegramMedia(chatId, 'photo', graffiti.url, mediaCaption);
            sentDirectly = true;
            fallbackLink = graffiti.url;
          }
          attachmentsSummary += `🎨 <a href="${fallbackLink || 'javascript:void(0)'}">Граффити</a>\n`;
          break;
        }
        case 'sticker': {
          const sticker = attach.sticker;
          if (sticker && sticker.images_with_background && sticker.images_with_background.length > 0) {
            const stickerUrl = sticker.images_with_background[sticker.images_with_background.length - 1].url;
            mediaCaption = `${captionPrefix} Стикер`;
            await sendTelegramMedia(chatId, 'photo', stickerUrl, mediaCaption);
            sentDirectly = true;
            fallbackLink = stickerUrl;
          }
          attachmentsSummary += `🖼️ <a href="${fallbackLink || 'javascript:void(0)'}">Стикер</a>\n`;
          break;
        }
        case 'gift': {
          const gift = attach.gift;
          if (gift && gift.thumb_256) {
            mediaCaption = `${captionPrefix} Подарок`;
            await sendTelegramMedia(chatId, 'photo', gift.thumb_256, mediaCaption);
            sentDirectly = true;
            fallbackLink = gift.thumb_256;
          }
          attachmentsSummary += `🎁 <a href="${fallbackLink || 'javascript:void(0)'}">Подарок</a>\n`;
          break;
        }
        default:
          console.log(`[${new Date().toISOString()}] Неизвестное или необработанное вложение: ${attach.type}`, attach);
          attachmentsSummary += `❓ Неизвестное вложение: ${attach.type}\n`;
          break;
      }
    }
    return attachmentsSummary;
  }

  function getObjectTypeDisplayName(type) {
    switch (type) {
      case 'post': return 'посту';
      case 'photo': return 'фотографии';
      case 'video': return 'видео';
      case 'comment': return 'комментарию';
      case 'topic': return 'обсуждению';
      case 'market': return 'товару';
      default: return `объекту типа <code>${escapeHtml(type)}</code>`;
    }
  }

  function getObjectLinkForLike(ownerId, objectType, objectId, postId) {
    if (objectType === 'comment' && postId) {
      return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
    }
    switch (objectType) {
      case 'post': return `https://vk.com/wall${ownerId}_${objectId}`;
      case 'photo': return `https://vk.com/photo${ownerId}_${objectId}`;
      case 'video': return `https://vk.com/video${ownerId}_${objectId}`;
      case 'comment': return `https://vk.com/id${ownerId}?w=wall${ownerId}_${objectId}`;
      case 'topic': return `https://vk.com/topic-${VK_GROUP_ID}_${objectId}`;
      case 'market': return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${objectId}`;
      default: return null;
    }
  }

  return {
    escapeHtml,
    getVkUserName,
    getVkLikesCount,
    sendTelegramMessageWithRetry,
    sendTelegramMedia,
    processAttachments,
    getObjectTypeDisplayName,
    getObjectLinkForLike
  };
};
