#!/bin/bash
# Навык «Браузер»: подключает к DeepSeek Harness два Chrome (основной и отдельный), курсор и сторож опасных действий.
#   ./install.sh                     — все найденные профили из desktop, web, headless
#   ./install.sh desktop             — только указанные профили
#   ./install.sh --check             — что установлено и доступен ли основной Chrome
#   ./install.sh --uninstall [профили]
# Повторный запуск безопасен: старые блоки заменяются, не дублируются.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH="${DSH_HOME:-$HOME/.dsh}"
SERVER="$DSH/mcp/chrome-devtools"
PORT="${DSH_CHROME_PORT:-9222}"
SERVER_VERSION="1.11.0"
SDK_VERSION="1.32.1"
START="# browser:start (browser-skill/install.sh)"
END="# browser:end"

MODE=install
case "${1:-}" in
  --uninstall) MODE=uninstall; shift ;;
  --check) MODE=check; shift ;;
esac

# Node 20.19+ / 22.12+ / 23+. Сначала Node из приложения DeepSeek Harness, потом системный.
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=23||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' 2>/dev/null; }
NODE=""
for n in "$DSH/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" "$(command -v node || true)"; do
  [ -n "$n" ] && [ -x "$n" ] && node_ok "$n" && { NODE="$n"; break; }
done

PROFILES=("$@")
if [ ${#PROFILES[@]} -eq 0 ]; then
  for p in desktop web headless; do [ -f "$DSH/profiles/$p/cordis.patch.yml" ] && PROFILES+=("$p"); done
fi

if [ $MODE = check ]; then
  echo "Node: ${NODE:-нет подходящего (нужен 20.19+, 22.12+ или 23+)}"
  [ -f "$SERVER/node_modules/chrome-devtools-mcp/package.json" ] && echo "сервер: установлен" || echo "сервер: нет"
  for p in "${PROFILES[@]}"; do grep -q "browser:start" "$DSH/profiles/$p/cordis.patch.yml" 2>/dev/null && echo "профиль $p: подключён" || echo "профиль $p: нет"; done
  grep -q "browser-rules:start" "$DSH/AGENTS.md" 2>/dev/null && echo "правила: есть" || echo "правила: нет"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "основной Chrome: порт $PORT открыт"; else echo "основной Chrome: порт $PORT закрыт — включите галочку в chrome://inspect/#remote-debugging"; fi
  exit 0
fi

[ -n "$NODE" ] || { echo "Нужен Node.js 22.12 или новее (nodejs.org, версия LTS) — или приложение DeepSeek Harness."; exit 1; }
[ ${#PROFILES[@]} -gt 0 ] || { echo "Не нашёл профилей в $DSH/profiles — запустите DeepSeek Harness хотя бы раз."; exit 1; }

# Убрать старый блок между метками; при установке — дописать новый с подставленными путями.
patch_profile() {
  local file="$DSH/profiles/$1/cordis.patch.yml"
  [ -f "$file" ] || { echo "нет профиля: $1"; return; }
  "$NODE" - "$file" "$START" "$END" "$MODE" "$HERE/chrome.cordis.yml" "$NODE" "$SERVER" "$DSH" "$PORT" <<'EOF'
const fs = require('node:fs');
const [file, start, end, mode, tpl, node, server, dsh, port] = process.argv.slice(2);
let s = fs.readFileSync(file, 'utf8');
for (const st of [start, '# browser:start']) {
  const i = s.indexOf(st), j = s.indexOf(end, i);
  if (i >= 0 && j > i) s = s.slice(0, i) + s.slice(j + end.length + 1);
}
s = s.replace(/^\[\]\s*$/m, '').replace(/\n+$/, '\n');
if (mode === 'install') {
  const block = fs.readFileSync(tpl, 'utf8').replaceAll('__NODE__', node).replaceAll('__SERVER__', server)
    .replaceAll('__DSH__', dsh).replaceAll('__PORT__', port).replace(/\n+$/, '\n');
  s += `${start}\n${block}${end}\n`;
}
fs.writeFileSync(file, s);
EOF
  echo "профиль $1: $([ $MODE = uninstall ] && echo убран || echo подключён)"
}

# Правила для модели — блок в $DSH/AGENTS.md: их DeepSeek видит в каждой сессии.
patch_agents() {
  "$NODE" - "$DSH/AGENTS.md" "$MODE" "$HERE/AGENTS.browser.md" <<'EOF'
const fs = require('node:fs');
const [file, mode, block] = process.argv.slice(2);
const start = '<!-- browser-rules:start -->', end = '<!-- browser-rules:end -->';
let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const i = s.indexOf(start), j = s.indexOf(end);
if (i >= 0 && j > i) s = s.slice(0, i) + s.slice(j + end.length);
s = s.replace(/\n{3,}/g, '\n\n').trim();
if (mode === 'install') s = (s ? s + '\n\n' : '') + fs.readFileSync(block, 'utf8').trim();
fs.writeFileSync(file, s ? s + '\n' : '');
EOF
}

if [ $MODE = install ]; then
  command -v npm >/dev/null || { echo "Нужен npm — он ставится вместе с Node.js (nodejs.org)."; exit 1; }
  mkdir -p "$SERVER" "$DSH/browser" "$DSH/chrome-profile"
  [ -f "$SERVER/package.json" ] || echo '{"private":true}' > "$SERVER/package.json"
  (cd "$SERVER" && npm install --no-fund --no-audit --loglevel=error --engine-strict=false \
    "chrome-devtools-mcp@$SERVER_VERSION" "@modelcontextprotocol/sdk@$SDK_VERSION" >/dev/null)
  cp "$HERE/visual-proxy.mjs" "$SERVER/visual-proxy.mjs"
  cp "$HERE/guard.mjs" "$DSH/browser/guard.mjs"
  "$NODE" -e '
const [file, node, guard] = process.argv.slice(1);
const hooks = { hooks: { PreToolUse: [{ matcher: "mcp__chrome.*", hooks: [{ type: "command", command: `${JSON.stringify(node)} ${JSON.stringify(guard)}`, timeout: 10 }] }] } };
require("node:fs").writeFileSync(file, JSON.stringify(hooks, null, 2) + "\n");' "$DSH/browser/hooks.json" "$NODE" "$DSH/browser/guard.mjs"
  echo "сервер chrome-devtools-mcp $SERVER_VERSION, курсор и сторож — в $DSH"
fi

for p in "${PROFILES[@]}"; do patch_profile "$p"; done
patch_agents
if [ $MODE = install ]; then
  echo "правила для модели — в $DSH/AGENTS.md"
  echo
  echo "Осталось два шага руками:"
  echo "1. Перезапустите DeepSeek Harness — инструменты браузера появятся после перезапуска."
  echo "2. Чтобы работать в вашем основном Chrome: откройте в нём chrome://inspect/#remote-debugging,"
  echo "   включите галочку удалённой отладки и разрешите подключение, когда Chrome спросит."
  echo "   Без этого работает только отдельный Chrome."
else
  rm -rf "$DSH/browser" "$SERVER"
  echo "навык отключён; профиль отдельного Chrome оставлен: $DSH/chrome-profile"
fi
