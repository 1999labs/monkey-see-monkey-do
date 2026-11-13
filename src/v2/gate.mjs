import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPool,buildPool,prompts,verify,systemById,solve,scoreSee,scoreDo,solverSource,SYSTEMS } from './suite.mjs';
import { familyById } from './families.mjs';
import { equal } from './util.mjs';
export async function gate({full=false}={}) {
 const pool=loadPool(),pins=JSON.parse(readFileSync(new URL('./prompt-digests.json',import.meta.url),'utf8'));let checks=0;
 const check=(condition,message)=>{assert.ok(condition,message);checks++;};
 check(pool.see.length===12&&pool.chains.length===60,'pool coverage');
 for(const t of pool.see) {
  const family=familyById[t.family],truth=family.candidates[t.target].fn;
  const shown=t.shown.map(x=>JSON.stringify(x.input)),held=t.heldOut.map(x=>JSON.stringify(x));
  check(new Set(shown).size===16&&new Set(held).size===50,'unique examples');
  check(held.every(x=>!shown.includes(x)),`shown/held-out overlap: ${t.id}`);
  check(t.shown.every(x=>equal(truth(x.input),x.output)),`shown truth: ${t.id}`);
  for(const l of [16]) check(family.candidates.filter(c=>t.shown.slice(0,l).every(x=>equal(c.fn(x.input),x.output))).length===1,`identifiability: ${t.id}/${l}`);
  check(family.candidates.filter(c=>t.shown.slice(0,8).every(x=>equal(c.fn(x.input),x.output))).length>1,`informative transition: ${t.id}`);
  check(family.candidates.every((c,i)=>i===t.target||t.heldOut.some(x=>!equal(c.fn(x),truth(x)))),`held-out discrimination: ${t.id}`);
  const scored=scoreSee(t,4,`const f=${family.candidates[t.target].source};`);
  check(scored.correct===50&&scored.threw===0,`reference SEE: ${t.id}`);
 }
 for(const p of prompts(pool)) check(p.sha256===pins[p.id],`prompt digest: ${p.id}`);
 check(Object.keys(pins).length===prompts(pool).length,'no stale prompt pins');
 for(const c of pool.chains) {
  const s=systemById[c.system];
  check(verify(s,c.start,c.target,c.steps).solved,`recorded path: ${c.id}`);
  const independentlySolved=solve(c.start,c.target,s.rules);
  check(independentlySolved.length===c.length&&verify(s,c.start,c.target,independentlySolved).solved,`independent shortest path: ${c.id}`);
 }
 for(const s of SYSTEMS) {
  const chains=pool.chains.filter(c=>c.system===s.id);
  check(scoreDo(s,chains,solverSource(s)).every(c=>c.solved),`sandbox reference: ${s.id}`);
  check(scoreDo(s,chains,'function solve(){return [null];}').every(c=>!c.solved&&c.invalid),'malformed output');
  check(scoreDo(s,chains,'function solve(){return [];}').every(c=>!c.solved),'empty output');
 }
 if(full) check(JSON.stringify(buildPool())===JSON.stringify(pool),'byte-identical pool regeneration');
 return {ok:true,checks};
}
