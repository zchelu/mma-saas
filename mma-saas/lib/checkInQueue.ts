// Client-side offline queue for kiosk check-ins. Standalone and
// dependency-injected on purpose: there is no Convex query yet that resolves
// a scanned checkInToken to a member (only the write side — issuance/reset —
// exists in convex/members.ts), so this module never talks to Convex
// directly. The real adapter (a CheckInCaller) gets built once that
// resolution query lands, and translates its outcome into ok/terminal/
// transient — this module only needs to know that three-way result.

export interface QueuedCheckIn {
  idempotencyKey: string;
  token: string;
  clientScannedAt: number;
  gymId: string;
}

export type CheckInResult =
  | { outcome: "ok" }
  // e.g. token not found/reset while offline — drop from the queue, surface
  // to front desk. Retrying it would never succeed.
  | { outcome: "terminal"; message: string }
  // e.g. rate-limit trip or dropped connection — leave queued, retry on the
  // next reconnect.
  | { outcome: "transient"; message: string };

export type CheckInCaller = (item: QueuedCheckIn) => Promise<CheckInResult>;

// Matches the subset of window.localStorage this module uses.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Matches the subset of ConvexReactClient this module uses.
export interface ConnectionStateSource {
  connectionState(): { isWebSocketConnected: boolean };
  subscribeToConnectionState(cb: (state: { isWebSocketConnected: boolean }) => void): () => void;
}

export interface CheckInQueueOptions {
  storage?: StorageLike;
  storageKey?: string;
  replayDelayMs?: number;
  now?: () => number;
  generateId?: () => string;
  onTerminalFailure?: (item: QueuedCheckIn, message: string) => void;
}

const DEFAULT_STORAGE_KEY = "kombatdesk.checkInQueue";
const DEFAULT_REPLAY_DELAY_MS = 400;

function resolveStorage(options?: CheckInQueueOptions): StorageLike {
  if (options?.storage) return options.storage;
  if (typeof window !== "undefined") return window.localStorage;
  throw new Error("checkInQueue: no storage available — pass options.storage explicitly");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCheckInQueue(caller: CheckInCaller, options?: CheckInQueueOptions) {
  const storage = resolveStorage(options);
  const storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
  const replayDelayMs = options?.replayDelayMs ?? DEFAULT_REPLAY_DELAY_MS;
  const now = options?.now ?? Date.now;
  const generateId = options?.generateId ?? (() => crypto.randomUUID());
  const onTerminalFailure = options?.onTerminalFailure;

  let draining = false;

  function readQueue(): QueuedCheckIn[] {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt data can't be recovered — treat as empty. The next write
      // (e.g. the next enqueue) overwrites the corrupt string.
      return [];
    }
  }

  function writeQueue(queue: QueuedCheckIn[]): void {
    storage.setItem(storageKey, JSON.stringify(queue));
  }

  function enqueue(token: string, gymId: string): QueuedCheckIn {
    const item: QueuedCheckIn = {
      idempotencyKey: generateId(),
      token,
      clientScannedAt: now(),
      gymId,
    };
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
    return item;
  }

  function getQueue(): QueuedCheckIn[] {
    return readQueue();
  }

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const queue = readQueue();
        if (queue.length === 0) break;
        const item = queue[0];

        const result = await caller(item);

        if (result.outcome === "transient") break;

        writeQueue(queue.slice(1));
        if (result.outcome === "terminal") {
          onTerminalFailure?.(item, result.message);
        }

        if (readQueue().length > 0) await delay(replayDelayMs);
      }
    } finally {
      // Runs on every exit path — including an unexpected throw from caller()
      // or JSON parsing — so a single bad iteration can't wedge the queue in
      // a permanently-draining state until page reload.
      draining = false;
    }
  }

  function attachConnectionListener(source: ConnectionStateSource): () => void {
    let wasConnected = source.connectionState().isWebSocketConnected;
    return source.subscribeToConnectionState((state) => {
      if (state.isWebSocketConnected && !wasConnected) {
        void drainQueue();
      }
      wasConnected = state.isWebSocketConnected;
    });
  }

  return { enqueue, getQueue, drainQueue, attachConnectionListener };
}
