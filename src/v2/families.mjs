// Finite, declared hypothesis classes. Identifiability is checked against ALL
// candidates in each class, not against a single deliberately weak baseline.
// Sources are used for offline reference runs; prompts never receive a source
// or the index of the selected candidate.
const candidate = (source) => ({ source, fn: Function(`return (${source});`)() });
const numbers = Array.from({ length: 241 }, (_, i) => i - 120);
const strings = ["", "a", "B", "ae", "xyz", ...Array.from({ length: 240 }, (_, i) => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return letters[i % 26] + letters[Math.floor(i / 26)] + "m" + letters[(i * 7 + 5) % 26];
})];
const arrays = (rng) => {
  const out = [[], [0], [1, 1], [-1, 0], [2, 2, 1], [0, 0, 0]];
  for (let i = 0; i < 600; i++) {
    const n = 1 + Math.floor(rng() * 8);
    out.push(Array.from({ length: n }, () => Math.floor(rng() * 31) - 15));
  }
  return out;
};

export const FAMILIES = [
  {
    id: "threshold", inputType: "integer",
    hypothesis: "f(n) is n*n for n <= t, and n*n-c otherwise. t is one of -3, 0, 3; c is one of 7, 11.",
    candidates: [-3, 0, 3].flatMap((t) => [7, 11].map((c) => candidate(`n => n <= ${t} ? n*n : n*n-${c}`))),
    naive: candidate("n => n*n"), domain: () => numbers,
  },
  {
    id: "modular", inputType: "integer",
    hypothesis: "f(n) is n+b when n is divisible by d, and n-b otherwise. d is one of 2, 3, 4; b is one of 1, 3.",
    candidates: [2, 3, 4].flatMap((d) => [1, 3].map((b) => candidate(`n => n % ${d} === 0 ? n+${b} : n-${b}`))),
    naive: candidate("n => n+1"), domain: () => numbers,
  },
  {
    id: "conditional-string", inputType: "string",
    hypothesis: "If the first character (case insensitive) is in a selected group, transform the string; otherwise return it unchanged. The group is one of aeiou, abc, xyz. The transform either uppercases the first character or reverses the entire string. Empty strings are unchanged.",
    candidates: ["aeiou", "abc", "xyz"].flatMap((g) => [false, true].map((reverse) => candidate(`s => s.length && ${JSON.stringify(g)}.includes(s[0].toLowerCase()) ? ${reverse ? '[...s].reverse().join("")' : 's[0].toUpperCase()+s.slice(1)'} : s`))),
    naive: candidate('s => s.length ? s[0].toUpperCase()+s.slice(1) : s'), domain: () => strings,
  },
  {
    id: "rotation", inputType: "string",
    hypothesis: "Rotate the string cyclically by k positions, either left or right. k is one of 1, 2, 3. Reduce k modulo string length; empty strings are unchanged.",
    candidates: [1, 2, 3].flatMap((k) => [false, true].map((right) => candidate(`s => { if (!s.length) return s; const k=${k}%s.length; return ${right ? 'k ? s.slice(-k)+s.slice(0,-k) : s' : 's.slice(k)+s.slice(0,k)'}; }`))),
    naive: candidate('s => s.slice(1)+s.slice(0,1)'), domain: () => strings,
  },
  {
    id: "distinct-rank", inputType: "array of integers",
    hypothesis: "Return the kth distinct value in ascending or descending order. k is one of 1, 2, 3. Return null if fewer than k distinct values exist.",
    candidates: [1, 2, 3].flatMap((k) => [1, -1].map((dir) => candidate(`a => { const d=[...new Set(a)].sort((x,y)=>${dir}*(x-y)); return d.length < ${k} ? null : d[${k - 1}]; }`))),
    naive: candidate('a => a.length < 2 ? null : [...a].sort((x,y)=>y-x)[1]'), domain: arrays,
  },
  {
    id: "filter-order", inputType: "array of integers",
    hypothesis: "Keep only values divisible by d, preserving duplicates. d is one of 2, 3, 4. Return them either in their original order or sorted numerically ascending.",
    candidates: [2, 3, 4].flatMap((d) => [false, true].map((sort) => candidate(`a => a.filter(x=>x%${d}===0)${sort ? '.sort((x,y)=>x-y)' : ''}`))),
    naive: candidate('a => a.filter(x=>x%2===0)'), domain: arrays,
  },
];

export const familyById = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));
