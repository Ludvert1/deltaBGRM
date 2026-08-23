/**
 * Tiny pluggable key/value store.
 *
 * - No config          → in-memory (works immediately; resets when the Vercel
 *                        lambda is recycled, so the learned baseline restarts).
 * - Upstash / Vercel KV → durable across invocations. Set either
 *                        KV_REST_API_URL + KV_REST_API_TOKEN, or
 *                        UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 *
 * Nothing else in the codebase knows which driver is active.
 */

export type StoreDriver = "memory" | "upstash";

interface Driver {
  name: StoreDriver;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  listPush<T>(key: string, value: T, cap: number): Promise<void>;
  listRange<T>(key: string, start: number, stop: number): Promise<T[]>;
  keys(prefix: string): Promise<string[]>;
}

/* ————————————————————————— memory ————————————————————————— */

const mem = new Map<string, unknown>();
const memLists = new Map<string, unknown[]>();

const memoryDriver: Driver = {
  name: "memory",
  async get<T>(key: string) {
    return (mem.get(key) as T) ?? null;
  },
  async set<T>(key: string, value: T) {
    mem.set(key, value);
  },
  async listPush<T>(key: string, value: T, cap: number) {
    const arr = (memLists.get(key) as T[]) ?? [];
    arr.push(value);
    while (arr.length > cap) arr.shift();
    memLists.set(key, arr);
  },
  async listRange<T>(key: string, start: number, stop: number) {
    const arr = (memLists.get(key) as T[]) ?? [];
    const end = stop < 0 ? arr.length + stop + 1 : stop + 1;
    return arr.slice(Math.max(0, start < 0 ? arr.length + start : start), end);
  },
  async keys(prefix: string) {
    return [...mem.keys(), ...memLists.keys()].filter((k) => k.startsWith(prefix));
  },
};

/* ———————————————————————— upstash ———————————————————————— */

function upstashConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function upstashCmd(cmd: (string | number)[]): Promise<unknown> {
  const cfg = upstashConfig();
  if (!cfg) throw new Error("upstash not configured");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstash ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`upstash: ${json.error}`);
  return json.result;
}

const upstashDriver: Driver = {
  name: "upstash",
  async get<T>(key: string) {
    const raw = (await upstashCmd(["GET", key])) as string | null;
    return raw ? (JSON.parse(raw) as T) : null;
  },
  async set<T>(key: string, value: T) {
    await upstashCmd(["SET", key, JSON.stringify(value)]);
  },
  async listPush<T>(key: string, value: T, cap: number) {
    await upstashCmd(["RPUSH", key, JSON.stringify(value)]);
    await upstashCmd(["LTRIM", key, -cap, -1]);
  },
  async listRange<T>(key: string, start: number, stop: number) {
    const raw = (await upstashCmd(["LRANGE", key, start, stop])) as string[] | null;
    return (raw ?? []).map((s) => JSON.parse(s) as T);
  },
  async keys(prefix: string) {
    const raw = (await upstashCmd(["KEYS", `${prefix}*`])) as string[] | null;
    return raw ?? [];
  },
};

/* ———————————————————————— facade ———————————————————————— */

function driver(): Driver {
  return upstashConfig() ? upstashDriver : memoryDriver;
}

export function storeDriverName(): StoreDriver {
  return driver().name;
}

export function storeIsDurable(): boolean {
  return driver().name !== "memory";
}

/** Every call falls back to memory rather than throwing — the feed must not 500. */
async function safe<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback();
  }
}

export const store = {
  get: <T>(key: string) => safe(() => driver().get<T>(key), () => memoryDriver.get<T>(key)),
  set: <T>(key: string, value: T) =>
    safe(() => driver().set(key, value), () => memoryDriver.set(key, value)),
  listPush: <T>(key: string, value: T, cap: number) =>
    safe(() => driver().listPush(key, value, cap), () => memoryDriver.listPush(key, value, cap)),
  listRange: <T>(key: string, start: number, stop: number) =>
    safe(() => driver().listRange<T>(key, start, stop), () => memoryDriver.listRange<T>(key, start, stop)),
  keys: (prefix: string) => safe(() => driver().keys(prefix), () => memoryDriver.keys(prefix)),
};

export const KEYS = {
  baseline: "aus:baseline",
  snapshots: "aus:snapshots",
  opsDay: (date: string) => `aus:ops:${date}`,
  report: (date: string) => `aus:report:${date}`,
  reportIndex: "aus:report:index",
  lastPoll: "aus:lastpoll",
};
