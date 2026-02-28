import { EventEmitter } from "node:events";

interface ObservationCreatedPayload {
	sessionId: string;
	uncompressedCount: number;
}

type EventMap = {
	"observation:created": [payload: ObservationCreatedPayload];
	"session:ended": [sessionId: string];
};

class TypedEmitter extends EventEmitter {
	emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean {
		return super.emit(event, ...args);
	}

	on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}
}

export const bus = new TypedEmitter();
