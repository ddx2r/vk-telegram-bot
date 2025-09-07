import express from "express";
import bodyParser from "body-parser";
import pino from "pino";
import TelegramBot from "node-telegram-bot-api";

import { isDuplicateVkPost, logPosted, logError } from "./src/lib/events.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(bodyParser.json());

// ========== Telegram ==========
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TG_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const CHAT_DEFAULT = Number(process.env.TELEGRAM_CHAT_ID) || null;
const CHAT_DEBUG = Number(process.env.DEBUG_CHAT_ID) || null;
const CHAT_LEAD = Number(process.env.LEAD_CHAT_ID) || null;
const CHAT_SERVICE = Number(process.env.SERVICE_CHAT_ID) || null;

function resolveChatId(kind = "default") {
  if (kind === "lead" && CHAT_LEAD) return CHAT_LEAD;
  if (kind === "service" && CHAT_SERVICE) return CHAT_SERVICE;
  if (kind === "debug" && CHAT_DEBUG) return CHAT_DEBUG;
  return CHAT_DEFAULT || CHAT_DEBUG || CHAT_SERVICE || CHAT_LEAD;
}

const WEBHOOK_URL = process.env.WEBHOOK_URL;
let bot;

if (WEBHOOK_URL) {
  bot = new TelegramBot(TG_TOKEN, { webHook: { port: process.env.PORT || 3000 } });
  await bot.setWebHook(`${WEBHOOK_URL}/tg-webhook`);
  app.post("/tg-webhook", (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  log.info({ WEBHOOK_URL }, "Telegram webhook mode");
} else {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
  log.info("Telegram polling mode");
}

bot.onText(/^\/stats$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Бот жив ✅. Логи пишутся в Firestore/SQL (если настроено).");
});

// ========== VK Callback ==========
const VK_CONFIRMATION = process.env.VK_CONFIRMATION || "";
const VK_SECRET = process.env.VK_SECRET_KEY || "";
const VK_GROUP_ID = Number(process.env.VK_GROUP_ID || 0);

app.post("/vk", async (req, res) => {
  try {
    const { type, group_id, secret, object } = req.body || {};

    if (type === "confirmation") {
      if (!VK_CONFIRMATION) {
        log.warn("VK_CONFIRMATION not set — cannot confirm");
        return res.status(500).send("VK_CONFIRMATION not set");
      }
      return res.status(200).send(VK_CONFIRMATION);
    }

    if (VK_SECRET && secret !== VK_SECRET) {
      log.warn({ received: secret }, "VK secret mismatch");
      return res.status(403).send("forbidden");
    }

    if (VK_GROUP_ID && group_id && Number(group_id) !== VK_GROUP_ID) {
      log.warn({ got: group_id, expected: VK_GROUP_ID }, "VK group mismatch");
      return res.status(200).send("ok");
    }

    if (type === "wall_post_new" || type === "wall_repost") {
      const post = object;
      const ownerId = post?.owner_id ?? post?.from_id;
      const postId = post?.id;

      if (!ownerId || !postId) {
        log.warn({ type, object }, "VK post payload missing owner_id or id");
        return res.status(200).send("ok");
      }

      if (await isDuplicateVkPost(ownerId, postId)) {
        return res.status(200).send("ok");
      }

      const text = [
        escapeHtml(post?.text || ""),
        ...(post?.attachments || []).filter(a => a?.link?.url).map(a => escapeHtml(a.link.url))
      ]
        .filter(Boolean)
        .join("\n\n");

      const targetChat = resolveChatId("default");
      if (!targetChat) {
        await logError({ ownerId, postId, stage: "resolve_chat", error: new Error("No target chat configured") });
        return res.status(200).send("ok");
      }

      try {
        const sent = await bot.sendMessage(targetChat, text || "(без текста)", {
          disable_web_page_preview: false,
          parse_mode: "HTML"
        });

        await logPosted({
          ownerId,
          postId,
          chatId: targetChat,
          messageId: sent?.message_id,
          hasMedia: Array.isArray(post?.attachments) && post.attachments.length > 0
        });
      } catch (err) {
        await logError({ ownerId, postId, stage: "send_to_telegram", error: err });
      }

      return res.status(200).send("ok");
    }

    return res.status(200).send("ok");
  } catch (err) {
    await logError({ stage: "vk_handler", error: err });
    return res.status(200).send("ok");
  }
});

// health
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Если polling → нужен listener
if (!WEBHOOK_URL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => log.info(`Server listening on ${PORT}`));
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => log.info(`Express (webhook mode) listening on ${PORT}`));
}

// === helpers ===
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
