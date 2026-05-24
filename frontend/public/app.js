"use strict";

const API = "/api";
const AUTHOR_ID_KEY = "contextnorf:author_id";
const TWITCH_CHANNEL_KEY = "contextnorf:twitch_channel";
const SOURCE_KEY = "contextnorf:source";
const HANDS_OFF_KEY = "contextnorf:hands_off";

const HANDS_OFF_DELAY = 10;

const SOURCES = {
  contextno: { label: "Модель: контекстно.рф" },
  navec: { label: "Модель: локальная Navec" },
  rusvectores: { label: "Модель: локальная RusVectores" },
};
const DEFAULT_SOURCE = "contextno";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  game: null,
  guesses: [],
  won: false,
  tipsUsed: 0,
  source: DEFAULT_SOURCE,
  twitch: { ws: null, channel: null, status: "disconnected" },
  handsOff: false,
  autoRestartTimer: null,
};

function isLocalSource(source = state.source) {
  return source === "navec" || source === "rusvectores";
}

function gamesPath() {
  return isLocalSource() ? "/v2/games" : "/games";
}

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
    let body;
    if (isLocalSource()) {
      body = { backend: state.source };
      if (secret) body.secret = secret;
    } else {
      body = { mode: "random", secret };
      if (secret) body.author_id = getAuthorId();
    }
    const data = await api(gamesPath(), {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.game = { game_id: data.game_id };

    setMode("playing");

    if (secret) {
      setStatus("игра началась");
    } else if (data.challenge && data.challenge.name) {
      setStatus(`${data.challenge.name} (${data.challenge.challenge_type})`);
    } else if (isLocalSource()) {
      const label = SOURCES[state.source].label;
      const vocab = data.vocab_size
        ? ` · словарь ${fmtInt(data.vocab_size)}`
        : "";
      setStatus(`${label}${vocab}`);
    } else {
      setStatus("игра началась");
    }
    render();
  } catch (e) {
    setMode(secret ? "secret" : "over");
    setStatus(e.message, "error");
  }
}

async function sendGuess(word, nick = null) {
  if (!state.game || state.won) return;
  word = (word || "").trim().toLowerCase();
  if (!word) return;

  if (state.guesses.some((g) => g.word === word && !g.tip)) return;

  try {
    const r = await api(`${gamesPath()}/${state.game.game_id}/guess`, {
      method: "POST",
      body: JSON.stringify({ word }),
    });

    if (r.error) {
      if (!nick) setStatus(r.error, "error");
      return;
    }

    upsertGuess({ ...r, nick });

    if (r.won) {
      state.won = true;
      const winner = nick ? ` — ${nick}` : "";
      const winMsg = `угадано: ${r.word} (#1)${winner}`;
      setStatus(winMsg, "win");
      setMode("over");
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
    const r = await api(`${gamesPath()}/${state.game.game_id}/tip`, { method: "POST" });
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

async function giveUp() {
  if (!state.game || state.won) return;
  if (!confirm("сдаёмся?")) return;
  try {
    const r = await api(`${gamesPath()}/${state.game.game_id}/give-up`, {
      method: "POST",
    });
    state.won = true;
    setMode("over");
    if (r.secret) setStatus(`загаданное слово: ${r.secret}`, "win");
    else setStatus("игра завершена", "win");
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

function getSavedSource() {
  let s;
  try {
    s = localStorage.getItem(SOURCE_KEY);
  } catch (_) {}
  return SOURCES[s] ? s : DEFAULT_SOURCE;
}

function saveSource(source) {
  try {
    localStorage.setItem(SOURCE_KEY, source);
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

function cancelAutoRestart() {
  if (state.autoRestartTimer) {
    clearInterval(state.autoRestartTimer);
    state.autoRestartTimer = null;
  }
}

function scheduleAutoRestart(winStatus) {
  cancelAutoRestart();
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
  state.handsOff = enabled;
  saveHandsOff(enabled);
  renderHandsOffBtn();
  if (!enabled) cancelAutoRestart();
}

function renderSourcePicker() {
  for (const card of $$(".source-card")) {
    const selected = card.dataset.source === state.source;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  const credit = $("#contextno-credit");
  if (credit) credit.hidden = state.source !== "contextno";
}

async function refreshBackendsInfo() {
  let data;
  try {
    data = await api("/v2/backends");
  } catch (_) {
    return;
  }
  const map = new Map();
  for (const b of data.backends || []) map.set(b.id, b);
  for (const card of $$(".source-card")) {
    const id = card.dataset.source;
    const info = map.get(id);
    if (!info || typeof info.vocab_size !== "number") continue;
    const desc = card.querySelector(".source-card-desc");
    if (!desc) continue;
    const meta = id === "rusvectores" ? " · НКРЯ" : "";
    desc.textContent = `${fmtInt(info.vocab_size)} существительных${meta}`;
  }
}

function setSource(source) {
  if (!SOURCES[source] || source === state.source) return;
  state.source = source;
  saveSource(source);
  renderSourcePicker();
  startGame();
}

(function init() {
  state.source = getSavedSource();
  state.handsOff = getSavedHandsOff();
  renderSourcePicker();
  renderHandsOffBtn();
  refreshBackendsInfo();
  for (const card of $$(".source-card")) {
    card.addEventListener("click", () => setSource(card.dataset.source));
  }

  $("#hands-off-btn").addEventListener("click", () => setHandsOff(!state.handsOff));

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
