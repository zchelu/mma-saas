import { describe, it, expect, vi } from "vitest";
import { createCheckInQueue, type CheckInCaller, type CheckInResult, type StorageLike } from "./checkInQueue";

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function idGen(prefix = "id") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("createCheckInQueue", () => {
  it("enqueue captures idempotencyKey and clientScannedAt at call time and persists immediately", () => {
    const storage = createMemoryStorage();
    const caller = vi.fn();
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), now: () => 1000 });

    const item = queue.enqueue("tok-abc", "gym-1");

    expect(item).toEqual({
      idempotencyKey: "id-1",
      token: "tok-abc",
      clientScannedAt: 1000,
      gymId: "gym-1",
    });
    expect(queue.getQueue()).toEqual([item]);
  });

  it("drainQueue removes items on ok outcome, in FIFO order", async () => {
    const storage = createMemoryStorage();
    const calls: string[] = [];
    const caller: CheckInCaller = async (item) => {
      calls.push(item.idempotencyKey);
      return { outcome: "ok" };
    };
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 0 });
    queue.enqueue("tok-1", "gym-1");
    queue.enqueue("tok-2", "gym-1");

    await queue.drainQueue();

    expect(calls).toEqual(["id-1", "id-2"]);
    expect(queue.getQueue()).toEqual([]);
  });

  it("drops a terminal-failure item, notifies onTerminalFailure, and continues to the next item", async () => {
    const storage = createMemoryStorage();
    const onTerminalFailure = vi.fn();
    let call = 0;
    const caller: CheckInCaller = async () => {
      call++;
      if (call === 1) return { outcome: "terminal", message: "Member not found" };
      return { outcome: "ok" };
    };
    const queue = createCheckInQueue(caller, {
      storage,
      generateId: idGen(),
      replayDelayMs: 0,
      onTerminalFailure,
    });
    queue.enqueue("bad-token", "gym-1");
    queue.enqueue("tok-2", "gym-1");

    await queue.drainQueue();

    expect(call).toBe(2);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure.mock.calls[0][1]).toBe("Member not found");
    expect(queue.getQueue()).toEqual([]);
  });

  it("stops draining on a transient failure and leaves it plus later items queued", async () => {
    const storage = createMemoryStorage();
    let call = 0;
    const caller: CheckInCaller = async () => {
      call++;
      if (call === 2) return { outcome: "transient", message: "rate limited" };
      return { outcome: "ok" };
    };
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 0 });
    queue.enqueue("tok-1", "gym-1");
    queue.enqueue("tok-2", "gym-1");
    queue.enqueue("tok-3", "gym-1");

    await queue.drainQueue();

    expect(call).toBe(2); // never even attempted item 3
    expect(queue.getQueue().map((i) => i.token)).toEqual(["tok-2", "tok-3"]);
  });

  it("paces replay with replayDelayMs between items instead of firing concurrently", async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const timestamps: number[] = [];
      const caller: CheckInCaller = async () => {
        timestamps.push(Date.now());
        return { outcome: "ok" };
      };
      const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 500 });
      queue.enqueue("tok-1", "gym-1");
      queue.enqueue("tok-2", "gym-1");

      const drainPromise = queue.drainQueue();
      await vi.advanceTimersByTimeAsync(0);
      expect(timestamps.length).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      await drainPromise;
      expect(timestamps.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is re-entrant safe: an overlapping drainQueue() call while one is in flight is a no-op", async () => {
    const storage = createMemoryStorage();
    let concurrent = 0;
    let maxConcurrent = 0;
    const caller: CheckInCaller = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return { outcome: "ok" };
    };
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 0 });
    queue.enqueue("tok-1", "gym-1");
    queue.enqueue("tok-2", "gym-1");

    await Promise.all([queue.drainQueue(), queue.drainQueue()]);

    expect(maxConcurrent).toBe(1);
    expect(queue.getQueue()).toEqual([]);
  });

  it("releases the re-entrancy guard even when caller throws unexpectedly, so a later drainQueue() isn't wedged", async () => {
    const storage = createMemoryStorage();
    let call = 0;
    const caller: CheckInCaller = async () => {
      call++;
      if (call === 1) throw new Error("boom");
      return { outcome: "ok" };
    };
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 0 });
    queue.enqueue("tok-1", "gym-1");

    await expect(queue.drainQueue()).rejects.toThrow("boom");
    expect(queue.getQueue()).toHaveLength(1); // item never resolved ok/terminal, still queued

    await queue.drainQueue(); // would silently no-op if the guard were stuck true
    expect(call).toBe(2);
    expect(queue.getQueue()).toEqual([]);
  });

  it("attachConnectionListener drains only on a false→true transition, not on every state change", () => {
    const storage = createMemoryStorage();
    const caller = vi.fn(async (): Promise<CheckInResult> => ({ outcome: "ok" }));
    const queue = createCheckInQueue(caller, { storage, generateId: idGen(), replayDelayMs: 0 });
    queue.enqueue("tok-1", "gym-1");

    let subscriber: ((state: { isWebSocketConnected: boolean }) => void) | undefined;
    const source = {
      connectionState: () => ({ isWebSocketConnected: true }),
      subscribeToConnectionState: (cb: (state: { isWebSocketConnected: boolean }) => void) => {
        subscriber = cb;
        return () => {
          subscriber = undefined;
        };
      },
    };

    queue.attachConnectionListener(source);

    // Already connected at attach time — an unrelated "still connected"
    // update must not trigger a drain.
    subscriber?.({ isWebSocketConnected: true });
    expect(caller).not.toHaveBeenCalled();

    // Disconnect, then reconnect — only the reconnect edge should drain.
    subscriber?.({ isWebSocketConnected: false });
    expect(caller).not.toHaveBeenCalled();

    subscriber?.({ isWebSocketConnected: true });
    expect(caller).toHaveBeenCalledTimes(1);
  });
});
