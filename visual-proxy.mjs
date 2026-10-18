#!/usr/bin/env node
// Прослойка между харнесом и chrome-devtools-mcp: показывает на странице, что делает модель.
// Перед кликом, наведением, вводом и перетаскиванием курсор DeepSeek плавно едет к элементу, на клике — «пульс»;
// пока модель работает во вкладке, по краю страницы светится рамка. На скриншотах всё это прячется.
// Список инструментов и их ответы не меняются — модель разницы не видит.
//
//   node visual-proxy.mjs [--no-cursor] -- <команда сервера> [аргументы…]
// Рисование идёт напрямую в сервер, мимо хуков харнеса: оно только рисует и ничего на странице не меняет.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : [];
const [command, ...args] = sep >= 0 ? argv.slice(sep + 1) : argv;
const enabled = !own.includes('--no-cursor') && process.env.DSH_BROWSER_CURSOR !== '0';

const child = new Client({ name: 'dsh-visual-proxy', version: '1.0.0' });
await child.connect(new StdioClientTransport({ command, args, env: process.env, stderr: 'inherit' }));

// Действия с элементом по uid (курсор едет к нему) и без элемента (курсор у поля ввода / в точке).
const LABELS = {
  click: 'Клик', hover: 'Наведение', fill: 'Ввод', drag: 'Перетаскивание', upload_file: 'Файл',
  fill_form: 'Заполнение формы', type_text: 'Ввод текста', press_key: 'Клавиша', click_at: 'Клик',
};
const CLICKS = new Set(['click', 'click_at']);
const lastPos = new Map(); // pageId → {x, y}: курсор продолжает с того же места после перехода

const PAGE_FN = String(async (el, opts) => {
  const ID = '__dsh_agent_cursor__';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `<style>
      .glow{position:fixed;inset:0;border-radius:6px;box-shadow:inset 0 0 0 2px rgba(77,107,254,.85),inset 0 0 28px 6px rgba(77,107,254,.35);opacity:0;transition:opacity .35s}
      .glow.on{opacity:1;animation:breathe 2.2s ease-in-out infinite}
      @keyframes breathe{50%{box-shadow:inset 0 0 0 2px rgba(77,107,254,.6),inset 0 0 18px 3px rgba(77,107,254,.2)}}
      .cur{position:fixed;left:0;top:0;transition:transform .42s cubic-bezier(.3,.7,.2,1);will-change:transform}
      .cur svg{display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      .lbl{position:absolute;left:22px;top:20px;white-space:nowrap;font:600 12px/1 -apple-system,system-ui,sans-serif;color:#fff;background:#4D6BFE;padding:4px 7px;border-radius:9px;box-shadow:0 2px 6px rgba(0,0,0,.25)}
      .lbl:empty{display:none}
      .pulse{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #4D6BFE;animation:pulse .55s ease-out forwards}
      @keyframes pulse{from{transform:scale(.4);opacity:1}to{transform:scale(3.2);opacity:0}}
    </style><div class="glow"></div><div class="cur"><svg width="26" height="30" viewBox="0 0 26 30">
      <path d="M3 2 L3 24 L9 18.5 L13 27.5 L17 25.8 L13 17 L21 17 Z" fill="#4D6BFE" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    </svg><span class="lbl"></span></div>`;
    document.documentElement.appendChild(host);
  }
  const sh = host.shadowRoot;
  if (opts.mode === 'hide' || opts.mode === 'show') { host.style.visibility = opts.mode === 'hide' ? 'hidden' : ''; return 'ok'; }
  const cur = sh.querySelector('.cur'), glow = sh.querySelector('.glow'), lbl = sh.querySelector('.lbl');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  glow.classList.add('on');
  clearTimeout(window.__dshGlowTimer);
  window.__dshGlowTimer = setTimeout(() => { glow.classList.remove('on'); cur.style.opacity = '0'; }, opts.idleMs);
  cur.style.opacity = '1';
  // Откуда ехать: последняя точка на этой странице, иначе — от прошлой страницы.
  if (!host.dataset.placed) {
    const s = opts.start ?? { x: innerWidth * 0.6, y: innerHeight * 0.75 };
    cur.style.transition = 'none';
    cur.style.transform = `translate(${s.x}px,${s.y}px)`;
    cur.getBoundingClientRect();
    cur.style.transition = '';
    host.dataset.placed = '1';
  }
  if (opts.mode === 'park') return JSON.stringify(window.__dshCursorPos ?? opts.start ?? null);
  let target = el ?? (opts.point ? null : document.activeElement !== document.body ? document.activeElement : null);
  let x, y;
  if (target && target.getBoundingClientRect) {
    const r0 = target.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > innerHeight || r0.right < 0 || r0.left > innerWidth) target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = target.getBoundingClientRect();
    x = r.left + Math.min(r.width / 2, 40); y = r.top + r.height / 2;
  } else if (opts.point) { ({ x, y } = opts.point); }
  else { const p = window.__dshCursorPos ?? opts.start; if (!p) return 'ok'; ({ x, y } = p); }
  lbl.textContent = opts.label;
  cur.style.transform = `translate(${x}px,${y}px)`;
  await sleep(450);
  if (opts.click) {
    const p = document.createElement('div');
    p.className = 'pulse'; p.style.left = x + 'px'; p.style.top = y + 'px';
    sh.appendChild(p); setTimeout(() => p.remove(), 700);
    await sleep(120);
  }
  window.__dshCursorPos = { x, y };
  return JSON.stringify({ x, y });
});

// Нарисовать на странице; любой сбой рисования не мешает самому действию.
async function draw(pageId, uid, opts) {
  try {
    const res = await child.callTool({
      name: 'evaluate_script',
      arguments: {
        function: `(el, ...rest) => (${PAGE_FN})(${uid ? 'el' : 'null'}, ${JSON.stringify({ idleMs: 4000, ...opts })})`,
        ...(uid ? { args: [uid] } : {}),
        ...(pageId !== undefined ? { pageId } : {}),
        waitForStableDom: false,
      },
    }, undefined, { timeout: 5000 });
    const text = (res.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const m = text.match(/\\?"x\\?":([-\d.]+),\\?"y\\?":([-\d.]+)/);
    if (m && pageId !== undefined) lastPos.set(pageId, { x: Number(m[1]), y: Number(m[2]) });
    if (process.env.DSH_BROWSER_CURSOR_DEBUG) console.error('[cursor]', opts.mode ?? opts.label, pageId, res.isError ? 'ERR' : '', text.slice(0, 300));
  } catch (e) {
    // Страница ушла, чужой фрейм, CSP — просто без анимации.
    if (process.env.DSH_BROWSER_CURSOR_DEBUG) console.error('[cursor] fail', e.message);
  }
}

const server = new Server({ name: 'chrome-devtools-visual', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async req => child.listTools(req.params));
child.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged().catch(() => {}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: a = {} } = req.params;
  const pageId = a.pageId;
  const start = pageId !== undefined ? lastPos.get(pageId) : undefined;
  if (enabled && LABELS[name]) {
    const uid = a.uid ?? a.from_uid ?? a.elements?.[0]?.uid;
    const point = name === 'click_at' ? { x: a.x, y: a.y } : undefined;
    await draw(pageId, uid, { label: LABELS[name], click: CLICKS.has(name), point, start });
  }
  if (enabled && name === 'take_screenshot') await draw(pageId, undefined, { mode: 'hide' });
  let result;
  try {
    result = await child.callTool({ name, arguments: a }, undefined, { signal: extra.signal, timeout: 600000 });
    return result;
  } finally {
    if (enabled && name === 'take_screenshot') await draw(pageId, undefined, { mode: 'show' });
    // После перехода (адрес, новая вкладка, клик по ссылке) страница новая — вернуть рамку и курсор на прежнее место.
    if (enabled && result && (LABELS[name] || name === 'navigate_page' || name === 'new_page')) {
      const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const selected = Number(text.match(/^(\d+): .*\[selected\]/m)?.[1]);
      const id = name === 'new_page' && selected ? selected : pageId;
      if (name === 'navigate_page' || name === 'new_page' || /navigated/i.test(text)) {
        await draw(id, undefined, { mode: 'park', label: '', start: lastPos.get(pageId) ?? start });
      }
    }
  }
});

await server.connect(new StdioServerTransport());
const shutdown = async () => { await child.close().catch(() => {}); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
