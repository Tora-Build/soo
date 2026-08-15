// Evidence hashing for the simulation portfolio.
//
// Nothing on Solana consumes this hash — the evidence record exists only in
// the simulation portfolio's display — and the demo ships no real keccak. So
// this is a deterministic content TAG, not a cryptographic commitment, and
// anything that starts verifying it must bring a real hash first.
export function canonicalEvidence(rawValue: string): string {
  return JSON.stringify({ value: rawValue });
}

export function computeOptionDataHash(rawValue: string): `0x${string}` {
  // FNV-1a folded over four lanes to fill 32 bytes. Stable, collision-weak,
  // and labeled as such.
  const text = canonicalEvidence(rawValue);
  const lanes = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0xcafebabe].map(
    (seed) => {
      let h = seed >>> 0;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h;
    },
  );
  const hex = lanes
    .map((lane) => lane.toString(16).padStart(8, "0"))
    .join("")
    .repeat(2);
  return `0x${hex.slice(0, 64)}` as `0x${string}`;
}
