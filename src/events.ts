import { EventEmitter } from "events";

// Single-process pub/sub for two audiences:
//   - a widget visitor's open SSE connection (keyed by conversation id)
//   - a business's dashboard, watching the whole inbox live (keyed by business id)
// If this server ever runs as more than one instance, this needs to move to a
// shared bus (e.g. Redis pub/sub) — an event published on instance A wouldn't
// reach a listener whose SSE connection is on instance B.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export interface DashboardEvent {
  type: "new_message" | "new_conversation" | "claimed" | "closed" | "mode_changed";
  conversationId: string;
  [key: string]: unknown;
}

export interface ConversationEvent {
  // "handoff" tells the widget to switch itself into handoff mode (e.g. the bot just escalated
  // automatically) in addition to displaying the message; "message" is just a message to show.
  type: "message" | "handoff";
  role: "agent" | "bot" | "system";
  content: string;
}

export function publishToConversation(conversationId: string, event: ConversationEvent): void {
  emitter.emit(`conv:${conversationId}`, event);
}

export function subscribeToConversation(
  conversationId: string,
  onEvent: (event: ConversationEvent) => void
): () => void {
  const key = `conv:${conversationId}`;
  emitter.on(key, onEvent);
  return () => emitter.off(key, onEvent);
}

// A widget opens its live stream on page load, before the visitor has said anything. Instead of
// creating an empty conversation just to have something to listen on, the stream waits here and is
// told the conversation id once the visitor's first message (or name) actually creates it.
export function announceWidgetConversation(businessId: string, sessionId: string, conversationId: string): void {
  emitter.emit(`widget-new:${businessId}:${sessionId}`, conversationId);
}

export function onWidgetConversationCreated(
  businessId: string,
  sessionId: string,
  onCreated: (conversationId: string) => void
): () => void {
  const key = `widget-new:${businessId}:${sessionId}`;
  emitter.on(key, onCreated);
  return () => emitter.off(key, onCreated);
}

export function publishToBusiness(businessId: string, event: DashboardEvent): void {
  emitter.emit(`biz:${businessId}`, event);
}

export function subscribeToBusiness(businessId: string, onEvent: (event: DashboardEvent) => void): () => void {
  const key = `biz:${businessId}`;
  emitter.on(key, onEvent);
  return () => emitter.off(key, onEvent);
}
