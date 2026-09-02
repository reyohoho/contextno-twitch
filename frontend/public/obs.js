"use strict";

/*
 * OBS browser-source widget for the "Контекст" game.
 *
 * Query parameters:
 *   twitch / vkvideo / kick / wtv — каналы платформ, можно несколько сразу
 *                                   e.g. ?twitch=olegsvs&vkvideo=foo&kick=bar
 *   channel  — legacy: один канал (вместе с server)
 *   server   — legacy: twitch | vkvideo | kick | wtv (default twitch)
 *   sound    — win sound on/off (default: off)         &sound=1
 *   volume   — win sound volume in percent (def: 25)    &volume=25
 *   delay    — seconds winners stay on screen after a   &delay=8
 *   rows     — max guesses shown on screen (default 12) &rows=12
 *
 * Behaviour: on load the widget connects to all given chats, auto-rolls a
 * random word, chat guesses it, then after `delay` seconds the winners are
 * shown and a fresh round starts automatically.
 */

const API = "/api";

const PRIVILEGED_CHAT_LOGINS = new Set(["olegsvs"]);

const DEFAULT_DELAY = 8;
const DEFAULT_VOLUME = 0.25;
const DEFAULT_ROWS = 12;

const $ = (sel) => document.querySelector(sel);

function readConfig() {
  const p = new URLSearchParams(location.search);

  const boolParam = (name, def) => {
    const v = p.get(name);
    if (v === null) return def;
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes";
  };

  const numParam = (name, def, { min = 0, scale = 1 } = {}) => {
    const v = parseFloat(p.get(name));
    if (!Number.isFinite(v)) return def;
    return Math.max(min, v * scale);
  };

  const intParam = (name, def, { min = 1 } = {}) => {
    const v = parseInt(p.get(name), 10);
    if (!Number.isFinite(v)) return def;
    return Math.max(min, v);
  };

  const chats = ChatClient.parseChatsFromSearch(p);

  return {
    chats,
    sound: boolParam("sound", false),
    volume: numParam("volume", DEFAULT_VOLUME, { min: 0, scale: 0.01 }),
    delay: intParam("delay", DEFAULT_DELAY, { min: 1 }),
    rows: intParam("rows", DEFAULT_ROWS, { min: 1 }),
  };
}

const config = readConfig();

const state = {
  game: null,
  guesses: [],
  won: false,
  tipsUsed: 0,
  chat: { errors: {} },
  autoRestartTimer: null,
  winnerWinsAlltime: new Map(),
  winnerWinsToday: new Map(),
  winnerWinsTodayDate: "",
  winnerPlatforms: new Map(),
  roundHasWord: false,
  audioCtx: null,
  starting: false,
};

async function api(path, opts = {}) {
  const init = {
    headers: { "Content-Type": "application/json" },
    ...opts,
  };
  const res = await fetch(API + path, init);
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const detail = data && (data.detail || data.error);
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return data;
}

function setStatus(text, kind = "", { html = false } = {}) {
  const el = $("#status");
  if (html) el.innerHTML = text;
  else el.textContent = text;
  el.className = "widget-status" + (kind ? " " + kind : "");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setWinStatus(word, nick = null, extra = "", platform = null) {
  const nickHtml = nick
    ? ` · <span class="win-nick">${ChatClient.nickHtml(nick, platform)}</span>`
    : "";
  const extraHtml = extra ? ` · ${escapeHtml(extra)}` : "";
  setStatus(
    `угадано: <b>${escapeHtml(word)}</b> (#1)${nickHtml}${extraHtml}`,
    "win",
    { html: true }
  );
}

function resetBoard() {
  state.game = null;
  state.guesses = [];
  state.tipsUsed = 0;
  state.won = false;
  state.roundHasWord = false;
  $("#guesses").innerHTML = "";
  $("#last-guess").innerHTML = "";
  $("#counter-guesses").textContent = "0";
  $("#counter-tips").textContent = "0";
}

/* ---------- win sound (Web Audio so volume can exceed 100%) ---------- */

function playWinSound() {
  if (!config.sound) return;
  try {
    const audio = new Audio("/song.mp3");
    if (config.volume <= 1) {
      audio.volume = config.volume;
      audio.play().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      audio.volume = 1;
      audio.play().catch(() => {});
      return;
    }
    if (!state.audioCtx) state.audioCtx = new Ctx();
    const ctx = state.audioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const src = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = config.volume;
    src.connect(gain).connect(ctx.destination);
    audio.play().catch(() => {});
  } catch (_) {}
}

/* ---------- guess rendering (shared visual style with main app) ---------- */

function fmtInt(n) {
  return Number(n).toLocaleString("ru-RU");
}

function updateCounters() {
  const guesses = state.guesses.filter((g) => !g.tip).length;
  $("#counter-guesses").textContent = String(guesses);
  $("#counter-tips").textContent = String(state.tipsUsed);
}

function rankTier(rank) {
  if (rank <= 300) return "tier-hot";
  if (rank <= 1500) return "tier-warm";
  return "tier-cold";
}

function rowEl(g, num, opts = {}) {
  const TOTAL = 50000;
  const closeness = Math.max(
    0,
    Math.min(1, 1 - Math.log10(Math.max(1, g.rank)) / Math.log10(TOTAL))
  );
  const fresh = opts.fresh ? " fresh" : "";
  const isWin = g.rank === 1 ? " win" : "";
  const isTip = g.tip ? " tip" : "";
  const tier = " " + rankTier(g.rank);
  const el = document.createElement("div");
  el.className = `row${isTip}${isWin}${tier}${fresh}`;
  el.innerHTML = `
    <span class="num">${num}</span>
    <span class="word-cell">
      <span class="word"></span>
      <span class="nick"></span>
    </span>
    <span class="rank">#${fmtInt(g.rank)}</span>
    <span class="bar" style="width:${(closeness * 100).toFixed(1)}%"></span>
  `;
  el.querySelector(".word").textContent = g.word;
  ChatClient.fillNickEl(el.querySelector(".nick"), g.nick, g.platform);
  return el;
}

function render({ freshWord } = {}) {
  const list = $("#guesses");
  list.innerHTML = "";
  const sorted = [...state.guesses].sort((a, b) => a.rank - b.rank);
  sorted.slice(0, config.rows).forEach((g, i) => {
    list.appendChild(
      rowEl(g, i + 1, {
        fresh: freshWord && g.word === freshWord,
      })
    );
  });

  const last = $("#last-guess");
  last.innerHTML = "";
  if (freshWord) {
    const g = state.guesses.find((x) => x.word === freshWord);
    if (g) {
      const el = rowEl(g, "·");
      el.classList.add("fresh");
      last.appendChild(el);
    }
  }
  updateCounters();
  $("#counters").hidden = false;
}

function upsertGuess(g) {
  const i = state.guesses.findIndex((x) => x.word === g.word);
  const rec = { word: g.word, rank: g.rank, tip: !!g.tip };
  if (g.nick) rec.nick = g.nick;
  if (g.platform) rec.platform = g.platform;
  if (i >= 0) {
    state.guesses[i] = { ...state.guesses[i], ...rec };
  } else {
    state.guesses.push(rec);
  }
}

/* ---------- winners leaderboards (localStorage) ---------- */

const WINNERS_ALLTIME_KEY = "contextnorf:winners";
const WINNERS_TODAY_KEY = "contextnorf:winners_today";
const LEGACY_WINNERS_KEY = "contextnorf:session_wins";
const WINNERS_PLATFORMS_KEY = "contextnorf:winner_platforms";

function parseWinnersMap(raw) {
  try {
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return new Map();
    return new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]));
  } catch (_) {
    return new Map();
  }
}

function todayDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function syncTodayWinnersDate() {
  const today = todayDateKey();
  if (state.winnerWinsTodayDate === today) return;
  state.winnerWinsTodayDate = today;
  state.winnerWinsToday = new Map();
}

function loadWinnersAlltime() {
  try {
    const raw = localStorage.getItem(WINNERS_ALLTIME_KEY);
    if (raw) return parseWinnersMap(raw);
  } catch (_) {}
  try {
    const legacy =
      localStorage.getItem(LEGACY_WINNERS_KEY) ||
      sessionStorage.getItem(LEGACY_WINNERS_KEY) ||
      sessionStorage.getItem(WINNERS_ALLTIME_KEY);
    if (legacy) {
      const map = parseWinnersMap(legacy);
      saveWinnersAlltime(map);
      return map;
    }
  } catch (_) {}
  return new Map();
}

function loadWinnersToday() {
  const today = todayDateKey();
  try {
    const raw = localStorage.getItem(WINNERS_TODAY_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.date === today && data.winners) {
        return { date: today, map: parseWinnersMap(JSON.stringify(data.winners)) };
      }
    }
  } catch (_) {}
  return { date: today, map: new Map() };
}

function saveWinnersAlltime(map = state.winnerWinsAlltime) {
  try {
    localStorage.setItem(WINNERS_ALLTIME_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch (_) {}
}

function saveWinnersToday() {
  syncTodayWinnersDate();
  try {
    localStorage.setItem(
      WINNERS_TODAY_KEY,
      JSON.stringify({
        date: state.winnerWinsTodayDate,
        winners: Object.fromEntries(state.winnerWinsToday),
      })
    );
  } catch (_) {}
}

function loadWinnerPlatforms() {
  try {
    const raw = localStorage.getItem(WINNERS_PLATFORMS_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return new Map();
    return new Map(
      Object.entries(obj).filter(([_, server]) =>
        ChatClient.CHAT_SERVERS.some((s) => s.id === server)
      )
    );
  } catch (_) {
    return new Map();
  }
}

function saveWinnerPlatforms(map = state.winnerPlatforms) {
  try {
    localStorage.setItem(
      WINNERS_PLATFORMS_KEY,
      JSON.stringify(Object.fromEntries(map))
    );
  } catch (_) {}
}

function recordWinner(nick, platform) {
  if (!nick) return;
  state.winnerWinsAlltime.set(nick, (state.winnerWinsAlltime.get(nick) || 0) + 1);
  syncTodayWinnersDate();
  state.winnerWinsToday.set(nick, (state.winnerWinsToday.get(nick) || 0) + 1);
  if (platform && ChatClient.CHAT_SERVERS.some((s) => s.id === platform)) {
    state.winnerPlatforms.set(nick, platform);
    saveWinnerPlatforms();
  }
  saveWinnersAlltime();
  saveWinnersToday();
  renderWinnersLeaderboards();
}

function resetWinnersStats() {
  state.winnerWinsAlltime = new Map();
  syncTodayWinnersDate();
  state.winnerWinsToday = new Map();
  state.winnerPlatforms = new Map();
  saveWinnersAlltime();
  saveWinnersToday();
  saveWinnerPlatforms();
  renderWinnersLeaderboards();
  setStatus("статистика победителей сброшена");
}

function pluralWinsRu(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "раз";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "раза";
  return "раз";
}

function renderOneWinnersBoard(section, list, map) {
  if (!section || !list) return;
  const entries = [...map.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")
  );
  list.innerHTML = "";
  if (!entries.length) {
    section.hidden = true;
    return;
  }
  for (let i = 0; i < Math.min(entries.length, 10); i++) {
    const [nick, wins] = entries[i];
    const li = document.createElement("li");
    li.className = "session-leaderboard-row";
    li.innerHTML = `
      <span class="session-rank">${i + 1}</span>
      <span class="session-nick"></span>
      <span class="session-wins" title="${fmtInt(wins)} ${pluralWinsRu(wins)}">${fmtInt(wins)}</span>
    `;
    ChatClient.fillNickEl(
      li.querySelector(".session-nick"),
      nick,
      state.winnerPlatforms.get(nick)
    );
    list.appendChild(li);
  }
  section.hidden = false;
}

function shouldShowWinnersBoards() {
  if (state.winnerWinsToday.size === 0 && state.winnerWinsAlltime.size === 0) {
    return false;
  }
  if (state.won) return true;
  return !!state.game && !state.roundHasWord;
}

function renderWinnersLeaderboards() {
  syncTodayWinnersDate();
  renderOneWinnersBoard($("#winners-today"), $("#winners-today-list"), state.winnerWinsToday);
  renderOneWinnersBoard($("#winners-alltime"), $("#winners-alltime-list"), state.winnerWinsAlltime);
  const wrap = $("#winners-boards");
  if (wrap) wrap.hidden = !shouldShowWinnersBoards();
}

function markWordEntered() {
  if (state.roundHasWord) return;
  state.roundHasWord = true;
  renderWinnersLeaderboards();
}

/* ---------- round flow ---------- */

function cancelAutoRestartTimer() {
  if (state.autoRestartTimer) {
    clearInterval(state.autoRestartTimer);
    state.autoRestartTimer = null;
  }
}

function scheduleAutoRestart(wordOrMsg, nick, platform) {
  cancelAutoRestartTimer();
  renderWinnersLeaderboards();
  let remaining = config.delay;
  const useWinStatus = arguments.length >= 2;
  const tick = () => {
    const extra = `новый раунд через ${remaining} сек`;
    if (useWinStatus) setWinStatus(wordOrMsg, nick, extra, platform);
    else setStatus(`${wordOrMsg} · ${extra}`, "win");
  };
  tick();
  state.autoRestartTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelAutoRestartTimer();
      startRound();
    } else {
      tick();
    }
  }, 1000);
}

async function startRound() {
  if (state.starting) return;
  state.starting = true;
  cancelAutoRestartTimer();
  resetBoard();
  setStatus("новая случайная игра...");
  renderWinnersLeaderboards();
  try {
    const data = await api("/games", {
      method: "POST",
      body: JSON.stringify({ mode: "random", secret: null }),
    });
    state.game = { game_id: data.game_id };
    setStatus("угадайте слово в чате");
    render();
    renderWinnersLeaderboards();
  } catch (e) {
    setStatus(e.message, "error");
    // Retry the roll after the configured delay so the widget self-heals.
    scheduleRetry();
  } finally {
    state.starting = false;
  }
}

function scheduleRetry() {
  cancelAutoRestartTimer();
  let remaining = config.delay;
  state.autoRestartTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelAutoRestartTimer();
      startRound();
    }
  }, 1000);
}

async function sendGuess(word, nick = null, platform = null) {
  if (!state.game || state.won) return;
  word = (word || "").trim().toLowerCase();
  if (!word) return;
  if (state.guesses.some((g) => g.word === word && !g.tip)) return;

  try {
    const r = await api(`/games/${state.game.game_id}/guess`, {
      method: "POST",
      body: JSON.stringify({ word }),
    });
    if (r.error) return;
    if (r.rank === 0) {
      startRound();
      return;
    }

    upsertGuess({ ...r, nick, platform });
    markWordEntered();

    if (r.won) {
      state.won = true;
      if (nick) recordWinner(nick, platform);
      playWinSound();
      render({ freshWord: r.word });
      renderWinnersLeaderboards();
      scheduleAutoRestart(r.word, nick, platform);
    } else {
      render({ freshWord: r.word });
    }
  } catch (_) {}
}

async function getTip() {
  if (!state.game || state.won) return;
  try {
    const r = await api(`/games/${state.game.game_id}/tip`, { method: "POST" });
    if (r.error) return;
    state.tipsUsed = r.tips_used ?? state.tipsUsed + 1;
    upsertGuess({ ...r, tip: true });
    markWordEntered();
    setStatus(`подсказка: ${r.word} (#${fmtInt(r.rank)})`);
    render({ freshWord: r.word });
  } catch (_) {}
}

async function giveUp() {
  if (!state.game || state.won) return;
  try {
    const r = await api(`/games/${state.game.game_id}/give-up`, { method: "POST" });
    state.won = true;
    const overMsg = r.secret ? `загаданное слово: ${r.secret}` : "раунд завершён";
    renderWinnersLeaderboards();
    scheduleAutoRestart(overMsg);
  } catch (_) {}
}

/* ---------- chat ---------- */

function renderChatLeds() {
  const el = $("#chat-leds");
  if (!el) return;
  el.innerHTML = config.chats
    .map(
      (c) =>
        `<span class="widget-chat-icon" id="chat-led-${c.server}" title="${ChatClient.formatChatTarget(
          c.server,
          c.channel
        )}">${ChatClient.platformIconHtml(c.server)}</span>`
    )
    .join("");
}

function setChatStatus(status, server, channel) {
  const led = document.getElementById(`chat-led-${server}`);
  if (!led) return;
  led.classList.remove("connecting", "connected");
  if (status === "connecting") led.classList.add("connecting");
  else if (status === "connected") led.classList.add("connected");
  const target = ChatClient.formatChatTarget(server, channel);
  const titles = {
    disconnected: `${ChatClient.serverMeta(server).label}: не подключено`,
    connecting: `подключение к ${target}...`,
    connected: `подключено к ${target}`,
  };
  led.title = titles[status] || "";
}

function handleIncomingChat(msg) {
  const text = (msg && msg.text) || "";
  const user = (msg && msg.user) || {};
  const display = user.displayName || user.id || "chat";
  const chatCmd = ChatClient.parseChatCommand(text);
  if (
    chatCmd &&
    ChatClient.isPrivilegedChatMessage(
      msg,
      PRIVILEGED_CHAT_LOGINS,
      msg && msg.channel
    )
  ) {
    if (chatCmd === "hint") getTip();
    else if (chatCmd === "restart") giveUp();
    else if (chatCmd === "reload") location.reload();
    else if (chatCmd === "reset_stats") resetWinnersStats();
    return;
  }
  const word = ChatClient.extractWord(text);
  if (!word) return;
  if (!state.game || state.won) return;
  sendGuess(word, display, msg.server);
}

const chatHub = ChatClient.createChatHub({
  onStatus: setChatStatus,
  onError: (text, server) => {
    const label = server ? `${ChatClient.serverMeta(server).label}: ` : "";
    setStatus(label + text, "error");
  },
  onClearError: () => {
    if ($("#status")?.classList.contains("error")) {
      setStatus("угадайте слово в чате");
    }
  },
  onMessage: handleIncomingChat,
  autoReconnect: true,
});

/* ---------- setup / boot ---------- */

function showSetupHelp() {
  const el = $("#widget-setup");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <b>Не указан канал.</b><br />
    Добавьте каналы в адрес источника OBS — можно несколько сразу:<br />
    <code>?twitch=имя&amp;vkvideo=имя&amp;kick=имя&amp;wtv=имя</code><br /><br />
    <b>Параметры:</b><br />
    <code>twitch</code>, <code>vkvideo</code>, <code>kick</code>, <code>wtv</code> — каналы платформ<br />
    <code>channel</code> + <code>server</code> — старый формат одного чата<br />
    <code>sound</code> — звук победы, <code>1</code>/<code>0</code> (по умолчанию выкл)<br />
    <code>volume</code> — громкость в процентах (по умолчанию 25)<br />
    <code>delay</code> — сколько секунд показывать победителей (по умолчанию 8)<br />
    <code>rows</code> — сколько вариантов показывать (по умолчанию 12)<br /><br />
    Примеры:<br />
    <code>?twitch=olegsvs&amp;vkvideo=канал&amp;sound=1</code><br />
    <code>?channel=olegsvs</code> (только Twitch, как раньше)<br /><br />
    <b>Команды в чате (модераторы, владелец):</b><br />
    <code>!context_hint</code> — подсказка<br />
    <code>!context_restart</code> — сдаться и показать слово<br />
    <code>!context_reload</code> — перезагрузить виджет<br />
    <code>!context_reset_stats</code> — сбросить статистику победителей
  `;
}

(function init() {
  state.winnerWinsAlltime = loadWinnersAlltime();
  const today = loadWinnersToday();
  state.winnerWinsTodayDate = today.date;
  state.winnerWinsToday = today.map;
  state.winnerPlatforms = loadWinnerPlatforms();

  if (!config.chats.length) {
    setStatus("укажите каналы в query-параметрах", "error");
    $("#chat-leds")?.remove();
    showSetupHelp();
    return;
  }

  renderChatLeds();
  chatHub.connectMany(config.chats);
  startRound();
})();
