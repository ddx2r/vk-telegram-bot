const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT |
