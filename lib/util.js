// IDs and hashing that work the same in browsers (incl. non-secure LAN http) and Node.

export function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * p) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Deterministic id: re-importing the same document yields the same ids.
export const stableId = (prefix, ...parts) => `${prefix}_${fnv1a64(parts.join('␟')).slice(0, 12)}`;

export function randomId(prefix) {
  const b = new Uint8Array(9);
  globalThis.crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export const nowUtc = () => new Date().toISOString();
