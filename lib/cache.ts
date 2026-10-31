import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serverConfig } from "@/lib/config";
import { sha256 } from "@/lib/text";

/**
 * Bounded local JSON store. One file per entry under <dataDir>/cache/<bucket>/, written
 * atomically (temp file + rename). Reads never extend an entry's expiry. Pruning keeps the
 * newest N entries per bucket. Location and retention are documented in README.md.
 */
export type Bucket = "runs" | "documents" | "feeds";

type Envelope<T> = { storedAt: number; expiresAt: number; value: T };

function bucketDir(bucket: Bucket): string {
  return path.join(serverConfig.dataDir, "cache", bucket);
}

function fileFor(bucket: Bucket, key: string): string {
  return path.join(bucketDir(bucket), `${sha256(key).slice(0, 40)}.json`);
}

export async function cacheGet<T>(bucket: Bucket, key: string, opts: { allowStale?: boolean } = {}): Promise<{ value: T; storedAt: number; expiresAt: number; stale: boolean } | null> {
  try {
    const raw = await fs.readFile(fileFor(bucket, key), "utf8");
    const env = JSON.parse(raw) as Envelope<T>;
    const stale = Date.now() > env.expiresAt;
    if (stale && !opts.allowStale) return null;
    return { value: env.value, storedAt: env.storedAt, expiresAt: env.expiresAt, stale };
  } catch {
    return null;
  }
}

const writeCounts = new Map<Bucket, number>();

export async function cacheSet<T>(bucket: Bucket, key: string, value: T, ttlMs: number, maxEntries: number): Promise<void> {
  const dir = bucketDir(bucket);
  await fs.mkdir(dir, { recursive: true });
  const target = fileFor(bucket, key);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const env: Envelope<T> = { storedAt: Date.now(), expiresAt: Date.now() + ttlMs, value };
  await fs.writeFile(tmp, JSON.stringify(env), "utf8");
  await fs.rename(tmp, target);
  const n = (writeCounts.get(bucket) ?? 0) + 1;
  writeCounts.set(bucket, n);
  if (n % 10 === 1) await prune(bucket, maxEntries).catch(() => undefined);
}

export async function prune(bucket: Bucket, maxEntries: number): Promise<void> {
  const dir = bucketDir(bucket);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  if (names.length <= maxEntries) return;
  const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  stats.sort((a, b) => b.t - a.t);
  await Promise.all(stats.slice(maxEntries).map((s) => fs.rm(path.join(dir, s.n), { force: true })));
}

export async function cacheStats(): Promise<{ dataDir: string; buckets: Record<Bucket, { entries: number; bytes: number }> }> {
  const out = {} as Record<Bucket, { entries: number; bytes: number }>;
  for (const b of ["runs", "documents", "feeds"] as Bucket[]) {
    const dir = bucketDir(b);
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    let bytes = 0;
    for (const n of names) bytes += (await fs.stat(path.join(dir, n)).catch(() => null))?.size ?? 0;
    out[b] = { entries: names.length, bytes };
  }
  return { dataDir: serverConfig.dataDir, buckets: out };
}

/** Delete all locally stored evidence and assessments. */
export async function resetCache(): Promise<void> {
  await fs.rm(path.join(serverConfig.dataDir, "cache"), { recursive: true, force: true });
}
