(function () {
  var scriptTag = document.currentScript;
  var CHAT_API_URL = (scriptTag && scriptTag.getAttribute("data-api-url")) || "http://localhost:3000/api/chat";

  var style = document.createElement("style");
  style.textContent =
    "#wcb-toggle{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#111;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2);z-index:999999}" +
    "#wcb-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:system-ui,sans-serif}" +
    "#wcb-panel.open{display:flex}" +
    "#wcb-header{background:#111;color:#fff;padding:12px 16px;font-weight:600}" +
    "#wcb-messages{flex:1;overflow-y:auto;padding:12px;font-size:14px}" +
    ".wcb-msg{margin-bottom:10px;line-height:1.4;white-space:pre-wrap}" +
    ".wcb-msg.user{text-align:right;color:#111}" +
    ".wcb-msg.bot{text-align:left;color:#333}" +
    "#wcb-input-row{display:flex;border-top:1px solid #eee}" +
    "#wcb-input{flex:1;border:none;padding:12px;font-size:14px;outline:none}" +
    "#wcb-send{border:none;background:#111;color:#fff;padding:0 16px;cursor:pointer}";
  document.head.appendChild(style);

  var toggle = document.createElement("button");
  toggle.id = "wcb-toggle";
  toggle.textContent = "💬";
  document.body.appendChild(toggle);

  var panel = document.createElement("div");
  panel.id = "wcb-panel";
  panel.innerHTML =
    '<div id="wcb-header">Chat with us</div>' +
    '<div id="wcb-messages"></div>' +
    '<div id="wcb-input-row">' +
    '<input id="wcb-input" type="text" placeholder="Ask a question..." />' +
    '<button id="wcb-send">Send</button>' +
    "</div>";
  document.body.appendChild(panel);

  toggle.addEventListener("click", function () {
    panel.classList.toggle("open");
  });

  var messagesEl = panel.querySelector("#wcb-messages");
  var inputEl = panel.querySelector("#wcb-input");
  var sendEl = panel.querySelector("#wcb-send");
  var history = [];

  function addMessage(role, text) {
    var div = document.createElement("div");
    div.className = "wcb-msg " + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  async function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    addMessage("user", text);
    var historyForRequest = history.slice();
    history.push({ role: "user", content: text });

    var botDiv = addMessage("bot", "");
    var full = "";

    try {
      var res = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: historyForRequest }),
      });
      if (!res.body) {
        full = await res.text();
        botDiv.textContent = full;
      } else {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          full += decoder.decode(chunk.value, { stream: true });
          botDiv.textContent = full;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }
    } catch (e) {
      full = full || "Sorry, something went wrong.";
      botDiv.textContent = full;
    }

    history.push({ role: "assistant", content: full });
  }

  sendEl.addEventListener("click", send);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") send();
  });
})();
