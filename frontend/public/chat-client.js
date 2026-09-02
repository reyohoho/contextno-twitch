"use strict";

(function (global) {
  const CHAT_SERVERS = [
    { id: "twitch", label: "Twitch", placeholder: "канал twitch или ссылка" },
    { id: "vkvideo", label: "VK Video", placeholder: "канал vk video или ссылка" },
    { id: "kick", label: "Kick", placeholder: "канал kick или ссылка" },
    { id: "wtv", label: "w.tv", placeholder: "канал w.tv или ссылка" },
  ];

  const SERVER_IDS = new Set(CHAT_SERVERS.map((s) => s.id));
  const POLL_MS = 1000;
  const POLL_TIMEOUT_MS = 12000;
  const CONNECT_TIMEOUT_MS = 20000;
  const STALE_POLL_MS = 15000;
  const ZOMBIE_SILENCE_MS = 10 * 60 * 1000;
  const WATCHDOG_MS = 4000;
  const FREEZE_MS = 20000;
  const SEEN_CAP = 800;
  const MAX_POLL_ERRORS = 3;
  const BACKOFF_MIN_MS = 2000;
  const BACKOFF_MAX_MS = 15000;

  const HOST_RULES = [
    { re: /(^|\.)twitch\.tv$/i, server: "twitch" },
    { re: /(^|\.)kick\.com$/i, server: "kick" },
    { re: /(^|\.)vkvideo\.ru$/i, server: "vkvideo" },
    { re: /(^|\.)vk\.com$/i, server: "vkvideo" },
    { re: /(^|\.)w\.tv$/i, server: "wtv" },
  ];

  const PLATFORM_SVG = {
    twitch:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>',
    vkvideo:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m9.489.004.729-.003h3.564l.73.003.914.01.433.007.418.011.403.014.388.016.374.021.36.025.345.03.333.033c1.74.196 2.933.616 3.833 1.516.9.9 1.32 2.092 1.516 3.833l.034.333.029.346.025.36.02.373.025.588.012.41.013.644.009.915.004.98-.001 3.313-.003.73-.01.914-.007.433-.011.418-.014.403-.016.388-.021.374-.025.36-.03.345-.033.333c-.196 1.74-.616 2.933-1.516 3.833-.9.9-2.092 1.32-3.833 1.516l-.333.034-.346.029-.36.025-.373.02-.588.025-.41.012-.644.013-.915.009-.98.004-3.313-.001-.73-.003-.914-.01-.433-.007-.418-.011-.403-.014-.388-.016-.374-.021-.36-.025-.345-.03-.333-.033c-1.74-.196-2.933-.616-3.833-1.516-.9-.9-1.32-2.092-1.516-3.833l-.034-.333-.029-.346-.025-.36-.02-.373-.025-.588-.012-.41-.013-.644-.009-.915-.004-.98.001-3.313.003-.73.01-.914.007-.433.011-.418.014-.403.016-.388.021-.374.025-.36.03-.345.033-.333c.196-1.74.616-2.933 1.516-3.833.9-.9 2.092-1.32 3.833-1.516l.333-.034.346-.029.36-.025.373-.02.588-.025.41-.012.644-.013.915-.009ZM6.79 7.3H4.05c.13 6.24 3.25 9.99 8.72 9.99h.31v-3.57c2.01.2 3.53 1.67 4.14 3.57h2.84c-.78-2.84-2.83-4.41-4.11-5.01 1.28-.74 3.08-2.54 3.51-4.98h-2.58c-.56 1.98-2.22 3.78-3.8 3.95V7.3H10.5v6.92c-1.6-.4-3.62-2.34-3.71-6.92Z"/></svg>',
    kick:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z"/></svg>',
  };

  function serverMeta(id) {
    return CHAT_SERVERS.find((s) => s.id === id) || CHAT_SERVERS[0];
  }

  function formatChatTarget(server, channel) {
    const label = serverMeta(server).label;
    return channel ? `${label} · ${channel}` : label;
  }

  function platformIconHtml(server) {
    const id = String(server || "").toLowerCase();
    const label = serverMeta(id).label;
    if (id === "wtv") {
      return `<span class="chat-platform-icon is-wtv" title="${label}"><img src="/icons/wtv.png" alt=""></span>`;
    }
    const svg = PLATFORM_SVG[id];
    if (!svg) return "";
    return `<span class="chat-platform-icon is-${id}" title="${label}">${svg}</span>`;
  }

  function nickHtml(nick, platform) {
    const name = String(nick || "");
    if (!name) return "";
    const icon = platformIconHtml(platform);
    return `${icon}<span class="nick-name">@${escapeHtml(name)}</span>`;
  }

  function fillNickEl(el, nick, platform) {
    if (!el) return;
    if (!nick) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = nickHtml(nick, platform);
  }

  function parseChatTarget(raw, fallbackServer) {
    const text = String(raw || "").trim();
    let server = SERVER_IDS.has(fallbackServer) ? fallbackServer : "twitch";
    if (!text) return { server, channel: "" };

    let urlText = text;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText) && /[./]/.test(urlText)) {
      urlText = "https://" + urlText.replace(/^\/+/, "");
    }

    try {
      const u = new URL(urlText);
      if (u.hostname) {
        const host = u.hostname.replace(/^www\./i, "");
        const rule = HOST_RULES.find((r) => r.re.test(host));
        if (rule) {
          const path = u.pathname.replace(/^\/+|\/+$/g, "");
          const first = (path.split("/")[0] || "").replace(/^@/, "");
          if (first && first !== "videos" && first !== "directory") {
            return {
              server: rule.server,
              channel: first.toLowerCase(),
            };
          }
          return { server: rule.server, channel: "" };
        }
      }
    } catch (_) {}

    const channel = text.replace(/^#/, "").split(/[/?#\s]/)[0].toLowerCase();
    return { server, channel };
  }

  function extractWord(text) {
    const t = (text || "").trim().toLowerCase();
    if (!/^[а-яё]+$/.test(t)) return null;
    if (t.length < 2 || t.length > 30) return null;
    return t;
  }

  function parseChatCommand(text) {
    const cmd = (text || "").trim().toLowerCase();
    if (cmd === "!context_hint") return "hint";
    if (cmd === "!context_restart") return "restart";
    if (cmd === "!context_reload") return "reload";
    if (cmd === "!context_reset_stats") return "reset_stats";
    return null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badgeBlob(badges) {
    if (!Array.isArray(badges)) return "";
    return badges
      .map((b) =>
        [b && b.id, b && b.title, b && b.name, b && b.type]
          .filter(Boolean)
          .join(" ")
      )
      .join(" ")
      .toLowerCase();
  }

  function isPrivilegedChatMessage(msg, extraLogins, extraChannel) {
    const user = (msg && msg.user) || {};
    const display = String(user.displayName || "").toLowerCase();
    const login = String(user.id || "").toLowerCase();
    if (extraLogins && (extraLogins.has(display) || extraLogins.has(login))) {
      return true;
    }

    const channel = String(extraChannel || (msg && msg.channel) || "")
      .toLowerCase()
      .replace(/^#/, "");
    if (channel && (login === channel || display === channel)) {
      return true;
    }

    const tf = user.twitchFields;
    if (tf) {
      if (tf.mod) return true;
      const blob = badgeBlob(tf.badges);
      if (
        /\bbroadcaster\b/.test(blob) ||
        /\bmoderator\b/.test(blob) ||
        /\bstaff\b/.test(blob)
      ) {
        return true;
      }
    }

    const vf = user.vkFields;
    if (vf && (vf.isChatModerator || vf.isChannelModerator)) return true;
    if (vf && Array.isArray(vf.roles)) {
      const roles = vf.roles
        .map((r) => String(r && (r.name || r.slug || r) || "").toLowerCase())
        .join(" ");
      if (/\bmoderator\b|\badmin\b|\bowner\b|\bbroadcaster\b/.test(roles)) {
        return true;
      }
    }

    const kf = user.kickFields;
    if (kf) {
      const blob = badgeBlob(kf.badges);
      if (
        /\bmoderator\b/.test(blob) ||
        /\bbroadcaster\b/.test(blob) ||
        /\bhost\b/.test(blob)
      ) {
        return true;
      }
    }

    const wf = user.wtvFields;
    if (wf && Array.isArray(wf.tags)) {
      if (
        wf.tags.some((t) =>
          /mod|admin|owner|broadcaster|streamer/i.test(String(t))
        )
      ) {
        return true;
      }
    }

    return false;
  }

  async function chatApi(path, opts = {}) {
    const init = {
      headers: { "Content-Type": "application/json" },
      ...opts,
    };
    const res = await fetch("/api" + path, init);
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

  function createChatSession(handlers) {
    const autoReconnect = handlers.autoReconnect !== false;
    const state = {
      server: "",
      channel: null,
      status: "disconnected",
      pollTimer: null,
      failTimer: null,
      tsFrom: 0,
      seenIds: new Set(),
      generation: 0,
      lastPollOkAt: 0,
      lastMessageAt: 0,
      connectedAt: 0,
      connectingSince: 0,
      pollErrors: 0,
    };

    let lastTarget = null;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let abortCtrl = null;
    let wantLive = false;
    let reconnectAttempt = 0;
    let resumeOnReconnect = false;
    let lastWatchdogAt = 0;
    let wakeBound = false;

    function emitStatus() {
      if (!SERVER_IDS.has(state.server)) return;
      handlers.onStatus &&
        handlers.onStatus(state.status, state.server, state.channel);
    }

    function reconnectDelay() {
      const n = Math.max(0, reconnectAttempt);
      return Math.min(
        BACKOFF_MAX_MS,
        Math.round(BACKOFF_MIN_MS * Math.pow(1.45, n))
      );
    }

    function rememberId(id) {
      if (!id) return false;
      if (state.seenIds.has(id)) return true;
      state.seenIds.add(id);
      if (state.seenIds.size > SEEN_CAP) {
        const first = state.seenIds.values().next().value;
        state.seenIds.delete(first);
      }
      return false;
    }

    function clearWatchdog() {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
    }

    function stopPolling() {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      if (state.failTimer) {
        clearTimeout(state.failTimer);
        state.failTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortCtrl) {
        try {
          abortCtrl.abort();
        } catch (_) {}
        abortCtrl = null;
      }
    }

    function unbindWake() {
      if (!wakeBound) return;
      wakeBound = false;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    }

    function bindWake() {
      if (wakeBound) return;
      wakeBound = true;
      document.addEventListener("visibilitychange", onWake);
      window.addEventListener("online", onWake);
      window.addEventListener("focus", onWake);
      window.addEventListener("pageshow", onWake);
    }

    function onWake() {
      if (!wantLive || !lastTarget) return;
      lastWatchdogAt = Date.now();
      if (document.visibilityState === "hidden") return;
      if (state.status === "connected") {
        tickWatchdog({ fromWake: true });
        return;
      }
      reconnectNow();
    }

    function scheduleReconnect() {
      if (!autoReconnect || !wantLive || !lastTarget) return;
      if (reconnectTimer) return;
      const delay = reconnectDelay();
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!wantLive || !lastTarget) return;
        connect(lastTarget.server, lastTarget.channel, { resume: true });
      }, delay);
    }

    function reconnectNow() {
      if (!autoReconnect || !wantLive || !lastTarget) return;
      resumeOnReconnect = true;
      const target = lastTarget;
      disconnect();
      connect(target.server, target.channel, { resume: true });
    }

    function retryForever(notifyText) {
      resumeOnReconnect = true;
      if (notifyText && handlers.onError) handlers.onError(notifyText);
      disconnect({ reconnect: true });
    }

    function disconnect({ reconnect = false, manual = false } = {}) {
      state.generation += 1;
      stopPolling();
      if (manual) {
        wantLive = false;
        lastTarget = null;
        resumeOnReconnect = false;
        reconnectAttempt = 0;
        clearWatchdog();
        unbindWake();
      }
      state.channel = null;
      state.status = "disconnected";
      state.connectingSince = 0;
      if (!reconnect) state.seenIds = new Set();
      emitStatus();
      if (reconnect) scheduleReconnect();
    }

    function tickWatchdog(opts = {}) {
      if (!wantLive || !lastTarget) return;
      const now = Date.now();
      const gap = lastWatchdogAt ? now - lastWatchdogAt : 0;
      lastWatchdogAt = now;

      if (gap > FREEZE_MS) {
        reconnectNow();
        return;
      }
      if (reconnectTimer) return;

      if (state.status === "connecting") {
        if (
          state.connectingSince &&
          now - state.connectingSince > CONNECT_TIMEOUT_MS + 2000
        ) {
          retryForever();
        }
        return;
      }

      if (state.status !== "connected") {
        scheduleReconnect();
        return;
      }

      const pollStale =
        state.lastPollOkAt && now - state.lastPollOkAt > STALE_POLL_MS;
      const zombie =
        state.lastMessageAt &&
        now - state.lastMessageAt > ZOMBIE_SILENCE_MS &&
        state.connectedAt &&
        now - state.connectedAt > ZOMBIE_SILENCE_MS;
      const tooManyErrors = state.pollErrors >= MAX_POLL_ERRORS;
      if (pollStale || zombie || tooManyErrors) {
        resumeOnReconnect = true;
        disconnect({ reconnect: true });
      }
    }

    function startWatchdog() {
      lastWatchdogAt = Date.now();
      if (watchdogTimer) return;
      watchdogTimer = setInterval(() => tickWatchdog(), WATCHDOG_MS);
    }

    async function poll(generation) {
      if (generation !== state.generation) return;
      const server = state.server;
      const channel = state.channel;
      if (!channel) return;

      abortCtrl = new AbortController();
      const hangTimer = setTimeout(() => {
        try {
          abortCtrl && abortCtrl.abort();
        } catch (_) {}
      }, POLL_TIMEOUT_MS);

      try {
        const data = await chatApi(
          `/chat/messages?server=${encodeURIComponent(server)}&channel=${encodeURIComponent(
            channel
          )}&tsFrom=${encodeURIComponent(String(state.tsFrom))}`,
          { signal: abortCtrl.signal }
        );
        if (generation !== state.generation) return;

        state.lastPollOkAt = Date.now();
        state.pollErrors = 0;
        reconnectAttempt = 0;

        const st = data && data.status;
        const conn = st && st.status;
        if (conn === "connected" && state.status !== "connected") {
          state.status = "connected";
          state.connectedAt = Date.now();
          state.connectingSince = 0;
          if (state.failTimer) {
            clearTimeout(state.failTimer);
            state.failTimer = null;
          }
          emitStatus();
          handlers.onClearError && handlers.onClearError();
        } else if (
          (conn === "disconnected" || !st) &&
          state.status === "connected"
        ) {
          retryForever();
          return;
        }

        const messages = (data && data.messages) || [];
        if (messages.length) state.lastMessageAt = Date.now();
        for (const msg of messages) {
          if (!msg) continue;
          const id =
            msg.id ||
            `${msg.timestampMs || ""}:${(msg.user && msg.user.id) || ""}:${msg.text || ""}`;
          if (rememberId(id)) continue;
          if (typeof msg.timestampMs === "number" && msg.timestampMs > state.tsFrom) {
            state.tsFrom = msg.timestampMs;
          }
          handlers.onMessage &&
            handlers.onMessage({
              ...msg,
              server: msg.server || state.server,
              channel: msg.channel || state.channel,
            });
        }
      } catch (e) {
        if (generation !== state.generation) return;
        if (e && e.name === "AbortError") {
          if (state.status === "connected") state.pollErrors += 1;
        } else if (state.status !== "connected") {
          retryForever(reconnectAttempt === 0 ? e.message || "ошибка чата" : "");
          return;
        } else {
          state.pollErrors += 1;
        }
      } finally {
        clearTimeout(hangTimer);
      }

      if (generation !== state.generation) return;
      state.pollTimer = setTimeout(() => poll(generation), POLL_MS);
    }

    async function connect(server, channel, opts = {}) {
      server = (server || "twitch").toLowerCase();
      channel = (channel || "").trim().toLowerCase().replace(/^#/, "");
      if (!SERVER_IDS.has(server) || !channel) return;

      const resume = !!(opts.resume || resumeOnReconnect);
      resumeOnReconnect = false;
      const prevTs = state.tsFrom;
      const prevSeen = state.seenIds;

      lastTarget = { server, channel };
      wantLive = true;
      startWatchdog();
      bindWake();
      state.server = server;
      disconnect();
      const generation = state.generation;
      state.channel = channel;
      state.status = "connecting";
      state.connectingSince = Date.now();
      state.pollErrors = 0;
      state.lastPollOkAt = Date.now();
      state.connectedAt = 0;
      if (resume && prevTs) {
        state.tsFrom = prevTs;
        state.seenIds = prevSeen;
      } else {
        state.tsFrom = Date.now() - 1500;
        state.seenIds = new Set();
        state.lastMessageAt = 0;
      }
      emitStatus();

      abortCtrl = new AbortController();
      const firstTry = reconnectAttempt === 0;
      state.failTimer = setTimeout(() => {
        if (generation !== state.generation) return;
        if (state.status !== "connected") {
          try {
            abortCtrl && abortCtrl.abort();
          } catch (_) {}
          retryForever(
            firstTry
              ? "нет связи с " + formatChatTarget(server, channel) + ", пробуем снова"
              : ""
          );
        }
      }, CONNECT_TIMEOUT_MS);

      try {
        await chatApi("/chat/connect", {
          method: "POST",
          body: JSON.stringify({ server, channel }),
          signal: abortCtrl.signal,
        });
      } catch (e) {
        if (generation !== state.generation) return;
        if (e && e.name === "AbortError") {
          retryForever();
          return;
        }
        retryForever(firstTry ? e.message || "ошибка подключения" : "");
        return;
      }

      if (generation !== state.generation) return;
      poll(generation);
    }

    return {
      connect,
      disconnect,
      getState: () => ({
        server: state.server,
        channel: state.channel,
        status: state.status,
      }),
    };
  }

  function parseChatsFromSearch(search) {
    const params =
      search instanceof URLSearchParams
        ? search
        : new URLSearchParams(search || "");
    const chats = [];
    const seen = new Set();
    for (const meta of CHAT_SERVERS) {
      const raw = params.get(meta.id);
      if (!raw) continue;
      const parsed = parseChatTarget(raw, meta.id);
      if (parsed.channel && !seen.has(parsed.server)) {
        seen.add(parsed.server);
        chats.push({ server: parsed.server, channel: parsed.channel });
      }
    }
    const legacyRaw = params.get("channel");
    if (legacyRaw) {
      const parsed = parseChatTarget(
        legacyRaw,
        (params.get("server") || "twitch").trim().toLowerCase()
      );
      if (parsed.channel && !seen.has(parsed.server)) {
        seen.add(parsed.server);
        chats.push({ server: parsed.server, channel: parsed.channel });
      }
    }
    return chats;
  }

  function applyChatsToSearch(params, chats) {
    const next =
      params instanceof URLSearchParams
        ? params
        : new URLSearchParams(params || "");
    for (const meta of CHAT_SERVERS) next.delete(meta.id);
    next.delete("channel");
    next.delete("server");
    for (const t of chats || []) {
      if (!t || !t.channel || !SERVER_IDS.has(t.server)) continue;
      next.set(t.server, t.channel);
    }
    return next;
  }

  function createChatHub(handlers) {
    const sessions = new Map();

    function sessionHandlers(server) {
      return {
        onStatus: (status, srv, channel) => {
          handlers.onStatus &&
            handlers.onStatus(status, srv || server, channel);
        },
        onError: (text) => {
          handlers.onError && handlers.onError(text, server);
        },
        onClearError: () => {
          handlers.onClearError && handlers.onClearError(server);
        },
        onMessage: (msg) => {
          handlers.onMessage && handlers.onMessage(msg);
        },
        autoReconnect: handlers.autoReconnect !== false,
      };
    }

    function getSession(server) {
      let session = sessions.get(server);
      if (!session) {
        session = createChatSession(sessionHandlers(server));
        sessions.set(server, session);
      }
      return session;
    }

    function connect(server, channel) {
      server = String(server || "").toLowerCase();
      channel = String(channel || "")
        .trim()
        .toLowerCase()
        .replace(/^#/, "");
      if (!SERVER_IDS.has(server) || !channel) return;
      getSession(server).connect(server, channel);
    }

    function disconnect(server, opts = {}) {
      server = String(server || "").toLowerCase();
      const session = sessions.get(server);
      if (!session) return;
      session.disconnect({ manual: true, ...opts });
    }

    function connectMany(targets) {
      for (const t of targets || []) {
        if (!t || !t.channel) continue;
        connect(t.server, t.channel);
      }
    }

    function disconnectAll() {
      for (const session of sessions.values()) {
        session.disconnect({ manual: true });
      }
    }

    function getState(server) {
      const session = sessions.get(server);
      if (session) return session.getState();
      return { server, channel: null, status: "disconnected" };
    }

    function getStates() {
      return CHAT_SERVERS.map((meta) => ({
        id: meta.id,
        label: meta.label,
        ...getState(meta.id),
      }));
    }

    return {
      connect,
      disconnect,
      connectMany,
      disconnectAll,
      getState,
      getStates,
    };
  }

  global.ChatClient = {
    CHAT_SERVERS,
    serverMeta,
    formatChatTarget,
    platformIconHtml,
    nickHtml,
    fillNickEl,
    parseChatTarget,
    parseChatsFromSearch,
    applyChatsToSearch,
    extractWord,
    parseChatCommand,
    isPrivilegedChatMessage,
    createChatSession,
    createChatHub,
  };
})(window);
