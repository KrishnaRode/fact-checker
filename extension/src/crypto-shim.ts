/**
 * Browser stand-in for node:crypto's createHash, used only for content-identity hashing
 * (duplicate detection) inside the extension. Two independent 32-bit FNV-1a lanes → 16 hex
 * chars per digest block; not a security primitive.
 */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// The algorithm name is accepted for API compatibility with node:crypto and ignored.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createHash(_alg: string) {
  let data = "";
  const api = {
    update(s: string) {
      data += s;
      return api;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    digest(_enc: string) {
      return [2166136261, 33554467, 16777619, 3735928559, 2654435761, 1597334677, 2246822519, 3266489917].map((s) => fnv(data, s)).join("");
    },
  };
  return api;
}
