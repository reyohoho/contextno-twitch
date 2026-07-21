"use strict";

/*
 * OBS browser-source widget for the "Контекст" game.
 *
 * Query parameters:
 *   channel  — twitch channel name (required)         e.g. ?channel=olegsvs
 *   sound    — win sound on/off (default: off)         &sound=1
 *   volume   — win sound volume in percent (def: 25)    &volume=25
 *              (values above 100 are boosted via WebAudio gain)
 *   delay    — seconds winners stay on screen after a   &delay=8
 *              win before the next round (default: 8)
 *   rows     — max guesses shown on screen (default 12) &rows=12
 *
 * Behaviour: on load the widget connects to the channel chat, auto-rolls a
 * random word, chat guesses it, then after `delay` seconds the winners are
 * shown and a fresh round starts automatically — no page interaction needed.
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

  return {
    channel: (p.get("channel") || "").trim().toLowerCase().replace(/^#/, ""),
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
  twitch: { ws: null, channel: null, status: "disconnected" },
  autoRestartTimer: null,
  winnerWinsAlltime: new Map(),
  winnerWinsToday: new Map(),
  winnerWinsTodayDate: "",
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

function setWinStatus(word, nick = null, extra = "") {
  const nickHtml = nick
    ? ` · <span class="win-nick">@${escapeHtml(nick)}</span>`
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
  const nickEl = el.querySelector(".nick");
  if (g.nick) {
    nickEl.textContent = "@" + g.nick;
  } else {
    nickEl.hidden = true;
  }
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
  if (i >= 0) {
    state.guesses[i] = { ...state.guesses[i], ...rec };
  } else {
    if (g.nick) rec.nick = g.nick;
    state.guesses.push(rec);
  }
}

/* ---------- winners leaderboards (localStorage) ---------- */

const WINNERS_ALLTIME_KEY = "contextnorf:winners";
const WINNERS_TODAY_KEY = "contextnorf:winners_today";
const LEGACY_WINNERS_KEY = "contextnorf:session_wins";

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

function recordWinner(nick) {
  if (!nick) return;
  state.winnerWinsAlltime.set(nick, (state.winnerWinsAlltime.get(nick) || 0) + 1);
  syncTodayWinnersDate();
  state.winnerWinsToday.set(nick, (state.winnerWinsToday.get(nick) || 0) + 1);
  saveWinnersAlltime();
  saveWinnersToday();
  renderWinnersLeaderboards();
}

function resetWinnersStats() {
  state.winnerWinsAlltime = new Map();
  syncTodayWinnersDate();
  state.winnerWinsToday = new Map();
  saveWinnersAlltime();
  saveWinnersToday();
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
      <span class="session-nick">@${nick}</span>
      <span class="session-wins" title="${fmtInt(wins)} ${pluralWinsRu(wins)}">${fmtInt(wins)}</span>
    `;
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

function scheduleAutoRestart(wordOrMsg, nick) {
  cancelAutoRestartTimer();
  renderWinnersLeaderboards();
  let remaining = config.delay;
  const useWinStatus = arguments.length >= 2;
  const tick = () => {
    const extra = `новый раунд через ${remaining} сек`;
    if (useWinStatus) setWinStatus(wordOrMsg, nick, extra);
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

async function sendGuess(word, nick = null) {
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

    upsertGuess({ ...r, nick });
    markWordEntered();

    if (r.won) {
      state.won = true;
      if (nick) recordWinner(nick);
      playWinSound();
      render({ freshWord: r.word });
      renderWinnersLeaderboards();
      scheduleAutoRestart(r.word, nick);
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

/* ---------- twitch chat ---------- */

function setTwitchStatus(status, channel = state.twitch.channel) {
  state.twitch.status = status;
  const led = $("#twitch-led");
  if (!led) return;
  led.classList.remove("connecting", "connected");
  if (status === "connecting") led.classList.add("connecting");
  if (status === "connected") led.classList.add("connected");
  const titles = {
    disconnected: "не подключено",
    connecting: `подключение к #${channel}...`,
    connected: `подключено к #${channel}`,
  };
  led.title = titles[status] || "";
}

function parseIrcLine(line) {
  let tags = {};
  if (line.startsWith("@")) {
    const sp = line.indexOf(" ");
    line.slice(1, sp).split(";").forEach((p) => {
      const i = p.indexOf("=");
      if (i < 0) tags[p] = "";
      else tags[p.slice(0, i)] = p.slice(i + 1);
    });
    line = line.slice(sp + 1);
  }
  let prefix = "";
  if (line.startsWith(":")) {
    const sp = line.indexOf(" ");
    prefix = line.slice(1, sp);
    line = line.slice(sp + 1);
  }
  let trailing = "";
  const ti = line.indexOf(" :");
  let mid = line;
  if (ti >= 0) {
    mid = line.slice(0, ti);
    trailing = line.slice(ti + 2);
  }
  const parts = mid.split(" ");
  return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
}

function extractWord(text) {
  const t = (text || "").trim().toLowerCase();
  if (!/^[а-яё]+$/.test(t)) return null;
  if (t.length < 2 || t.length > 30) return null;
  return t;
}

function isPrivilegedChatter(tags, login, display) {
  const badges = tags.badges || "";
  if (badges.includes("broadcaster/") || badges.includes("moderator/")) return true;
  if (tags.mod === "1") return true;
  const l = (login || "").toLowerCase();
  const d = (display || "").toLowerCase();
  return PRIVILEGED_CHAT_LOGINS.has(l) || PRIVILEGED_CHAT_LOGINS.has(d);
}

function parseChatCommand(text) {
  const cmd = (text || "").trim().toLowerCase();
  if (cmd === "!context_hint") return "hint";
  if (cmd === "!context_restart") return "restart";
  if (cmd === "!context_reload") return "reload";
  if (cmd === "!context_reset_stats") return "reset_stats";
  return null;
}

function connectTwitch(channel) {
  channel = (channel || "").trim().toLowerCase().replace(/^#/, "");
  if (!channel) return;
  state.twitch.channel = channel;
  setTwitchStatus("connecting", channel);

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  state.twitch.ws = ws;

  const markConnected = () => {
    if (state.twitch.status !== "connected") {
      setTwitchStatus("connected", channel);
    }
  };

  ws.onopen = () => {
    const nick = `justinfan${Math.floor(Math.random() * 90000 + 10000)}`;
    ws.send("CAP REQ :twitch.tv/tags");
    ws.send("PASS SCHMOOPIIE");
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN #${channel}`);
  };

  ws.onmessage = (ev) => {
    const lines = ev.data.split("\r\n").filter(Boolean);
    for (const raw of lines) {
      if (raw.startsWith("PING")) {
        ws.send(raw.replace("PING", "PONG"));
        continue;
      }
      const m = parseIrcLine(raw);
      if (m.command === "366" || m.command === "JOIN" || m.command === "PRIVMSG") {
        markConnected();
      }
      if (m.command === "PRIVMSG") {
        const nickFromPrefix = m.prefix.split("!")[0];
        const display = m.tags["display-name"] || nickFromPrefix;
        const chatCmd = parseChatCommand(m.trailing);
        if (chatCmd && isPrivilegedChatter(m.tags, nickFromPrefix, display)) {
          if (chatCmd === "hint") getTip();
          else if (chatCmd === "restart") giveUp();
          else if (chatCmd === "reload") location.reload();
          else if (chatCmd === "reset_stats") resetWinnersStats();
          continue;
        }
        const word = extractWord(m.trailing);
        if (!word) continue;
        if (!state.game || state.won) continue;
        sendGuess(word, display);
      }
    }
  };

  ws.onclose = () => {
    if (state.twitch.ws === ws) {
      state.twitch.ws = null;
      setTwitchStatus("disconnected", null);
      // Auto-reconnect: the widget should stay live unattended.
      setTimeout(() => {
        if (!state.twitch.ws) connectTwitch(channel);
      }, 3000);
    }
  };

  ws.onerror = () => {};
}

/* ---------- setup / boot ---------- */

function showSetupHelp() {
  const el = $("#widget-setup");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <b>Не указан канал.</b><br />
    Добавьте название twitch-канала в адрес источника OBS:<br />
    <code>?channel=имя_канала</code><br /><br />
    <b>Параметры:</b><br />
    <code>channel</code> — канал twitch (обязательно)<br />
    <code>sound</code> — звук победы, <code>1</code>/<code>0</code> (по умолчанию выкл)<br />
    <code>volume</code> — громкость в процентах (по умолчанию 25)<br />
    <code>delay</code> — сколько секунд показывать победителей (по умолчанию 8)<br />
    <code>rows</code> — сколько вариантов показывать (по умолчанию 12)<br /><br />
    Пример:<br />
    <code>?channel=olegsvs&sound=1&volume=25&delay=8</code><br /><br />
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

  if (!config.channel) {
    setStatus("укажите канал в query-параметрах", "error");
    $("#twitch-led")?.remove();
    showSetupHelp();
    return;
  }

  connectTwitch(config.channel);
  startRound();
})();
