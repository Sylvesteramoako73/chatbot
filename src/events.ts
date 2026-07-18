import { EventEmitter } from "events";

// Single-process pub/sub keyed by session id, used to push WhatsApp owner
// replies to a visitor's open SSE connection. If this server ever runs as
// more than one instance, this needs to move to a shared bus (e.g. Redis
// pub/sub) — a webhook reply landing on instance A wouldn't reach a visitor
// whose SSE connection is on instance B.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export interface OwnerReplyEvent {
  sessionId: string;
  content: string;
}

export function publishOwnerReply(event: OwnerReplyEvent): void {
  emitter.emit(event.sessionId, event.content);
}

export function subscribeToSession(sessionId: string, onMessage: (content: string) => void): () => void {
  emitter.on(sessionId, onMessage);
  return () => emitter.off(sessionId, onMessage);
}
