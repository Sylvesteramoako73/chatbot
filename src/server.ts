import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { streamChatResponse, ChatMessage } from "./chat";
import { ingestDocument, ingestWebsite } from "./ingest";

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? "*" }));
app.use(express.json({ limit: "2mb" }));
app.use("/widget", express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const { message, history } = req.body as { message?: string; history?: ChatMessage[] };
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    for await (const token of streamChatResponse(message, Array.isArray(history) ? history : [])) {
      res.write(token);
    }
    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error" });
    } else {
      res.end();
    }
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
