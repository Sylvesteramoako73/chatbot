import { retrieveContext } from "./retrieve";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const TOP_K = 5;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Free Groq plans have small per-model rate limits, and each model has its own quota. When the main
// model is rate limited (429), the request is too big for its per-minute token quota (413), or Groq
// errors (5xx), the next model in this list answers instead, so visitors don't get an error.
const FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ?? "openai/gpt-oss-20b,llama-3.3-70b-versatile,llama-3.1-8b-instant")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

async function groqStreamRequest(apiKey: string, messages: { role: string; content: string }[]): Promise<Response> {
  const models = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];
  let lastError = "";
  for (const model of models) {
    const payload: Record<string, unknown> = { model, stream: true, messages };
    // gpt-oss models think before answering; low effort keeps replies fast and uses fewer tokens.
    if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
    let res: Response;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastError = `${model}: ${(err as Error).message}`;
      continue;
    }
    if (res.ok && res.body) return res;
    const text = await res.text().catch(() => "");
    lastError = `${model}: ${res.status} ${text.slice(0, 200)}`;
    if (res.status !== 429 && res.status !== 413 && res.status < 500) break;
    console.warn(`Groq ${model} unavailable (${res.status}), trying next model`);
  }
  throw new Error(`Groq request failed: ${lastError}`);
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function defaultTone(businessName: string): string {
  return `Be warm, direct, and helpful — the way a knowledgeable staff member at ${businessName} would talk to a visitor. Keep answers concise.`;
}

// When the bot can't confidently answer from the reference notes, it ends its reply with this
// exact token so the caller can flag the conversation for the sales team — stripped before the
// customer ever sees it, in both the streamed widget response and the WhatsApp reply.
export const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";

// Once the visitor has shared their name plus a phone number or email, the bot appends this tag
// with whatever it has collected, e.g. [[LEAD {"name":"Ama","phone":"0244123456"}]]. Like the
// handoff marker it's stripped before the customer sees anything; the server uses it to fill in
// the lead and fire the sales/client alerts (see leadAlerts.ts).
export const LEAD_MARKER_PREFIX = "[[LEAD";
const LEAD_MARKER_RE = /\[\[LEAD\s*(\{[\s\S]*?\})\s*\]\]/;

export interface CapturedLead {
  name?: string;
  phone?: string;
  email?: string;
  interest?: string;
  unit?: string;
  location?: string;
  preferredTime?: string;
}

// When the bot wants the visitor to pick from the business's projects, it ends its reply with this
// tag; the widget swaps it for tick boxes (other channels get the options as a short text list).
export const OPTIONS_MARKER = "[[OPTIONS]]";
const OPTIONS_MARKER_RE = /\[\[OPTIONS[^\]]*\]\]/g;

export interface ParsedBotReply {
  visible: string;
  needsHuman: boolean;
  lead: CapturedLead | null;
  showOptions: boolean;
}

function cleanField(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Pulls both markers out of a finished bot reply: the customer-facing text plus what they signal. */
export function parseBotReply(full: string): ParsedBotReply {
  let visible = full;
  let lead: CapturedLead | null = null;

  const match = visible.match(LEAD_MARKER_RE);
  if (match) {
    visible = visible.replace(match[0], "");
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      lead = {
        name: cleanField(raw.name, 120),
        phone: cleanField(raw.phone, 40),
        email: cleanField(raw.email, 200),
        interest: cleanField(raw.interest),
        unit: cleanField(raw.unit),
        location: cleanField(raw.location),
        preferredTime: cleanField(raw.preferred_time ?? raw.preferredTime),
      };
    } catch {
      lead = null; // malformed JSON from the model — still strip the tag, just don't act on it
    }
  }
  const showOptions = visible.search(OPTIONS_MARKER_RE) !== -1;
  visible = visible.replace(OPTIONS_MARKER_RE, "");

  // A truncated tag (stream cut off mid-tag) must never leak to the customer either.
  const dangling = visible.indexOf(LEAD_MARKER_PREFIX);
  if (dangling !== -1) visible = visible.slice(0, dangling);

  const needsHuman = visible.includes(NEEDS_HUMAN_MARKER);
  if (needsHuman) visible = visible.replace(NEEDS_HUMAN_MARKER, "");
  // Any other half-written "[[" tag at the very end is dropped rather than shown.
  const strayTag = visible.lastIndexOf("[[");
  if (strayTag !== -1 && !visible.slice(strayTag).includes("]]")) visible = visible.slice(0, strayTag);

  return { visible: visible.replace(/\s+$/, ""), needsHuman, lead, showOptions };
}

/**
 * True once the visitor has named any of the projects (by full name or its first word, e.g.
 * "Serenity"), so the tick boxes aren't offered again after they've already chosen.
 */
export function visitorNamedProject(texts: string[], options: string[]): boolean {
  const said = texts.join(" \n ").toLowerCase();
  return options.some((opt) => {
    const full = opt.toLowerCase();
    const first = full.split(/\s+/)[0];
    return said.includes(full) || (first.length >= 4 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, "")}\\b`).test(said));
  });
}

export interface ChatContext {
  /** The visitor's name if we already know it (widget name form, WhatsApp profile, earlier in chat). */
  visitorName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** The business's projects/products, offered to the visitor as tick boxes. */
  projectOptions?: string[];
  /** True when we already hold a phone number or email for this visitor. */
  visitorHasContact?: boolean;
  /** Filled in by streamChatResponse from the history. */
  alreadyAskedForContact?: boolean;
}

const CONTACT_ASK_RE = /\b(phone|whatsapp|e-?mail|contact (details|number)|your number)\b/i;

/** Has the bot already asked this visitor for their contact details earlier in the chat? */
export function botAlreadyAskedForContact(history: ChatMessage[]): boolean {
  return history.some((m) => m.role === "assistant" && m.content.includes("?") && CONTACT_ASK_RE.test(m.content));
}

function contactBlock(hasContact: boolean, alreadyAsked: boolean): string {
  if (hasContact) {
    return `\n\nWe already have this visitor's contact details, so never ask for their phone number or email.`;
  }
  if (alreadyAsked) {
    return `\n\nYou have already asked this visitor for a phone number or email in this chat. Do not ask
again in this reply. Just answer their question. Only bring it up again if they ask to be called,
to book a visit, or to have details sent to them.`;
  }
  return "";
}

function optionsBlock(options: string[] | undefined): string {
  if (!options || !options.length) return "";
  return `\n\nOur projects are: ${options.join(", ")}. When the visitor hasn't said which one they're
interested in and it would help to know (for example they ask generally about homes, prices,
availability or visits), ask in one short line which project interests them and end your reply
with this exact tag on its own line: ${OPTIONS_MARKER}
The visitor will see the projects as tick boxes, so don't list them yourself. Use the tag at most
once in a conversation unless they ask to see the options again, and never once they've named a
project.`;
}

function visitorBlock(name: string | null | undefined): string {
  if (name && name.trim()) {
    const first = name.trim().split(/\s+/)[0];
    return `The visitor's name is ${name.trim()}. Call them ${first} (their first name), and only now and then, not in every message.`;
  }
  return `You don't know the visitor's name yet, and you need it before you help with anything. If you
haven't already asked, start your reply by warmly asking for their name in one short line, and
don't answer their question yet. If they keep asking without giving a name, kindly explain you just
need their name first. As soon as they tell you their name, thank them and answer whatever they
asked earlier, and end that reply with the lead tag holding just their name (see below), e.g.
${LEAD_MARKER_PREFIX} {"name":"Ama"}]]`;
}

function scopeBlock(businessName: string, context: ChatContext): string {
  const ways = [
    context.contactPhone && `call us on ${context.contactPhone}`,
    context.contactEmail && `email us at ${context.contactEmail}`,
  ].filter(Boolean);
  const contact = ways.length
    ? ways.join(" or ")
    : "contact us using the phone number or email address in your instructions above";
  return `Stay on topic: you only help with ${businessName} and what we offer (our projects, products
and services, buying or booking, visits, pricing requests, and questions about the company itself).
If the visitor asks about anything else, for example general knowledge, other companies, or help
with something unrelated to us, don't answer it. Politely say that's not something you can help
with here, and that for anything else they can ${contact}. Then offer to help with anything about
${businessName}.`;
}

export function buildSystemPrompt(businessName: string, persona: string | null, notesBlock: string, context: ChatContext = {}): string {
  return `You are chatting directly with a visitor on ${businessName}'s own website or messaging channel. You ARE ${businessName}'s assistant — speak as ${businessName} itself, in first person plural ("we", "our", "us"), the way a staff member would. Never describe ${businessName} the way an outside observer or a Wikipedia article would (never say "${businessName} is a..." — say "We're a...").

${persona ?? defaultTone(businessName)}

${visitorBlock(context.visitorName)}${contactBlock(!!context.visitorHasContact, !!context.alreadyAskedForContact)}

${scopeBlock(businessName, context)}${optionsBlock(context.projectOptions)}

Keep every reply very short, like a quick chat message from a real person. Aim for one or two
short sentences and stay under 40 words. Answer only the exact thing asked, never add extra
details, background or selling points they didn't ask for, and don't repeat what they said back
to them. If more detail would genuinely help, give the short answer and offer to share more.
Never use bullet points, numbered lists, or headers. If they ask two things in one message, answer
both. Stay on the project they've already chosen and don't ask them to pick again.

Don't ask for their phone number or email in every reply. Ask at most once, and only when it
naturally helps (they want exact pricing, a call, a visit, or details sent to them). If you've
already asked in this conversation and they didn't give it, just keep answering their questions
without asking again, unless they ask to be contacted.

You have some reference notes below about the business, drawn from its own website/documents. Use them to answer naturally — but never mention "context," "the provided information," "documents," "sources," or that you're an AI retrieving anything. The visitor should never see any of that — you just know this because you work here. If the notes don't cover something, say so plainly and naturally ("I don't have that on hand" / "I'm not sure about that one"), not in a way that references how you're generating the answer.

If the visitor's message is just a greeting or has no real question in it (e.g. "hi", "hello"), respond with a short, warm welcome and invite them to ask something — don't comment on the fact that they didn't ask a specific question.

Do not invent information that isn't in the reference notes.

When you genuinely could not answer the core of the visitor's question from these notes (for
example, real-time pricing, live availability, order status, or anything else they simply don't
cover): do not guess — share anything relevant you do know first, then honestly say you don't
have that specific detail, and ask whether they'd like you to connect them with the sales team
right now. Do not add the token below on this turn. Just ask, and wait for their answer.

Only once the visitor has clearly said yes to that offer — in this message or an earlier one in
this conversation — reply with a short line confirming you're connecting them (e.g. "Great,
connecting you with our team now.") followed by this exact token on its own line, nothing after
it: ${NEEDS_HUMAN_MARKER}
Never send the token by itself with no confirmation line before it, and never send it as a
routine courtesy or before they've agreed. If they say no or don't need that, respect it and keep
helping normally without the token.

Capturing contact details: as soon as the visitor has given you their name AND at least one way to
reach them (a phone/WhatsApp number or an email address) — in this message or earlier in the
conversation — reply normally (thank them and confirm the team will be in touch), then add this
tag at the very end of your reply, on its own line, with only details they actually gave you:
${LEAD_MARKER_PREFIX} {"name":"...","phone":"...","email":"...","interest":"...","unit":"...","location":"...","preferred_time":"..."}]]
Use "interest" for just the name of the project, product or service they want (e.g. "Serenity
Estate", not "3 bedroom villa at Serenity Estate"), "unit" for the specific type or option (e.g. "3
bedroom villa"), "location" for where they are (e.g. a city or "abroad, UK"), and "preferred_time"
for when they'd like to be contacted. Leave out any
field you don't know — never guess or invent a value. The one exception to "name AND a way to reach
them": when the visitor first tells you their name, send the tag with just the name so we can greet
them properly. Send the tag again only when something changes: they ask about a different project, or give a
new or corrected phone number or email. Then send it with all their current details. Never mention the tag, never put anything after it, and never ask for details
just to fill the tag — only when it's natural (they want pricing, a call, a visit, or a follow up).
If more than one tag applies in the same reply, put ${NEEDS_HUMAN_MARKER} last.

<reference-notes>
${notesBlock}
</reference-notes>`;
}

export async function* streamChatResponse(
  businessId: string,
  businessName: string,
  persona: string | null,
  userMessage: string,
  history: ChatMessage[],
  context: ChatContext = {}
): AsyncGenerator<string> {
  const chunks = await retrieveContext(businessId, userMessage, TOP_K);

  const notesBlock = chunks.length
    ? chunks.map((c) => `- (from ${c.sourceUrl ?? c.title}) ${c.content}`).join("\n\n")
    : "No relevant notes found for this question.";

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set — copy .env.example to .env and fill it in.");
  }

  const response = await groqStreamRequest(apiKey, [
    {
      role: "system",
      content: buildSystemPrompt(businessName, persona, notesBlock, {
        ...context,
        alreadyAskedForContact: botAlreadyAskedForContact(history),
      }),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ]);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore malformed/keep-alive lines
      }
    }
  }
}
