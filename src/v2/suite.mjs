import { readFileSync } from 'node:fs';
import { FAMILIES, familyById } from './families.mjs';
import { hash, equal, mean, rngFor, shuffle, unique } from './util.mjs';
import { SUITE_VERSION, GENERATOR_VERSION, DATA_SEED, LEVELS, SCORED_LEVELS, BANDS } from './version.mjs';
import { compileCandidate, runCandidate } from '../sandbox.mjs';
import { complete } from '../adapters/registry.mjs';
import { describeCallFailure } from '../call-failure.mjs';
export { SUITE_VERSION, LEVELS, SCORED_LEVELS };
export const SYSTEMS = [
 {id:'growth', rules:[['A','xB'],['B','yA'],['A','zA'],['B','wB']]},
 {id:'swaps', rules:[['AB','BA'],['BA','AB'],['CD','DC'],['DC','CD']]},
 {id:'reduction', rules:[['AA','A'],['BB','B'],['AB','C'],['AC','C'],['CB','C']]},
].map(s=>({...s,rules:s.rules.map(([from,to],i)=>({id:`R${i+1}`,from,to}))}));
export const systemById=Object.fromEntries(SYSTEMS.map(s=>[s.id,s]));
export function moves(state,rules) {
 const out=[];
 for(const r of rules) for(let pos=state.indexOf(r.from);pos!==-1;pos=state.indexOf(r.from,pos+1))
  out.push({rule:r.id,start:pos,next:state.slice(0,pos)+r.to+state.slice(pos+r.from.length)});
 return out;
}
// Bidirectional breadth-first search, expanding the smaller frontier. No pool
// answers are passed to this solver, including in the offline dry-run.
export function solve(start,target,rules) {
 const left=new Map([[start,null]]),right=new Map([[target,null]]);
 let lf=[start],rf=[target];
 const reverse=rules.map(r=>({...r,from:r.to,to:r.from}));
 let meet=start===target?start:null;
 while(meet===null && lf.length && rf.length && left.size+right.size<100000) {
  const forward=lf.length<=rf.length, own=forward?left:right, other=forward?right:left;
  const next=[];
  for(const state of forward?lf:rf) {
   for(const m of moves(state,forward?rules:reverse)) {
    if(m.next.length>128 || own.has(m.next)) continue;
    own.set(m.next,{parent:state,move:forward?m:{rule:m.rule,start:m.start,next:state}});
    if(other.has(m.next)){meet=m.next;break;}
    next.push(m.next);
   }
   if(meet!==null) break;
  }
  if(forward) lf=next; else rf=next;
 }
 if(meet===null) return [];
 const before=[],after=[];
 for(let s=meet;left.get(s);s=left.get(s).parent) before.push(left.get(s).move);
 for(let s=meet;right.get(s);s=right.get(s).parent) after.push(right.get(s).move);
 return before.reverse().concat(after);
}
export const solverSource=s=>`${moves.toString()}\n${solve.toString().replace('function solve(', 'function search(')}\nfunction solve(start,target){return search(start,target,${JSON.stringify(s.rules)});}`;
export function verify(system,start,target,steps) {
 let state=start,legal=0;
 if(!Array.isArray(steps)||steps.length>1000) return {solved:false,legal,invalid:true};
 for(const step of steps) {
  if(!step||typeof step!=='object'||!Number.isInteger(step.start)||typeof step.next!=='string') return {solved:false,legal,invalid:true};
  const r=system.rules.find(r=>r.id===step.rule);
  if(!r||step.start<0||state.slice(step.start,step.start+r.from.length)!==r.from) return {solved:false,legal,invalid:true};
  const next=state.slice(0,step.start)+r.to+state.slice(step.start+r.from.length);
  if(next!==step.next||next.length>128) return {solved:false,legal,invalid:true};
  state=next;legal++;
 }
 return {solved:state===target,legal,invalid:false};
}
export function buildPool(seed=DATA_SEED) {
 const rng=rngFor(seed),see=[],chains=[];
 for(const family of FAMILIES) {
  const targets=shuffle(family.candidates.map((_,i)=>i),rng).slice(0,2);
  for(const [instance,target] of targets.entries()) {
   const domain=shuffle(unique(family.domain(rng)),rng), truth=family.candidates[target].fn;
   // Reserve independent held-out witnesses against every incorrect rule.
   // This prevents the shown set from consuming all boundary/length evidence.
   const witnesses=[];
   let untested=family.candidates.filter((_,i)=>i!==target);
   while(untested.length) {
    const ranked=[...domain].sort((a,b)=>untested.filter(c=>!equal(c.fn(b),truth(b))).length-untested.filter(c=>!equal(c.fn(a),truth(a))).length);
    const input=ranked[0];
    if(!untested.some(c=>!equal(c.fn(input),truth(input)))) throw Error(`No held-out witness: ${family.id}`);
    witnesses.push(input);untested=untested.filter(c=>equal(c.fn(input),truth(input)));
   }
   const available=domain.filter(x=>!witnesses.some(w=>equal(w,x)));
   // Keep a plausible alternative through eight examples. Choose evidence
   // within that shared region that eliminates other alternatives first.
   const rivals=family.candidates.filter((_,i)=>i!==target).map(c=>({c,shared:available.filter(x=>equal(c.fn(x),truth(x)))})).filter(x=>x.shared.length>=8);
   if(!rivals.length) throw Error(`No ambiguous prefix: ${family.id}`);
   const rival=shuffle(rivals,rng)[0];
   const shown=[];let remaining=[...family.candidates];
   for(let i=0;i<16;i++) {
    const choices=(i<8?rival.shared:available).filter(x=>!shown.some(s=>equal(s.input,x)));
    choices.sort((a,b)=>remaining.filter(c=>equal(c.fn(a),truth(a))).length-remaining.filter(c=>equal(c.fn(b),truth(b))).length);
    const input=choices[0],output=truth(input);
    shown.push({input,output});remaining=remaining.filter(c=>equal(c.fn(input),output));
   }
   if(remaining.length!==1) throw Error(`Unidentified rule: ${family.id}`);
   const rest=domain.filter(x=>!shown.some(s=>equal(s.input,x))&&!witnesses.some(w=>equal(w,x)));
   const heldOut=[...witnesses,...rest].slice(0,50);
   see.push({id:`${family.id}-${instance+1}`,family:family.id,target,shown,heldOut});
  }
 }
 for(const system of SYSTEMS) for(const length of BANDS) for(let i=0;i<4;i++) {
  let start,target;
  if(system.id==='growth') {
   start=i%2?'B':'A';target=start;
   // Different fixed prefixes create independent instances without changing rules.
   start='q'.repeat(Math.floor(i/2))+start;target=start;
   for(let j=0;j<length;j++){const options=moves(target,system.rules);target=options[Math.floor(rng()*options.length)].next;}
  } else if(system.id==='swaps') {
   const a=1+i,b=length-a;
   start='A'.repeat(a)+'B|'+'C'.repeat(b)+'D';target='B'+'A'.repeat(a)+'|D'+'C'.repeat(b);
  } else { const a=i+1,b=length+1-a;start='A'.repeat(a)+'B'.repeat(b);target='C'; }
  const steps=solve(start,target,system.rules);
  if(steps.length!==length||!verify(system,start,target,steps).solved) throw Error(`Generation failed: ${system.id}/${length}`);
  chains.push({id:`${system.id}-L${length}-${i+1}`,system:system.id,length,start,target,steps});
 }
 const body={schema:'monkey-pool@2',generatorVersion:GENERATOR_VERSION,seed,see,chains};
 return {...body,sha256:hash(body)};
}
export const POOL_FILE=new URL('./pool.json',import.meta.url);
export function loadPool() {
 const pool=JSON.parse(readFileSync(POOL_FILE,'utf8'));const {sha256,...body}=pool;
 if(pool.generatorVersion!==GENERATOR_VERSION||hash(body)!==sha256) throw Error('Pool version/digest mismatch; regenerate deliberately.');
 return pool;
}
export function seePrompt(task,level) {
 const family=familyById[task.family];
 return [`Monkey See ${SUITE_VERSION}. Infer a function from examples within the declared hypothesis class.`,
  family.hypothesis,`Input: ${family.inputType}. Return JavaScript function f(input). Output code only.`,
  ...task.shown.slice(0,level).map(x=>`f(${JSON.stringify(x.input)}) -> ${JSON.stringify(x.output)}`)].join('\n');
}
export function doPrompt(system) {
 return [`Monkey Do ${SUITE_VERSION}: write a general JavaScript function solve(start,target).`,
  'Rewrite one matching substring per move, at a zero-based integer position.',
  ...system.rules.map(r=>`${r.id}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`),
  'Other characters are inert. Return an array of {rule,start,next} objects describing the full derivation.',
  'Every move must be legal and the final state must equal target. Only completed chains receive credit; legal prefixes receive zero.',
  'Any legal derivation is accepted, up to 1000 moves; intermediate strings must be at most 128 characters.',
  'Return [] if unable to solve. Your code gets 3000 ms per chain, in a fresh JavaScript context.',
  'Chains have shortest distances 5, 10, 20, 30 and 50. You will not be shown evaluation pairs. Output code only.'].join('\n');
}
export function prompts(pool) {
 return [...pool.see.flatMap(t=>LEVELS.map(l=>({id:`SEE/${t.id}/${l}`,text:seePrompt(t,l)}))),...SYSTEMS.map(s=>({id:`DO/${s.id}`,text:doPrompt(s)}))].map(p=>({...p,sha256:hash(p.text)}));
}
// Compare supported output values across VM realms without JSON coercion.
// In particular, NaN, Infinity and undefined must never become a correct null.
export function equalOutput(actual, expected) {
 if (actual === expected) return true;
 if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
 return expected.every((value, i) => Object.hasOwn(actual, i) && equalOutput(actual[i], value));
}
export function scoreSee(task,level,text) {
 const compiled=compileCandidate(text,{entry:'f',isolateCalls:true,detachOutput:true});
 const truth=familyById[task.family].candidates[task.target].fn;
 const cases=[...task.shown.slice(0,level),...task.heldOut.map(input=>({input,output:truth(input)}))];
 const rows=cases.map(({input,output})=>{
  try { const r=runCandidate(compiled,input);return {correct:r.ok&&equalOutput(r.value,output),threw:!r.ok}; }
  catch {return {correct:false,threw:true};}
 });
 const seen=rows.slice(0,level),held=rows.slice(level);
 return {compatibleCandidates:familyById[task.family].candidates.filter(c=>task.shown.slice(0,level).every(x=>equal(c.fn(x.input),x.output))).length,seenCorrect:seen.filter(r=>r.correct).length,seenTotal:level,correct:held.filter(r=>r.correct).length,total:held.length,threw:held.filter(r=>r.threw).length,compileError:compiled.ok?null:compiled.error};
}
export function scoreDo(system,chains,text) {
 const compiled=compileCandidate(text,{entry:'solve',isolateCalls:true,detachOutput:true,timeoutMs:3000});
 return chains.map(c=>{
  try {const r=runCandidate(compiled,c.start,c.target);const v=r.ok?verify(system,c.start,c.target,r.value):{solved:false,legal:0,invalid:true};return {id:c.id,length:c.length,...v,error:r.ok?null:r.error};}
  catch(e){return {id:c.id,length:c.length,solved:false,legal:0,invalid:true,error:String(e.message)};}
 });
}
export function aggregateSee(rows) {
 const scored=rows.filter(r=>SCORED_LEVELS.includes(r.level));
 const failed=scored.some(r=>r.callFailure);
 const accuracy=mean(scored.map(r=>r.correct/r.total));
 return {total:failed?null:50*accuracy,max:50,accuracy:failed?null:accuracy,
  robustness:failed?null:mean(scored.map(r=>1-r.threw/r.total)),
  gzMean:failed?null:100*mean(scored.map(r=>r.seenCorrect/r.seenTotal-r.correct/r.total)),
  callFailures:rows.filter(r=>r.callFailure).length,
  perLevel:Object.fromEntries(LEVELS.map(l=>{const rs=rows.filter(r=>r.level===l);return [l,{scored:SCORED_LEVELS.includes(l),meanCompatibleCandidates:mean(rs.map(r=>r.compatibleCandidates??null)),accuracy:rs.some(r=>r.callFailure)?null:mean(rs.map(r=>r.correct/r.total))}];})),
  perFamily:Object.fromEntries([...new Set(scored.map(r=>r.family))].map(f=>{const rs=scored.filter(r=>r.family===f);return [f,rs.some(r=>r.callFailure)?null:mean(rs.map(r=>r.correct/r.total))];}))};
}
export function aggregateDo(rows) {
 const failed=rows.some(r=>r.callFailure);
 return {total:failed?null:50*mean(rows.map(r=>mean(r.chains.map(c=>Number(c.solved))))),max:50,
  callFailures:rows.filter(r=>r.callFailure).length,
  perSystem:Object.fromEntries(rows.map(r=>[r.system,{solved:r.callFailure?null:r.chains.filter(c=>c.solved).length,total:r.chains.length,
   perBand:Object.fromEntries(BANDS.map(l=>[l,r.callFailure?null:mean(r.chains.filter(c=>c.length===l).map(c=>Number(c.solved)))]))}]))};
}
export async function runSuite(config,{pool=loadPool(),mode='all',dryRun=false,completeFn=complete,log=()=>{}}={}) {
 const see=[],doo=[];
 async function call(prompt,reference) {
  const startedAt=Date.now();
  try {const r=dryRun?{text:reference}:await completeFn(config,prompt);return {response:r.text,usage:r.usage??null,providerModel:r.providerModel??null,finishReason:r.finishReason??null,callFailure:null,elapsedMs:Date.now()-startedAt};}
  catch(e){return {response:'',callFailure:describeCallFailure(e,{startedAt,timeoutMs:config?.timeoutMs??null}),elapsedMs:Date.now()-startedAt};}
 }
 if(mode!=='do') for(const t of pool.see) for(const level of LEVELS) {
  log(`SEE ${t.id} / ${level}`);
  const prompt=seePrompt(t,level),answer=await call(prompt,`const f=${familyById[t.family].candidates[t.target].source};`);
  const scored=scoreSee(t,level,answer.response);
  see.push({taskId:t.id,family:t.family,level,prompt,promptDigest:hash(prompt),...answer,...scored});
 }
 if(mode!=='see') for(const s of SYSTEMS) {
  log(`DO ${s.id}`);const prompt=doPrompt(s),answer=await call(prompt,solverSource(s));
  doo.push({system:s.id,prompt,promptDigest:hash(prompt),...answer,chains:scoreDo(s,pool.chains.filter(c=>c.system===s.id),answer.response)});
 }
 return {see:see.length?aggregateSee(see):null,do:doo.length?aggregateDo(doo):null,calls:{see,do:doo}};
}
