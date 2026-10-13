import { EventEmitter } from 'node:events';

/**
 * Things happening right now, for the screens that are open: the console's support widget and the website chat.
 * One server, so an in-process emitter is enough. Listeners must never throw.
 *
 *   chat     a live chat changed: { threadId, type: 'message' | 'thread' | 'typing' | 'seen' | 'viewers', ... }
 *   support  a WhatsApp support message came in: { requestId, phone, name, text }
 */
export type ChatEvent =
  | { threadId: number; type: 'message'; message: Record<string, unknown> }
  | { threadId: number; type: 'thread' }
  | { threadId: number; type: 'typing'; who: 'visitor' | 'staff'; name?: string; staffId?: string }
  | { threadId: number; type: 'seen'; by: 'visitor' | 'staff'; upTo: number }
  | { threadId: number; type: 'viewers'; viewers: { id: string; name: string }[] };

export interface SupportEvent { requestId: number; phone: string; name: string | null; text: string }

class Bus extends EventEmitter {
  chat(e: ChatEvent) { this.emit('chat', e); }
  support(e: SupportEvent) { this.emit('support', e); }
}

export const bus = new Bus();
bus.setMaxListeners(500);
