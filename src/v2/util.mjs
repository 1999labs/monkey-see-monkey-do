import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const equal = isDeepStrictEqual;
export const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export const rngFor = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const shuffle = (xs, rng) => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
export const unique = (xs) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
