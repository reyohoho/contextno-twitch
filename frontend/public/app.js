"use strict";

const API = "/api";
const AUTHOR_ID_KEY = "contextnorf:author_id";
const TWITCH_CHANNEL_KEY = "contextnorf:twitch_channel";
const HANDS_OFF_KEY = "contextnorf:hands_off";
const WINNERS_ALLTIME_KEY = "contextnorf:winners";
const WINNERS_TODAY_KEY = "contextnorf:winners_today";
const LEGACY_WINNERS_KEY = "contextnorf:session_wins";
const WIN_SOUND_KEY = "contextnorf:win_sound";
const SOUND_VOLUME_KEY = "contextnorf:sound_volume";

const PRIVILEGED_CHAT_LOGINS = new Set(["olegsvs"]);

const HANDS_OFF_DELAY = 10;
const DEFAULT_SOUND_VOLUME = 0.5;

const $ = (sel) => document.querySelector(sel);

const state = {
  game: null,
  guesses: [],
  won: false,
  tipsUsed: 0,
  twitch: { ws: null, channel: null, status: "disconnected" },
  handsOff: false,
  autoRestartTimer: null,
  winnerWinsAlltime: new Map(),
  winnerWinsToday: new Map(),
  winnerWinsTodayDate: "",
  roundHasWord: false,
  winSound: true,
  soundVolume: DEFAULT_SOUND_VOLUME,
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

function setStatus(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
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
}

function rankTier(rank) {
  if (rank <= 300) return "tier-hot";
  if (rank <= 1500) return "tier-warm";
  return "tier-cold";
}

function pluralVariantsRu(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "вариант";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "варианта";
  return "вариантов";
}

function perNickVariantCounts() {
  const counts = new Map();
  for (const g of state.guesses) {
    if (g.tip || !g.nick) continue;
    const nick = g.nick;
    counts.set(nick, (counts.get(nick) || 0) + 1);
  }
  return counts;
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
  const nickEl = el.querySelector(".nick");
  if (g.nick) {
    const total = opts.nickCounts?.get(g.nick) ?? 1;
    nickEl.textContent = "@" + g.nick + " · " + fmtInt(total);
    nickEl.title = `${fmtInt(total)} ${pluralVariantsRu(total)} за раунд`;
  } else {
    nickEl.hidden = true;
  }
  return el;
}

function render({ freshWord } = {}) {
  const list = $("#guesses");
  list.innerHTML = "";
  const nickCounts = perNickVariantCounts();
  const sorted = [...state.guesses].sort((a, b) => a.rank - b.rank);
  sorted.forEach((g, i) => {
    list.appendChild(
      rowEl(g, i + 1, {
        fresh: freshWord && g.word === freshWord,
        nickCounts,
      })
    );
  });

  const last = $("#last-guess");
  last.innerHTML = "";
  if (freshWord) {
    const g = state.guesses.find((x) => x.word === freshWord);
    if (g) {
      const el = rowEl(g, "·", { nickCounts });
      el.classList.add("fresh");
      last.appendChild(el);
    }
  }
  updateCounters();
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

async function startGame({ secret = null } = {}) {
  cancelAutoRestart();
  resetBoard();
  setStatus(secret ? "публикация..." : "новая случайная игра...");
  try {
    const body = { mode: "random", secret };
    if (secret) body.author_id = getAuthorId();
    const data = await api("/games", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.game = { game_id: data.game_id };

    setMode("playing");

    if (secret) {
      setStatus("игра началась");
    } else if (data.challenge && data.challenge.name) {
      setStatus(`${data.challenge.name} (${data.challenge.challenge_type})`);
    } else {
      setStatus("игра началась");
    }
    render();
    renderWinnersLeaderboards();
  } catch (e) {
    setMode(secret ? "secret" : "over");
    setStatus(e.message, "error");
  }
}

function markWordEntered() {
  if (state.roundHasWord) return;
  state.roundHasWord = true;
  renderWinnersLeaderboards();
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

    if (r.error) {
      if (!nick) setStatus(r.error, "error");
      return;
    }

    if (r.rank === 0) {
      startGame();
      return;
    }

    upsertGuess({ ...r, nick });
    markWordEntered();

    if (r.won) {
      state.won = true;
      if (nick) recordWinner(nick);
      const winner = nick ? ` — ${nick}` : "";
      const winMsg = `угадано: ${r.word} (#1)${winner}`;
      setStatus(winMsg, "win");
      setMode("over");
      playWinSound();
      renderWinnersLeaderboards();
      if (state.handsOff) scheduleAutoRestart(winMsg);
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
  if (!state.game || state.won) return;
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
  if (!state.game || state.won) return;
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
    if (state.handsOff) scheduleAutoRestart(overMsg);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function showTwitchError(text) {
  const el = $("#status");
  if (!el.classList.contains("error") || !state.twitch.savedStatus) {
    state.twitch.savedStatus = {
      text: el.textContent,
      kind: el.classList.contains("win")
        ? "win"
        : el.classList.contains("error")
        ? ""
        : "",
    };
  }
  setStatus(text, "error");
}

function clearTwitchError() {
  const saved = state.twitch.savedStatus;
  state.twitch.savedStatus = null;
  if (!saved) return;
  const el = $("#status");
  if (!el.classList.contains("error")) return;
  setStatus(saved.text, saved.kind);
}

function setTwitchStatus(status, channel = state.twitch.channel) {
  state.twitch.status = status;
  const led = $("#twitch-led");
  led.classList.remove("connecting", "connected");
  if (status === "connecting") led.classList.add("connecting");
  if (status === "connected") led.classList.add("connected");

  const titles = {
    disconnected: "не подключено",
    connecting: `подключение к #${channel}...`,
    connected: `подключено к #${channel}`,
  };
  led.title = titles[status] || "";

  const btn = $("#twitch-btn");
  btn.textContent = status === "disconnected" ? "подключить" : "отключить";
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
  return null;
}

function reloadPagePreservingSettings() {
  saveHandsOff(state.handsOff);
  const channel =
    state.twitch.channel ||
    ($("#twitch-channel")?.value || "").trim().toLowerCase().replace(/^#/, "") ||
    getSavedChannel();
  if (channel) saveChannel(channel);
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

function recordWinner(nick) {
  if (!nick) return;
  state.winnerWinsAlltime.set(nick, (state.winnerWinsAlltime.get(nick) || 0) + 1);
  syncTodayWinnersDate();
  state.winnerWinsToday.set(nick, (state.winnerWinsToday.get(nick) || 0) + 1);
  saveWinnersAlltime();
  saveWinnersToday();
  renderWinnersLeaderboards();
}

function resetWinnersAlltime() {
  if (!state.winnerWinsAlltime.size) return;
  if (!confirm("сбросить топ за всё время?")) return;
  state.winnerWinsAlltime = new Map();
  saveWinnersAlltime();
  renderWinnersLeaderboards();
}

function resetWinnersToday() {
  syncTodayWinnersDate();
  if (!state.winnerWinsToday.size) return;
  if (!confirm("сбросить топ за сегодня?")) return;
  state.winnerWinsToday = new Map();
  saveWinnersToday();
  renderWinnersLeaderboards();
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
      <span class="session-nick">@${nick}</span>
      <span class="session-wins" title="${fmtInt(wins)} ${pluralWinsRu(wins)}">${fmtInt(wins)}</span>
    `;
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
  if (state.handsOff) {
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

function safeClose(ws) {
  if (!ws) return;
  try {
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.onopen = () => {
        try {
          ws.close();
        } catch (_) {}
      };
    } else {
      ws.close();
    }
  } catch (_) {}
}

function disconnectTwitch() {
  const ws = state.twitch.ws;
  state.twitch.ws = null;
  state.twitch.channel = null;
  safeClose(ws);
  setTwitchStatus("disconnected", null);
}

function connectTwitch(channel) {
  channel = (channel || "").trim().toLowerCase().replace(/^#/, "");
  if (!channel) return;
  disconnectTwitch();
  state.twitch.channel = channel;
  setTwitchStatus("connecting", channel);

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  state.twitch.ws = ws;

  const failTimer = setTimeout(() => {
    if (state.twitch.ws === ws && state.twitch.status !== "connected") {
      showTwitchError(`не удалось подключиться к каналу #${channel}`);
      disconnectTwitch();
    }
  }, 15000);

  const markConnected = () => {
    clearTimeout(failTimer);
    if (state.twitch.status !== "connected") {
      setTwitchStatus("connected", channel);
      clearTwitchError();
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

      if (m.command === "NOTICE") {
        const id = m.tags["msg-id"] || "";
        const okIds = new Set(["msg_room_state", "host_target_went_offline"]);
        if (!okIds.has(id)) {
          showTwitchError(`twitch: ${m.trailing || "ошибка подключения"}`);
          disconnectTwitch();
          return;
        }
      }

      if (m.command === "PRIVMSG") {
        const nickFromPrefix = m.prefix.split("!")[0];
        const display = m.tags["display-name"] || nickFromPrefix;
        const chatCmd = parseChatCommand(m.trailing);
        if (chatCmd && isPrivilegedChatter(m.tags, nickFromPrefix, display)) {
          if (chatCmd === "hint") getTip();
          else if (chatCmd === "restart") giveUp({ skipConfirm: true });
          else if (chatCmd === "reload") reloadPagePreservingSettings();
          continue;
        }
        const word = extractWord(m.trailing);
        if (!word) continue;
        if (!state.game || state.won) continue;
        sendGuess(word, display);
      }
    }
  };

  ws.onerror = () => {
    clearTimeout(failTimer);
  };

  ws.onclose = () => {
    clearTimeout(failTimer);
    if (state.twitch.ws === ws) {
      state.twitch.ws = null;
      setTwitchStatus("disconnected", null);
    }
  };
}

function getSavedChannel() {
  try {
    return localStorage.getItem(TWITCH_CHANNEL_KEY) || "";
  } catch (_) {
    return "";
  }
}

function saveChannel(channel) {
  try {
    if (channel) localStorage.setItem(TWITCH_CHANNEL_KEY, channel);
    else localStorage.removeItem(TWITCH_CHANNEL_KEY);
  } catch (_) {}
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

function renderHandsOffBtn() {
  const btn = $("#hands-off-btn");
  if (!btn) return;
  btn.classList.toggle("active", state.handsOff);
  btn.setAttribute("aria-pressed", state.handsOff ? "true" : "false");
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

function scheduleAutoRestart(winStatus) {
  cancelAutoRestartTimer();
  renderWinnersLeaderboards();
  let remaining = HANDS_OFF_DELAY;
  setStatus(`${winStatus} · новая игра через ${remaining} сек`, "win");
  state.autoRestartTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelAutoRestart();
      startGame();
    } else {
      setStatus(`${winStatus} · новая игра через ${remaining} сек`, "win");
    }
  }, 1000);
}

function setHandsOff(enabled) {
  const wasOff = !state.handsOff;
  state.handsOff = enabled;
  saveHandsOff(enabled);
  renderHandsOffBtn();
  if (enabled) {
    if (wasOff) startGame();
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

(function init() {
  state.winnerWinsAlltime = loadWinnersAlltime();
  const todayWinners = loadWinnersToday();
  state.winnerWinsTodayDate = todayWinners.date;
  state.winnerWinsToday = todayWinners.map;
  state.handsOff = getSavedHandsOff();
  state.winSound = getSavedWinSound();
  state.soundVolume = getSavedSoundVolume();
  renderWinnersLeaderboards();
  renderHandsOffBtn();
  renderSoundSettings();

  $("#reset-winners-alltime-btn")?.addEventListener("click", resetWinnersAlltime);
  $("#reset-winners-today-btn")?.addEventListener("click", resetWinnersToday);

  $("#hands-off-btn").addEventListener("click", () => setHandsOff(!state.handsOff));

  $("#win-sound-enabled").addEventListener("change", (ev) => {
    setWinSound(ev.target.checked);
  });

  $("#sound-volume").addEventListener("input", (ev) => {
    setSoundVolume(Number(ev.target.value) / 100);
  });

  $("#random-btn").addEventListener("click", () => startGame());

  $("#custom-btn").addEventListener("click", () => {
    setMode("secret");
    setStatus("введите своё слово (видно только вам)");
  });

  $("#secret-cancel").addEventListener("click", () => {
    $("#secret-input").value = "";
    startGame();
  });

  $("#secret-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const w = $("#secret-input").value.trim();
    $("#secret-input").value = "";
    if (!w) {
      setStatus("введите слово", "error");
      return;
    }
    startGame({ secret: w });
  });

  $("#guess-form").addEventListener("submit", submitGuess);
  $("#tip-btn").addEventListener("click", getTip);
  $("#give-up-btn").addEventListener("click", giveUp);
  $("#restart-btn").addEventListener("click", () => startGame());

  $("#twitch-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (state.twitch.status !== "disconnected") {
      disconnectTwitch();
      saveChannel("");
      return;
    }
    const ch = $("#twitch-channel").value.trim().toLowerCase().replace(/^#/, "");
    if (!ch) return;
    saveChannel(ch);
    connectTwitch(ch);
  });

  const saved = getSavedChannel();
  if (saved) {
    $("#twitch-channel").value = saved;
    connectTwitch(saved);
  }

  startGame();
})();
