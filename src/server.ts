import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { streamChatResponse, ChatMessage } from "./chat";
import { ingestDocument, ingestWebsite } from "./ingest";
import {
  getOrCreateConversation,
  startHandoff,
  relayVisitorMessage,
  recordVisitorMessage,
  recordBotReply,
  handleOwnerReply,
} from "./handoff";
import { subscribeToSession } from "./events";

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "*").split(",").map((o) => o.trim());
app.use(cors({ origin: allowedOrigins.length > 1 ? allowedOrigins : allowedOrigins[0] }));
app.use(express.json({ limit: "2mb" }));
app.use("/widget", express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const { message, history, sessionId } = req.body as {
    message?: string;
    history?: ChatMessage[];
    sessionId?: string;
  };
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  // No sessionId means a bare API call with no persistence/handoff — stream straight from the bot.
  if (!sessionId || typeof sessionId !== "string") {
    try {
      for await (const token of streamChatResponse(message, Array.isArray(history) ? history : [])) {
        res.write(token);
      }
      res.end();
    } catch (err) {
      console.error("Chat error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
      else res.end();
    }
    return;
  }

  try {
    const conversation = await getOrCreateConversation(sessionId);

    if (conversation.status === "handoff") {
      await relayVisitorMessage(conversation.id, message);
      res.end(); // owner's reply arrives later over the SSE stream, not this response
      return;
    }

    await recordVisitorMessage(conversation.id, message);
    let full = "";
    for await (const token of streamChatResponse(message, Array.isArray(history) ? history : [])) {
      full += token;
      res.write(token);
    }
    res.end();
    await recordBotReply(conversation.id, full);
  } catch (err) {
    console.error("Chat error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    else res.end();
  }
});

app.post("/api/chat/handoff", async (req: Request, res: Response) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }
  try {
    await startHandoff(sessionId);
    res.json({ status: "handoff" });
  } catch (err) {
    console.error("Handoff error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/chat/stream/:sessionId", (req: Request, res: Response) => {
  const { sessionId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const unsubscribe = subscribeToSession(sessionId, (content) => {
    res.write(`data: ${JSON.stringify({ content })}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/api/webhooks/whatsapp", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/api/webhooks/whatsapp", async (req: Request, res: Response) => {
  // Acknowledge immediately — Meta retries aggressively on non-200s/timeouts.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (message.type !== "text") continue;
          const contextWamid = message.context?.id ?? null;
          await handleOwnerReply(message.text.body, contextWamid);
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
  }
});

app.post("/api/ingest/document", async (req: Request, res: Response) => {
  const { title, content } = req.body as { title?: string; content?: string };
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }
  try {
    const result = await ingestDocument(title, content);
    res.json(result);
  } catch (err) {
    console.error("Ingest error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/ingest/crawl", (req: Request, res: Response) => {
  const { url, maxPages } = req.body as { url?: string; maxPages?: number };
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  // Crawling a site can take a while — acknowledge immediately and run in the background.
  res.json({ status: "started", url });
  ingestWebsite(url, maxPages ?? 50).catch((err) => console.error("Crawl error:", err));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
