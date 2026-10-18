#!/usr/bin/env node
// Хук PreToolUse для браузерных инструментов: опасные вызовы — только после «да» человека.
// Вход — JSON вызова на stdin (tool_name, tool_input), выход — решение в формате Claude Code.
// В режиме полного доступа (approval policy «never») «ask» превращается в отказ — это и нужно.

const MAIN = 'mcp__chrome__';
const SANDBOX = 'mcp__chrome_sandbox__';

// Основной Chrome — входы пользователя: любой ввод, скрипт и загрузка файла идут через человека.
const MAIN_ASK = new Set(['fill', 'fill_form', 'type_text', 'upload_file', 'evaluate_script', 'drag', 'handle_dialog']);
// Отдельный Chrome — входов нет; спрашиваем только про файлы с диска.
const SANDBOX_ASK = new Set(['upload_file']);

// Слова, по которым ввод похож на пароль, карту или код — спрашиваем в любом браузере.
const SECRET = /pass|парол|card|карт|cvv|cvc|otp|pin\b|код|token|secret/i;

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let call;
try { call = JSON.parse(raw); } catch { process.exit(0); }

const name = String(call.tool_name ?? '');
const input = call.tool_input ?? {};
let tool = null, browser = '';
if (name.startsWith(MAIN)) { tool = name.slice(MAIN.length); browser = 'основной Chrome (ваш профиль)'; }
else if (name.startsWith(SANDBOX)) { tool = name.slice(SANDBOX.length); browser = 'отдельный Chrome'; }
if (!tool) process.exit(0);

const isMain = name.startsWith(MAIN);
const text = JSON.stringify(input);
let reason = null;
if ((isMain ? MAIN_ASK : SANDBOX_ASK).has(tool)) reason = `${tool} в браузере «${browser}»`;
else if (['fill', 'fill_form', 'type_text'].includes(tool) && SECRET.test(text)) reason = `ввод, похожий на пароль или платёжные данные (${browser})`;
else if (isMain && tool === 'press_key' && /enter/i.test(String(input.key ?? ''))) reason = `Enter в основном Chrome может отправить форму`;

if (!reason) process.exit(0);
const shown = text.length > 300 ? text.slice(0, 300) + '…' : text;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: `Нужно подтверждение: ${reason}. Аргументы: ${shown}`,
  },
}));
