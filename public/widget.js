(function () {
  var scriptTag = document.currentScript;
  var CHAT_API_URL = (scriptTag && scriptTag.getAttribute("data-api-url")) || "http://localhost:3000/api/chat";
  var SITE_KEY = scriptTag && scriptTag.getAttribute("data-site-key");
  var API_BASE = CHAT_API_URL.replace(/\/api\/chat\/?$/, "");
  var HANDOFF_URL = API_BASE + "/api/chat/handoff";
  var NAME_URL = API_BASE + "/api/chat/name";
  var GREETING_DELAY_MS = 45000;

  if (!SITE_KEY) {
    console.error("Website chatbot widget: missing data-site-key attribute on the <script> tag.");
    return;
  }

  function getSessionId() {
    var key = "wcb_session_id";
    var id = localStorage.getItem(key);
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : "sess-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      localStorage.setItem(key, id);
    }
    return id;
  }

  var sessionId = getSessionId();
  var handoffActive = localStorage.getItem("wcb_handoff_" + sessionId) === "1";

  var style = document.createElement("style");
  style.textContent =
    "#wcb-toggle{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#111;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:999999}" +
    "#wcb-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:system-ui,sans-serif}" +
    "#wcb-panel.open{display:flex}" +
    "#wcb-header{background:#111;color:#fff;padding:12px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}" +
    "#wcb-human{background:none;border:1px solid rgba(255,255,255,.4);color:#fff;font-size:11px;padding:4px 8px;border-radius:20px;cursor:pointer}" +
    "#wcb-human:disabled{opacity:.5;cursor:default}" +
    "#wcb-messages{flex:1;overflow-y:auto;padding:12px;font-size:14px}" +
    ".wcb-msg{margin-bottom:10px;line-height:1.4;white-space:pre-wrap}" +
    ".wcb-msg.user{text-align:right;color:#111}" +
    ".wcb-msg.bot{text-align:left;color:#333}" +
    ".wcb-msg.agent{text-align:left;color:#0b7a3b}" +
    ".wcb-msg.agent::before{content:'Team: '}" +
    ".wcb-msg.system{text-align:center;color:#888;font-size:12px;font-style:italic}" +
    "#wcb-input-row{display:flex;border-top:1px solid #eee}" +
    "#wcb-input{flex:1;border:none;padding:12px;font-size:14px;outline:none}" +
    "#wcb-send{border:none;background:#111;color:#fff;padding:0 16px;cursor:pointer}" +
    ".wcb-name-form{display:flex;gap:6px;margin:4px 0 10px}" +
    ".wcb-name-form input{flex:1;border:1px solid #ddd;border-radius:6px;padding:8px;font-size:13px;min-width:0}" +
    ".wcb-name-form button{border:none;background:#111;color:#fff;border-radius:6px;padding:8px 12px;font-size:13px;cursor:pointer}" +
    ".wcb-typing{display:inline-flex;gap:3px;padding:2px 0}" +
    ".wcb-typing span{width:6px;height:6px;border-radius:50%;background:#999;animation:wcb-bounce 1.1s infinite ease-in-out}" +
    ".wcb-typing span:nth-child(2){animation-delay:0.15s}" +
    ".wcb-typing span:nth-child(3){animation-delay:0.3s}" +
    "@keyframes wcb-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}";
  document.head.appendChild(style);

  var toggle = document.createElement("button");
  toggle.id = "wcb-toggle";
  toggle.textContent = "💬";
  document.body.appendChild(toggle);

  var panel = document.createElement("div");
  panel.id = "wcb-panel";
  panel.innerHTML =
    '<div id="wcb-header"><span>Chat with us</span><button id="wcb-human">Talk to a person</button></div>' +
    '<div id="wcb-messages"></div>' +
    '<div id="wcb-input-row">' +
    '<input id="wcb-input" type="text" placeholder="Ask a question..." />' +
    '<button id="wcb-send">Send</button>' +
    "</div>";
  document.body.appendChild(panel);

  var userInteracted = false;

  toggle.addEventListener("click", function () {
    var isFirstOpen = !userInteracted && !handoffActive && localStorage.getItem("wcb_greeted_" + sessionId) !== "1";
    userInteracted = true;
    panel.classList.toggle("open");
    if (isFirstOpen) showGreeting();
  });

  var messagesEl = panel.querySelector("#wcb-messages");
  var inputEl = panel.querySelector("#wcb-input");
  var sendEl = panel.querySelector("#wcb-send");
  var humanEl = panel.querySelector("#wcb-human");
  var history = [];

  function addMessage(role, text) {
    var div = document.createElement("div");
    div.className = "wcb-msg " + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // Reveals text at a steady, readable pace regardless of how bursty the underlying network
  // chunks are — Groq generates fast enough that raw pass-through can look like the whole
  // reply landed at once instead of streaming in.
  function createRevealer(el) {
    var full = "";
    var pending = "";
    var timer = null;
    var waiters = [];

    function tick() {
      if (!pending.length) {
        timer = null;
        var toResolve = waiters;
        waiters = [];
        toResolve.forEach(function (resolve) { resolve(); });
        return;
      }
      var take = Math.min(2, pending.length);
      full += pending.slice(0, take);
      pending = pending.slice(take);
      el.textContent = full;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      timer = setTimeout(tick, 20);
    }

    return {
      push: function (text) {
        pending += text;
        if (!timer) tick();
      },
      drain: function () {
        return new Promise(function (resolve) {
          if (!timer && !pending.length) resolve();
          else waiters.push(resolve);
        });
      },
      text: function () {
        return full + pending;
      },
    };
  }

  function setHandoffActive() {
    handoffActive = true;
    localStorage.setItem("wcb_handoff_" + sessionId, "1");
    humanEl.textContent = "Connected";
    humanEl.disabled = true;
  }

  if (handoffActive) {
    humanEl.textContent = "Connected";
    humanEl.disabled = true;
  }

  humanEl.addEventListener("click", async function () {
    humanEl.disabled = true;
    try {
      var res = await fetch(HANDOFF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: SITE_KEY, sessionId: sessionId }),
      });
      if (!res.ok) throw new Error("handoff request failed");
      setHandoffActive();
      addMessage("system", "Connecting you to our team — they'll reply here shortly.");
    } catch (e) {
      humanEl.disabled = false;
      addMessage("system", "Couldn't reach our team right now — please try again.");
    }
  });

  // Team replies from the dashboard arrive here, pushed live — no page reload needed. A "handoff"
  // event means the bot itself escalated (it couldn't answer), so the widget switches into the
  // same silent-relay mode as clicking "Talk to a person" would.
  try {
    var streamUrl = API_BASE + "/api/chat/stream?siteKey=" + encodeURIComponent(SITE_KEY) + "&sessionId=" + encodeURIComponent(sessionId);
    var stream = new EventSource(streamUrl);
    stream.onmessage = function (event) {
      var data = JSON.parse(event.data);
      if (data.type === "handoff") setHandoffActive();
      addMessage(data.role || "agent", data.content);
    };
  } catch (e) {
    // EventSource unsupported — live team replies just won't show; not fatal to the rest of the widget.
  }

  // Cumulative across page loads, not per-page — a visitor clicking between pages at 20s each
  // should still get greeted once they've spent 45s on the site in total, not have the timer
  // restart on every navigation.
  function getFirstSeenAt() {
    var key = "wcb_first_seen_" + sessionId;
    var value = localStorage.getItem(key);
    if (!value) {
      value = String(Date.now());
      localStorage.setItem(key, value);
    }
    return Number(value);
  }

  function showNameForm() {
    var formDiv = document.createElement("div");
    formDiv.className = "wcb-name-form";
    formDiv.innerHTML = '<input type="text" placeholder="Your name" /><button type="button">Send</button>';
    var nameInput = formDiv.querySelector("input");

    function submitName() {
      var name = nameInput.value.trim();
      if (!name) return;
      formDiv.remove();
      fetch(NAME_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: SITE_KEY, sessionId: sessionId, name: name }),
      })
        .then(function () {
          addMessage("bot", "Nice to meet you, " + name + "! What can I help you with today?");
        })
        .catch(function () {
          addMessage("system", "Couldn't save that — no worries, go ahead and ask your question.");
        });
    }

    formDiv.querySelector("button").addEventListener("click", submitName);
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submitName();
    });

    messagesEl.appendChild(formDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Shared by the idle-timer greeting below and the toggle button's first-ever click — whichever
  // happens first shows the welcome + name prompt; "wcb_greeted_" makes sure it only happens once.
  function showGreeting() {
    localStorage.setItem("wcb_greeted_" + sessionId, "1");
    addMessage("bot", "Hi there! 👋 Looking for something specific? Happy to help — and how should I address you?");
    showNameForm();
  }

  function maybeShowGreeting() {
    if (userInteracted || handoffActive || localStorage.getItem("wcb_greeted_" + sessionId) === "1") return;
    userInteracted = true;
    panel.classList.add("open");
    showGreeting();
  }

  if (localStorage.getItem("wcb_greeted_" + sessionId) !== "1" && !handoffActive) {
    var remainingMs = GREETING_DELAY_MS - (Date.now() - getFirstSeenAt());
    setTimeout(maybeShowGreeting, Math.max(remainingMs, 0));
  }

  async function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    userInteracted = true;
    inputEl.value = "";
    addMessage("user", text);
    var historyForRequest = history.slice();
    history.push({ role: "user", content: text });

    if (handoffActive) {
      try {
        await fetch(CHAT_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteKey: SITE_KEY, message: text, history: historyForRequest, sessionId: sessionId }),
        });
      } catch (e) {
        addMessage("system", "Couldn't send that — please try again.");
      }
      return;
    }

    var botDiv = addMessage("bot", "");
    botDiv.innerHTML = '<span class="wcb-typing"><span></span><span></span><span></span></span>';
    var revealer = createRevealer(botDiv);
    var firstChunk = true;

    function pushChunk(str) {
      if (!str) return;
      if (firstChunk) {
        firstChunk = false;
        botDiv.textContent = ""; // clear the typing indicator the moment real content starts
      }
      revealer.push(str);
    }

    try {
      var res = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteKey: SITE_KEY, message: text, history: historyForRequest, sessionId: sessionId }),
      });
      if (!res.body) {
        pushChunk(await res.text());
      } else {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          pushChunk(decoder.decode(chunk.value, { stream: true }));
        }
      }
      await revealer.drain();
    } catch (e) {
      pushChunk(revealer.text() ? "" : "Sorry, something went wrong.");
      await revealer.drain();
    }

    history.push({ role: "assistant", content: revealer.text() });
  }

  sendEl.addEventListener("click", send);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") send();
  });
})();
