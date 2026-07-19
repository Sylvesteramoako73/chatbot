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

export function publishToBusiness(businessId: string, event: DashboardEvent): void {
  emitter.emit(`biz:${businessId}`, event);
}

export function subscribeToBusiness(businessId: string, onEvent: (event: DashboardEvent) => void): () => void {
  const key = `biz:${businessId}`;
  emitter.on(key, onEvent);
  return () => emitter.off(key, onEvent);
}
