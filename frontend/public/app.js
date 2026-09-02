"use strict";

const API = "/api";
const AUTHOR_ID_KEY = "contextnorf:author_id";
const TWITCH_CHANNEL_KEY = "contextnorf:twitch_channel";
const CHAT_SERVER_KEY = "contextnorf:chat_server";
const CHAT_CHANNEL_KEY = "contextnorf:chat_channel";
const CHAT_TARGETS_KEY = "contextnorf:chats";
const HANDS_OFF_KEY = "contextnorf:hands_off";
const WINNERS_ALLTIME_KEY = "contextnorf:winners";
const WINNERS_TODAY_KEY = "contextnorf:winners_today";
const LEGACY_WINNERS_KEY = "contextnorf:session_wins";
const SECRET_HISTORY_KEY = "contextnorf:secret_history";
const WIN_SOUND_KEY = "contextnorf:win_sound";
const SOUND_VOLUME_KEY = "contextnorf:sound_volume";
const WINNERS_PLATFORMS_KEY = "contextnorf:winner_platforms";

const PRIVILEGED_CHAT_LOGINS = new Set(["olegsvs"]);

const HANDS_OFF_DELAY = 10;
const DEFAULT_SOUND_VOLUME = 0.5;
const SECRET_HISTORY_MAX = 30;

const $ = (sel) => document.querySelector(sel);

const state = {
  game: null,
  guesses: [],
  won: false,
  tipsUsed: 0,
  chat: { savedStatus: null, errors: {} },
  paused: false,
  gameEpoch: 0,
  handsOff: false,
  autoRestartTimer: null,
  winnerWinsAlltime: new Map(),
  winnerWinsToday: new Map(),
  winnerWinsTodayDate: "",
  winnerPlatforms: new Map(),
  roundHasWord: false,
  gameKind: "random", // random | custom
  secretRevealed: false,
  winSound: true,
  soundVolume: DEFAULT_SOUND_VOLUME,
  secretHistory: [],
};

function uuidv4() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const r = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(r);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = [...r].map((b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h
    .slice(6, 8)
    .join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

function getAuthorId() {
  let id;
  try {
    id = localStorage.getItem(AUTHOR_ID_KEY);
  } catch (_) {}
  if (id) return id;
  id = uuidv4();
  try {
    localStorage.setItem(AUTHOR_ID_KEY, id);
  } catch (_) {}
  return id;
}

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

function setMode(mode) {
  const blocks = {
    secret: $("#secret-form"),
    actions: $("#game-actions"),
    guess: $("#guess-form"),
    guessInput: $("#guess-input"),
    guessSubmit: $("#guess-submit"),
    counters: $("#counters"),
    tip: $("#tip-btn"),
    giveup: $("#give-up-btn"),
    restart: $("#restart-btn"),
  };

  blocks.secret.hidden = true;
  blocks.actions.hidden = true;
  blocks.guess.hidden = true;
  blocks.counters.hidden = true;
  blocks.tip.hidden = true;
  blocks.giveup.hidden = true;
  blocks.restart.hidden = true;
  blocks.guessInput.disabled = true;
  blocks.guessSubmit.disabled = true;

  if (mode === "secret") {
    blocks.secret.hidden = false;
    blocks.guess.hidden = false;
    setSecretRevealed(false);
    setTimeout(() => $("#secret-input").focus(), 0);
    return;
  }

  if (mode === "playing") {
    blocks.actions.hidden = false;
    blocks.guess.hidden = false;
    blocks.counters.hidden = false;
    blocks.tip.hidden = false;
    blocks.giveup.hidden = false;
    blocks.guessInput.disabled = false;
    blocks.guessSubmit.disabled = false;
    setTimeout(() => $("#guess-input").focus(), 0);
    return;
  }

  if (mode === "over") {
    blocks.actions.hidden = false;
    blocks.counters.hidden = false;
    blocks.restart.hidden = false;
    return;
  }
}

function updateSecretDisplay() {
  const input = $("#secret-input");
  const display = $("#secret-display");
  const btn = $("#secret-reveal-btn");
  if (!input || !display) return;
  const hasValue = !!input.value;
  const focused = document.activeElement === input;
  const revealed = state.secretRevealed && hasValue;

  if (!hasValue) {
    display.textContent = "введите своё слово";
  } else if (revealed) {
    display.textContent = input.value;
  } else {
    display.textContent = "●";
  }

  display.classList.toggle("has-value", hasValue);
  display.classList.toggle("revealed", revealed);
  display.classList.toggle("focused", focused);

  if (btn) {
    btn.setAttribute("aria-pressed", state.secretRevealed ? "true" : "false");
    btn.setAttribute(
      "aria-label",
      state.secretRevealed ? "скрыть слово" : "показать слово"
    );
    btn.title = state.secretRevealed ? "скрыть слово" : "показать слово";
    const showIcon = btn.querySelector(".secret-reveal-icon-show");
    const hideIcon = btn.querySelector(".secret-reveal-icon-hide");
    if (showIcon) showIcon.hidden = state.secretRevealed;
    if (hideIcon) hideIcon.hidden = !state.secretRevealed;
  }
}

function setSecretRevealed(revealed) {
  state.secretRevealed = !!revealed;
  updateSecretDisplay();
}

function loadSecretHistory() {
  try {
    const raw = localStorage.getItem(SECRET_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((w) => String(w || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, SECRET_HISTORY_MAX);
  } catch (_) {
    return [];
  }
}

function saveSecretHistory(list = state.secretHistory) {
  try {
    localStorage.setItem(SECRET_HISTORY_KEY, JSON.stringify(list));
  } catch (_) {}
}

function rememberSecretWord(word) {
  word = (word || "").trim().toLowerCase();
  if (!word) return;
  state.secretHistory = [
    word,
    ...state.secretHistory.filter((w) => w !== word),
  ].slice(0, SECRET_HISTORY_MAX);
  saveSecretHistory();
}

function clearSecretHistory() {
  if (!state.secretHistory.length) return;
  if (!confirm("очистить историю своих слов?")) return;
  state.secretHistory = [];
  saveSecretHistory();
  renderSecretHistory();
}

function openSecretHistoryModal() {
  renderSecretHistory();
  const modal = $("#secret-history-modal");
  if (modal) modal.hidden = false;
}

function closeSecretHistoryModal() {
  const modal = $("#secret-history-modal");
  if (modal) modal.hidden = true;
}

function renderSecretHistory() {
  const list = $("#secret-history-list");
  const empty = $("#secret-history-empty");
  const clearBtn = $("#secret-history-clear");
  if (!list) return;

  list.innerHTML = "";
  const hasItems = state.secretHistory.length > 0;
  if (empty) empty.hidden = hasItems;
  if (clearBtn) clearBtn.hidden = !hasItems;

  for (const word of state.secretHistory) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secret-history-item";
    btn.textContent = word;
    btn.title = `загадать снова: ${word}`;
    btn.addEventListener("click", () => {
      closeSecretHistoryModal();
      startGame({ secret: word });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function setupSecretHistoryModal() {
  const modal = $("#secret-history-modal");
  if (!modal) return;

  $("#secret-history-btn")?.addEventListener("click", openSecretHistoryModal);
  $("#secret-history-modal-close")?.addEventListener("click", closeSecretHistoryModal);
  $("#secret-history-clear")?.addEventListener("click", clearSecretHistory);
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeSecretHistoryModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) closeSecretHistoryModal();
  });
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

function setStatus(text, kind = "", { html = false } = {}) {
  const el = $("#status");
  if (html) el.innerHTML = text;
  else el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
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

function playWinSound() {
  if (!state.winSound) return;
  try {
    const audio = new Audio("/song.mp3");
    audio.volume = state.soundVolume;
    audio.play().catch(() => {});
  } catch (_) {}
}

function fmtInt(n) {
  return Number(n).toLocaleString("ru-RU");
}

function updateCounters() {
  const guesses = state.guesses.filter((g) => !g.tip).length;
  $("#counter-guesses").textContent = String(guesses);
  $("#counter-tips").textContent = String(state.tipsUsed);
  const modeEl = $("#counter-mode");
  if (modeEl) modeEl.textContent = currentModeLabel();
}

function currentModeLabel() {
  if (state.gameKind === "custom") return "своё слово";
  if (isAutoPlay()) return "автоигра";
  return "случайное слово";
}

function isAutoPlay() {
  return state.handsOff && state.gameKind === "random";
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
  const cls = `row${isTip}${isWin}${tier}${fresh}`;

  const el = document.createElement("div");
  el.className = cls;
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
  sorted.forEach((g, i) => {
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

async function startGame({ secret = null } = {}) {
  const epoch = ++state.gameEpoch;
  cancelAutoRestart();
  resetBoard();
  state.paused = false;
  state.gameKind = secret ? "custom" : "random";
  setStatus(secret ? "публикация..." : "новая случайная игра...");
  try {
    const body = { mode: "random", secret };
    if (secret) body.author_id = getAuthorId();
    const data = await api("/games", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (epoch !== state.gameEpoch) return;
    state.game = { game_id: data.game_id };

    setMode("playing");
    renderHandsOff();

    if (secret) {
      rememberSecretWord(secret);
      setStatus("игра началась · своё слово");
    } else if (data.challenge && data.challenge.name) {
      setStatus(`${data.challenge.name} (${data.challenge.challenge_type})`);
    } else {
      setStatus("игра началась");
    }
    render();
    renderWinnersLeaderboards();
  } catch (e) {
    if (epoch !== state.gameEpoch) return;
    setMode(secret ? "secret" : "over");
    renderHandsOff();
    setStatus(e.message, "error");
  }
}

function enterSecretMode() {
  state.gameEpoch += 1;
  cancelAutoRestart();
  state.game = null;
  state.won = true;
  state.paused = true;
  resetBoard();
  setMode("secret");
  renderHandsOff();
  setStatus("игра остановлена · введите своё слово (на экране одна ● — длина не видна)");
}

function markWordEntered() {
  if (state.roundHasWord) return;
  state.roundHasWord = true;
  renderWinnersLeaderboards();
}

async function sendGuess(word, nick = null, platform = null) {
  if (state.paused || !state.game || state.won) return;
  word = (word || "").trim().toLowerCase();
  if (!word) return;

  if (state.guesses.some((g) => g.word === word && !g.tip)) return;

  try {
    const r = await api(`/games/${state.game.game_id}/guess`, {
      method: "POST",
      body: JSON.stringify({ word }),
    });

    if (r.error) {
      if (!nick) setStatus(r.error, "error");
      return;
    }

    if (r.rank === 0) {
      startGame();
      return;
    }

    upsertGuess({ ...r, nick, platform });
    markWordEntered();

    if (r.won) {
      state.won = true;
      if (nick) recordWinner(nick, platform);
      setWinStatus(r.word, nick, "", platform);
      setMode("over");
      playWinSound();
      renderWinnersLeaderboards();
      if (isAutoPlay()) scheduleAutoRestart(r.word, nick, platform);
    } else {
      const author = nick ? ` (${nick})` : "";
      setStatus(
        `${r.word}: место ${fmtInt(r.rank)}${author}` +
          (r.repeated ? " · уже было" : "")
      );
    }
    render({ freshWord: r.word });
  } catch (e) {
    if (!nick) setStatus(e.message, "error");
  }
}

function submitGuess(ev) {
  ev.preventDefault();
  const word = $("#guess-input").value.trim();
  $("#guess-input").value = "";
  sendGuess(word, null);
}

async function getTip() {
  if (state.paused || !state.game || state.won) return;
  try {
    const r = await api(`/games/${state.game.game_id}/tip`, { method: "POST" });
    if (r.error) {
      setStatus(r.error, "error");
      return;
    }
    state.tipsUsed = r.tips_used ?? state.tipsUsed + 1;
    upsertGuess({ ...r, tip: true });
    setStatus(`подсказка: ${r.word} (#${fmtInt(r.rank)})`);
    render({ freshWord: r.word });
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function giveUp({ skipConfirm = false } = {}) {
  if (state.paused || !state.game || state.won) return;
  if (!skipConfirm && !confirm("сдаёмся?")) return;
  try {
    const r = await api(`/games/${state.game.game_id}/give-up`, {
      method: "POST",
    });
    state.won = true;
    setMode("over");
    const overMsg = r.secret ? `загаданное слово: ${r.secret}` : "игра завершена";
    setStatus(overMsg, "win");
    renderWinnersLeaderboards();
    if (isAutoPlay()) scheduleAutoRestart(overMsg);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function showChatError(text, server) {
  if (server) state.chat.errors[server] = text;
  const el = $("#status");
  if (!el.classList.contains("error") || !state.chat.savedStatus) {
    state.chat.savedStatus = {
      text: el.textContent,
      kind: el.classList.contains("win")
        ? "win"
        : el.classList.contains("error")
        ? ""
        : "",
    };
  }
  const label = server ? `${ChatClient.serverMeta(server).label}: ` : "";
  setStatus(label + text, "error");
}

function clearChatError(server) {
  if (server) delete state.chat.errors[server];
  const leftover = Object.entries(state.chat.errors);
  if (leftover.length) {
    const [srv, text] = leftover[0];
    setStatus(`${ChatClient.serverMeta(srv).label}: ${text}`, "error");
    return;
  }
  const saved = state.chat.savedStatus;
  state.chat.savedStatus = null;
  if (!saved) return;
  const el = $("#status");
  if (!el.classList.contains("error")) return;
  setStatus(saved.text, saved.kind);
}

function setChatStatus(status, server, channel) {
  const target = ChatClient.formatChatTarget(server, channel);
  const titles = {
    disconnected: `${ChatClient.serverMeta(server).label}: не подключено`,
    connecting: `подключение к ${target}...`,
    connected: `подключено к ${target}`,
  };
  const title = titles[status] || "";

  document.querySelectorAll(`[data-chat-led="${server}"]`).forEach((led) => {
    led.classList.remove("connecting", "connected");
    if (status === "connecting") led.classList.add("connecting");
    if (status === "connected") led.classList.add("connected");
    led.title = title;
  });

  const dock = document.querySelector(`[data-chat-dock="${server}"]`);
  if (dock) {
    dock.classList.toggle("connecting", status === "connecting");
    dock.classList.toggle("connected", status === "connected");
    dock.title = title || ChatClient.serverMeta(server).label;
  }

  const btn = document.getElementById(`chat-btn-${server}`);
  if (btn) {
    btn.textContent =
      status === "disconnected"
        ? "подключить"
        : status === "connecting"
        ? "подключение..."
        : "отключить";
  }
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
    else if (chatCmd === "restart") giveUp({ skipConfirm: true });
    else if (chatCmd === "reload") reloadPagePreservingSettings();
    else if (chatCmd === "reset_stats") resetWinnersStats();
    return;
  }
  const word = ChatClient.extractWord(text);
  if (!word) return;
  sendGuess(word, display, msg.server);
}

const chatHub = ChatClient.createChatHub({
  onStatus: setChatStatus,
  onError: showChatError,
  onClearError: clearChatError,
  onMessage: handleIncomingChat,
  autoReconnect: true,
});

function emptyChatMap() {
  const out = {};
  for (const s of ChatClient.CHAT_SERVERS) out[s.id] = "";
  return out;
}

function chatInputEl(server, prefix = "chat") {
  return document.getElementById(`${prefix}-channel-${server}`);
}

function chatInputValue(server, prefix = "chat") {
  return (chatInputEl(server, prefix)?.value || "").trim();
}

function setChatInputValue(server, value, prefix = "chat") {
  const el = chatInputEl(server, prefix);
  if (el) el.value = value || "";
}

function normalizeChatRow(server, prefix = "chat") {
  const raw = chatInputValue(server, prefix);
  if (!raw) return { server, channel: "" };
  const parsed = ChatClient.parseChatTarget(raw, server);
  if (!parsed.channel) return parsed;
  if (parsed.server !== server) {
    setChatInputValue(server, "", prefix);
    setChatInputValue(parsed.server, parsed.channel, prefix);
  } else if (parsed.channel !== raw) {
    setChatInputValue(server, parsed.channel, prefix);
  }
  return parsed;
}

function readChatFormTargets(prefix = "chat") {
  const map = emptyChatMap();
  for (const s of ChatClient.CHAT_SERVERS) {
    const parsed = ChatClient.parseChatTarget(chatInputValue(s.id, prefix), s.id);
    if (parsed.channel) map[parsed.server] = parsed.channel;
  }
  return map;
}

function filledChatTargets(prefix = "chat") {
  const map = readChatFormTargets(prefix);
  return ChatClient.CHAT_SERVERS.map((s) =>
    map[s.id] ? { server: s.id, channel: map[s.id] } : null
  ).filter(Boolean);
}

function renderChatRows(containerId, { prefix, withButtons }) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = ChatClient.CHAT_SERVERS.map((s) => {
    const led = withButtons
      ? `<span class="chat-led" data-chat-led="${s.id}" title="${s.label}: не подключено"></span>`
      : "";
    const btn = withButtons
      ? `<button type="button" class="btn btn-outline chat-row-btn" id="chat-btn-${s.id}" data-server="${s.id}">подключить</button>`
      : "";
    return `<div class="chat-row" data-server="${s.id}">
      ${led}
      <span class="chat-platform-badge">${ChatClient.platformIconHtml(s.id)}</span>
      <span class="chat-row-label">${s.label}</span>
      <input
        id="${prefix}-channel-${s.id}"
        class="input chat-input"
        type="text"
        placeholder="${s.placeholder}"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        aria-label="${s.label}"
      />
      ${btn}
    </div>`;
  }).join("");
}

function applySavedChatsToForm(saved, prefix = "chat") {
  for (const s of ChatClient.CHAT_SERVERS) {
    const item = saved[s.id];
    setChatInputValue(s.id, item && item.channel ? item.channel : "", prefix);
  }
}

function reloadPagePreservingSettings() {
  saveHandsOff(state.handsOff);
  persistChats();
  location.reload();
}

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

function resetWinnersAlltime({ skipConfirm = false } = {}) {
  if (!state.winnerWinsAlltime.size && !skipConfirm) return;
  if (!skipConfirm && !confirm("сбросить топ за всё время?")) return;
  state.winnerWinsAlltime = new Map();
  saveWinnersAlltime();
  renderWinnersLeaderboards();
}

function resetWinnersToday({ skipConfirm = false } = {}) {
  syncTodayWinnersDate();
  if (!state.winnerWinsToday.size && !skipConfirm) return;
  if (!skipConfirm && !confirm("сбросить топ за сегодня?")) return;
  state.winnerWinsToday = new Map();
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

function renderOneWinnersBoard(section, list, resetBtn, map) {
  if (!section || !list) return false;

  const entries = [...map.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")
  );

  list.innerHTML = "";
  if (!entries.length) {
    section.hidden = true;
    if (resetBtn) resetBtn.hidden = true;
    return false;
  }

  if (resetBtn) resetBtn.hidden = false;

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
  return true;
}

function winnersHasData() {
  return state.winnerWinsToday.size > 0 || state.winnerWinsAlltime.size > 0;
}

function shouldShowWinnersBoards() {
  if (!winnersHasData()) return false;
  if (isAutoPlay()) {
    if (state.won) return true;
    return !!state.game && !state.roundHasWord;
  }
  return state.won;
}

function renderWinnersLeaderboards() {
  syncTodayWinnersDate();
  renderOneWinnersBoard(
    $("#winners-today"),
    $("#winners-today-list"),
    $("#reset-winners-today-btn"),
    state.winnerWinsToday
  );
  renderOneWinnersBoard(
    $("#winners-alltime"),
    $("#winners-alltime-list"),
    $("#reset-winners-alltime-btn"),
    state.winnerWinsAlltime
  );
  const wrap = $("#winners-boards");
  if (wrap) wrap.hidden = !shouldShowWinnersBoards();
}

function getSavedChats() {
  const out = {};
  for (const s of ChatClient.CHAT_SERVERS) {
    out[s.id] = { channel: "", connected: false };
  }
  try {
    const raw = localStorage.getItem(CHAT_TARGETS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        for (const s of ChatClient.CHAT_SERVERS) {
          const item = obj[s.id];
          if (typeof item === "string" && item) {
            out[s.id] = { channel: item.toLowerCase(), connected: true };
          } else if (item && typeof item === "object" && item.channel) {
            out[s.id] = {
              channel: String(item.channel).toLowerCase(),
              connected: !!item.connected,
            };
          }
        }
        return out;
      }
    }
  } catch (_) {}

  let server = "twitch";
  let channel = "";
  try {
    server = localStorage.getItem(CHAT_SERVER_KEY) || "twitch";
    channel =
      localStorage.getItem(CHAT_CHANNEL_KEY) ||
      localStorage.getItem(TWITCH_CHANNEL_KEY) ||
      "";
  } catch (_) {}
  if (!ChatClient.CHAT_SERVERS.some((s) => s.id === server)) server = "twitch";
  if (channel) {
    out[server] = { channel: channel.toLowerCase(), connected: true };
  }
  return out;
}

function persistChats() {
  const form = readChatFormTargets("chat");
  const obj = {};
  for (const s of ChatClient.CHAT_SERVERS) {
    const live = chatHub.getState(s.id);
    const channel = (live.channel || form[s.id] || "").toLowerCase();
    if (!channel) continue;
    obj[s.id] = {
      channel,
      connected: live.status !== "disconnected",
    };
  }
  try {
    if (Object.keys(obj).length) {
      localStorage.setItem(CHAT_TARGETS_KEY, JSON.stringify(obj));
      const first = ChatClient.CHAT_SERVERS.find((s) => obj[s.id]);
      if (first) {
        localStorage.setItem(CHAT_SERVER_KEY, first.id);
        localStorage.setItem(CHAT_CHANNEL_KEY, obj[first.id].channel);
        localStorage.setItem(
          TWITCH_CHANNEL_KEY,
          (obj.twitch && obj.twitch.channel) || obj[first.id].channel
        );
      }
    } else {
      localStorage.removeItem(CHAT_TARGETS_KEY);
      localStorage.removeItem(CHAT_SERVER_KEY);
      localStorage.removeItem(CHAT_CHANNEL_KEY);
      localStorage.removeItem(TWITCH_CHANNEL_KEY);
    }
  } catch (_) {}
}

function connectChatRow(server) {
  const parsed = normalizeChatRow(server, "chat");
  const dest = parsed.channel ? parsed.server : server;
  const channel = parsed.channel || chatInputValue(dest);
  if (!channel) return;
  setChatInputValue(dest, channel);
  chatHub.connect(dest, channel);
  persistChats();
}

function toggleChatRow(server) {
  const live = chatHub.getState(server);
  if (live.status !== "disconnected") {
    chatHub.disconnect(server);
    persistChats();
    return;
  }
  connectChatRow(server);
}

function connectFilledChats() {
  for (const s of ChatClient.CHAT_SERVERS) normalizeChatRow(s.id, "chat");
  const targets = filledChatTargets("chat");
  if (!targets.length) return;
  chatHub.connectMany(targets);
  persistChats();
}

function disconnectAllChats() {
  chatHub.disconnectAll();
  persistChats();
}

function openChatModal(focusServer) {
  const modal = $("#chat-modal");
  if (!modal) return;
  modal.hidden = false;
  if (focusServer) {
    const input = chatInputEl(focusServer, "chat");
    setTimeout(() => input?.focus(), 0);
  }
}

function closeChatModal() {
  const modal = $("#chat-modal");
  if (!modal) return;
  persistChats();
  modal.hidden = true;
}

function renderChatDock() {
  const el = $("#chat-dock");
  if (!el) return;
  el.innerHTML = ChatClient.CHAT_SERVERS.map(
    (s) => `<button
      type="button"
      class="chat-dock-item"
      data-chat-dock="${s.id}"
      aria-label="${s.label}: настроить чаты"
      title="${s.label}"
    >
      <span class="chat-led" data-chat-led="${s.id}"></span>
      ${ChatClient.platformIconHtml(s.id)}
    </button>`
  ).join("");
}

function setupChatPanel() {
  renderChatDock();
  renderChatRows("chat-rows", { prefix: "chat", withButtons: true });

  for (const s of ChatClient.CHAT_SERVERS) {
    const input = chatInputEl(s.id, "chat");
    const btn = document.getElementById(`chat-btn-${s.id}`);
    input?.addEventListener("change", () => {
      normalizeChatRow(s.id, "chat");
      persistChats();
    });
    input?.addEventListener("paste", () => {
      setTimeout(() => {
        normalizeChatRow(s.id, "chat");
        persistChats();
      }, 0);
    });
    input?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      connectChatRow(s.id);
    });
    btn?.addEventListener("click", () => toggleChatRow(s.id));
  }

  $("#chat-dock")?.addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-chat-dock]");
    if (!item) return;
    openChatModal(item.getAttribute("data-chat-dock"));
  });
  $("#chat-modal-close")?.addEventListener("click", closeChatModal);
  $("#chat-modal")?.addEventListener("click", (ev) => {
    if (ev.target === $("#chat-modal")) closeChatModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && $("#chat-modal") && !$("#chat-modal").hidden) {
      closeChatModal();
    }
  });

  $("#chat-connect-all")?.addEventListener("click", connectFilledChats);
  $("#chat-disconnect-all")?.addEventListener("click", disconnectAllChats);

  const saved = getSavedChats();
  applySavedChatsToForm(saved, "chat");
  const toConnect = ChatClient.CHAT_SERVERS.filter(
    (s) => saved[s.id] && saved[s.id].connected && saved[s.id].channel
  ).map((s) => ({ server: s.id, channel: saved[s.id].channel }));
  if (toConnect.length) chatHub.connectMany(toConnect);
  persistChats();
}

function getSavedHandsOff() {
  try {
    return localStorage.getItem(HANDS_OFF_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function saveHandsOff(enabled) {
  try {
    if (enabled) localStorage.setItem(HANDS_OFF_KEY, "1");
    else localStorage.removeItem(HANDS_OFF_KEY);
  } catch (_) {}
}

function renderHandsOff() {
  const input = $("#hands-off");
  const wrap = $("#hands-off-wrap");
  if (input) input.checked = !!state.handsOff;
  const secretMode = $("#secret-form") && !$("#secret-form").hidden;
  const show = state.gameKind !== "custom" && !secretMode;
  if (wrap) wrap.hidden = !show;
}

function cancelAutoRestartTimer() {
  if (state.autoRestartTimer) {
    clearInterval(state.autoRestartTimer);
    state.autoRestartTimer = null;
  }
}

function cancelAutoRestart() {
  cancelAutoRestartTimer();
  renderWinnersLeaderboards();
}

function scheduleAutoRestart(wordOrMsg, nick, platform) {
  cancelAutoRestartTimer();
  renderWinnersLeaderboards();
  let remaining = HANDS_OFF_DELAY;
  // scheduleAutoRestart(word, nick) — win; scheduleAutoRestart(message) — give-up
  const useWinStatus = arguments.length >= 2;
  const tick = () => {
    const extra = `новая игра через ${remaining} сек`;
    if (useWinStatus) setWinStatus(wordOrMsg, nick, extra, platform);
    else setStatus(`${wordOrMsg} · ${extra}`, "win");
  };
  tick();
  state.autoRestartTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelAutoRestart();
      startGame();
    } else {
      tick();
    }
  }, 1000);
}

function setHandsOff(enabled) {
  const wasOff = !state.handsOff;
  state.handsOff = enabled;
  saveHandsOff(enabled);
  renderHandsOff();
  updateCounters();
  if (enabled) {
    if (wasOff && state.gameKind !== "custom") startGame();
  } else {
    cancelAutoRestart();
  }
}

function getSavedWinSound() {
  try {
    const v = localStorage.getItem(WIN_SOUND_KEY);
    if (v === null) return true;
    return v === "1";
  } catch (_) {
    return true;
  }
}

function saveWinSound(enabled) {
  try {
    if (enabled) localStorage.setItem(WIN_SOUND_KEY, "1");
    else localStorage.setItem(WIN_SOUND_KEY, "0");
  } catch (_) {}
}

function getSavedSoundVolume() {
  try {
    const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY));
    if (!Number.isFinite(v)) return DEFAULT_SOUND_VOLUME;
    return Math.max(0, Math.min(1, v));
  } catch (_) {
    return DEFAULT_SOUND_VOLUME;
  }
}

function saveSoundVolume(volume) {
  try {
    localStorage.setItem(SOUND_VOLUME_KEY, String(volume));
  } catch (_) {}
}

function renderSoundSettings() {
  const check = $("#win-sound-enabled");
  const slider = $("#sound-volume");
  const valueEl = $("#sound-volume-value");
  if (!check || !slider || !valueEl) return;

  const pct = Math.round(state.soundVolume * 100);
  check.checked = state.winSound;
  slider.value = String(pct);
  slider.disabled = !state.winSound;
  slider.setAttribute("aria-valuenow", String(pct));
  valueEl.textContent = `${pct}%`;
}

function setWinSound(enabled) {
  state.winSound = enabled;
  saveWinSound(enabled);
  renderSoundSettings();
}

function setSoundVolume(volume) {
  state.soundVolume = Math.max(0, Math.min(1, volume));
  saveSoundVolume(state.soundVolume);
  renderSoundSettings();
}

const OBS_DEFAULTS = { volume: 25, delay: 8, rows: 12 };

function buildObsUrl() {
  const url = new URL("/obs.html", location.origin);
  ChatClient.applyChatsToSearch(url.searchParams, filledChatTargets("obs"));
  if ($("#obs-sound").checked) url.searchParams.set("sound", "1");

  const volume = parseInt($("#obs-volume").value, 10);
  if (Number.isFinite(volume) && volume !== OBS_DEFAULTS.volume) {
    url.searchParams.set("volume", String(Math.max(0, volume)));
  }
  const delay = parseInt($("#obs-delay").value, 10);
  if (Number.isFinite(delay) && delay !== OBS_DEFAULTS.delay) {
    url.searchParams.set("delay", String(Math.max(1, delay)));
  }
  const rows = parseInt($("#obs-rows").value, 10);
  if (Number.isFinite(rows) && rows !== OBS_DEFAULTS.rows) {
    url.searchParams.set("rows", String(Math.max(1, rows)));
  }
  return url.toString();
}

function updateObsUrl() {
  for (const s of ChatClient.CHAT_SERVERS) {
    normalizeChatRow(s.id, "obs");
  }
  const url = buildObsUrl();
  $("#obs-url").value = url;
  $("#obs-open").href = url;
}

function openObsModal() {
  const saved = getSavedChats();
  for (const s of ChatClient.CHAT_SERVERS) {
    const live = chatHub.getState(s.id);
    const fromForm = chatInputValue(s.id, "chat");
    const channel =
      (live.channel || fromForm || (saved[s.id] && saved[s.id].channel) || "").trim();
    setChatInputValue(s.id, channel, "obs");
  }
  updateObsUrl();
  $("#obs-modal").hidden = false;
}

function closeObsModal() {
  $("#obs-modal").hidden = true;
}

function setupObsModal() {
  const modal = $("#obs-modal");
  if (!modal) return;

  renderChatRows("obs-chat-rows", { prefix: "obs", withButtons: false });

  $("#obs-btn")?.addEventListener("click", openObsModal);
  $("#obs-modal-close")?.addEventListener("click", closeObsModal);
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeObsModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) closeObsModal();
  });

  for (const s of ChatClient.CHAT_SERVERS) {
    const input = chatInputEl(s.id, "obs");
    input?.addEventListener("input", updateObsUrl);
    input?.addEventListener("change", updateObsUrl);
    input?.addEventListener("paste", () => setTimeout(updateObsUrl, 0));
  }

  ["obs-sound", "obs-volume", "obs-delay", "obs-rows"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", updateObsUrl);
    el?.addEventListener("change", updateObsUrl);
  });

  $("#obs-copy")?.addEventListener("click", async () => {
    const btn = $("#obs-copy");
    const url = buildObsUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      const input = $("#obs-url");
      input.select();
      try {
        document.execCommand("copy");
      } catch (__) {}
    }
    const prev = btn.textContent;
    btn.textContent = "скопировано";
    setTimeout(() => {
      btn.textContent = prev;
    }, 1500);
  });
}

(function init() {
  state.winnerWinsAlltime = loadWinnersAlltime();
  const todayWinners = loadWinnersToday();
  state.winnerWinsTodayDate = todayWinners.date;
  state.winnerWinsToday = todayWinners.map;
  state.winnerPlatforms = loadWinnerPlatforms();
  state.secretHistory = loadSecretHistory();
  state.handsOff = getSavedHandsOff();
  state.winSound = getSavedWinSound();
  state.soundVolume = getSavedSoundVolume();
  renderWinnersLeaderboards();
  renderHandsOff();
  renderSoundSettings();

  $("#reset-winners-alltime-btn")?.addEventListener("click", () =>
    resetWinnersAlltime()
  );
  $("#reset-winners-today-btn")?.addEventListener("click", () =>
    resetWinnersToday()
  );
  setupSecretHistoryModal();

  $("#hands-off")?.addEventListener("change", (ev) => {
    setHandsOff(ev.target.checked);
  });

  $("#win-sound-enabled").addEventListener("change", (ev) => {
    setWinSound(ev.target.checked);
  });

  $("#sound-volume").addEventListener("input", (ev) => {
    setSoundVolume(Number(ev.target.value) / 100);
  });

  $("#random-btn").addEventListener("click", () => startGame());

  $("#custom-btn").addEventListener("click", enterSecretMode);

  $("#secret-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const w = $("#secret-input").value.trim();
    $("#secret-input").value = "";
    setSecretRevealed(false);
    if (!w) {
      setStatus("введите слово", "error");
      return;
    }
    startGame({ secret: w });
  });

  const secretInput = $("#secret-input");
  secretInput?.addEventListener("input", updateSecretDisplay);
  secretInput?.addEventListener("focus", updateSecretDisplay);
  secretInput?.addEventListener("blur", updateSecretDisplay);
  $("#secret-reveal-btn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setSecretRevealed(!state.secretRevealed);
    secretInput?.focus();
  });
  $("#secret-wrap")?.addEventListener("click", (ev) => {
    if (ev.target.closest("#secret-reveal-btn")) return;
    secretInput?.focus();
  });

  $("#guess-form").addEventListener("submit", submitGuess);
  $("#tip-btn").addEventListener("click", getTip);
  $("#give-up-btn").addEventListener("click", giveUp);
  $("#restart-btn").addEventListener("click", () => startGame());

  setupObsModal();

  setupChatPanel();

  startGame();
})();
