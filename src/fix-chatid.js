const fs = require('fs');

// 1. Update telegram.js: remove chatId from user-config, use DB
let tgram = fs.readFileSync('notifications/telegram.js', 'utf8');

// Remove loadChatId function
tgram = tgram.replace(
  /\/\/ ── chatId persistence[\s\S]*?function loadChatId\(\)[\s\S]*?^} \n/m,
  '// chatId now stored in SQLite kv_store\nconst _chatId = { value: null };\n'
);

// Replace saveChatId to use DB
tgram = tgram.replace(
  /async function saveChatId\(id\)[\s\S]*?^} \n/m,
  `// saveChatId: persists to SQLite kv_store\n` +
  `import { run, get } from '../core/db.js';\n` +
  `export async function saveChatId(id) {\n` +
  `  try {\n` +
  `    const db = await getDB();\n` +
  `    db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run('telegram_chat_id', JSON.stringify(id));\n` +
  `    _chatId.value = id;\n` +
  `  } catch (e) {\n` +
  `    log("error", "telegram", \`Failed to persist chatId: \${e?.message ?? e}\`);\n` +
  `  }\n` +
  `}\n`
);

// Replace loadChatId/initialization
tgram = tgram.replace(
  /let chatId   = String\(process\.env\.TELEGRAM_CHAT_ID \|\| ""\) \|\| null;/,
  'let _chatId = { value: null };'
);
tgram = tgram.replace(
  /loadChatId\(\);/,
  '// loadChatId removed - now loaded from DB on startup\n' +
  'async function loadChatIdFromDB() {\n' +
  '  try {\n' +
  '    const db = await getDB();\n' +
  '    const row = db.prepare("SELECT value FROM state WHERE key = ?").get("telegram_chat_id");\n' +
  '    if (row) _chatId.value = JSON.parse(row.value);\n' +
  '  } catch (e) {\n' +
  '    log("warn", "telegram", \`loadChatId: failed: \${e?.message ?? e}\`);\n' +
  '  }\n' +
  '}'
);

fs.writeFileSync('notifications/telegram.js', tgram);
console.log('Updated telegram.js for chatId in DB');
