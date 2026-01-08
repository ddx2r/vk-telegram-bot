module.exports = async ({ type, object, group_id }, { getVkUserName, getObjectTypeDisplayName, getObjectLinkForLike, getVkLikesCount, escapeHtml }) => {
  const isAdd = type === 'like_add';
  const likeObject = object;
  let telegramMessage = '';
  if (likeObject && likeObject.liker_id && likeObject.object_type && likeObject.object_id) {
    let ownerId = likeObject.owner_id;
    if (!ownerId || ownerId === null) {
      ownerId = -group_id;
      console.warn(`[${new Date().toISOString()}] Отсутствует owner_id в payload события '${type}'. Используем ID группы по умолчанию: ${ownerId}`);
    }
    const objectLink = getObjectLinkForLike(ownerId, likeObject.object_type, likeObject.object_id, likeObject.post_id);
    const objectTypeDisplayName = getObjectTypeDisplayName(likeObject.object_type);
    let likerDisplay;
    try {
      const userName = await getVkUserName(likeObject.liker_id);
      likerDisplay = userName ? userName : `ID ${likeObject.liker_id}`;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Ошибка при получении имени лайкнувшего:`, error.message);
      likerDisplay = `ID ${likeObject.liker_id} (ошибка получения имени)`;
    }
    let likesCountText = '';
    try {
      const likesCount = await getVkLikesCount(ownerId, likeObject.object_id, likeObject.object_type);
      if (likesCount === -1) {
        likesCountText = ' (⚠️ Ошибка получения лайков)';
      } else if (likesCount !== null) {
        likesCountText = ` (Всего: ${likesCount})`;
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Ошибка при получении количества лайков:`, error.message);
      likesCountText = ' (⚠️ Ошибка получения лайков)';
    }
    telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удалён в VK'}</b>\n`;
    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${likeObject.liker_id}">${likerDisplay}</a>\n`;
    telegramMessage += `<b>${isAdd ? 'К' : 'С'}:</b> `;
    if (objectLink) {
      telegramMessage += `<a href="${objectLink}">${objectTypeDisplayName}</a>`;
    } else {
      telegramMessage += `${objectTypeDisplayName} ID <code>${likeObject.object_id}</code>`;
    }
    telegramMessage += likesCountText;
  } else {
    console.warn(`[${new Date().toISOString()}] Получено событие '${type}' без необходимых полей:`, likeObject);
    telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удалён в VK'}:</b> (некорректный объект)`;
  }
  return { message: telegramMessage, parseMode: 'HTML' };
};
