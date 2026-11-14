// Offline integrity/reference check. Run with Node 20+: node verify.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const json=p=>JSON.parse(read(p));
const rows=p=>read(p).trim().split('\n').map(JSON.parse);
const provenance=json('provenance.json'), manifest=json('manifest.json');
for(const f of manifest.files){const bytes=readFileSync(new URL(f.path,import.meta.url));assert.equal(bytes.length,f.bytes,f.path);assert.equal(hash(bytes),f.sha256,f.path);}
assert.equal(provenance.suite_version,'2.1.0');
const pool=json('source/pool.json'),{sha256,...body}=pool;
assert.equal(hash(JSON.stringify(body)),sha256);assert.equal(sha256,provenance.pool_sha256);
const pins=json('source/prompt-digests.json'), rules=json('rules.json');
const tasks=rows('data/see_tasks.jsonl'),prompts=rows('data/see_prompts.jsonl');
const chains=rows('data/do_chains.jsonl'),systems=rows('data/do_systems.jsonl');
assert.equal(tasks.length,12);assert.equal(prompts.length,48);assert.equal(chains.length,60);assert.equal(systems.length,3);
for(const row of [...tasks,...prompts,...chains,...systems]){
 assert.equal(row.suite_version,'2.1.0');assert.equal(row.source_commit,provenance.source_commit);assert.equal(row.pool_sha256,sha256);
}
for(const t of tasks){
 const original=pool.see.find(x=>x.id===t.task_id);assert.ok(original);
 assert.equal(t.shown_examples.length,16);assert.equal(t.held_out_examples.length,50);
 const shown=t.shown_examples.map(x=>x.input_json),held=t.held_out_examples.map(x=>x.input_json);
 assert.equal(new Set(shown).size,16);assert.equal(new Set(held).size,50);assert.ok(held.every(x=>!shown.includes(x)));
 assert.deepEqual(t.shown_examples.map(x=>({input:JSON.parse(x.input_json),output:JSON.parse(x.output_json)})),original.shown);
 assert.deepEqual(t.held_out_examples.map(x=>JSON.parse(x.input_json)),original.heldOut);
 const family=rules.see.find(f=>f.family_id===t.family_id);
 assert.equal(t.target_candidate_index,original.target);
 assert.equal(t.reference_function_js,`const f = ${family.candidates[original.target].function_js};`);
 // Only execute the shipped reference code after verifying its manifest digest.
 for(const example of [...t.shown_examples,...t.held_out_examples]){
  const actual=vm.runInNewContext(`${t.reference_function_js}\nJSON.stringify(f(${example.input_json}));`,{}, {timeout:1000});
  assert.deepEqual(JSON.parse(actual),JSON.parse(example.output_json));
 }
}
for(const p of prompts){
 assert.equal(hash(p.prompt),p.prompt_sha256);assert.equal(p.prompt_sha256,pins[`SEE/${p.task_id}/${p.sample_level}`]);
 assert.equal(p.contributes_to_headline,p.sample_level===16);
}
for(const s of systems){assert.equal(hash(s.prompt),s.prompt_sha256);assert.equal(s.prompt_sha256,pins[`DO/${s.system_id}`]);assert.deepEqual(s.rules,rules.do.find(x=>x.id===s.system_id).rules);}
function replay(c,steps,rs){
 let state=c.start;
 for(const step of steps){const r=rs.find(x=>x.id===step.rule);assert.ok(r);assert.ok(Number.isInteger(step.start)&&step.start>=0);assert.equal(state.slice(step.start,step.start+r.from.length),r.from);state=state.slice(0,step.start)+r.to+state.slice(step.start+r.from.length);assert.equal(state,step.next);}
 assert.equal(state,c.target);
}
for(const c of chains){
 const original=pool.chains.find(x=>x.id===c.chain_id);assert.ok(original);
 assert.equal(c.start,original.start);assert.equal(c.target,original.target);assert.equal(c.shortest_distance,original.length);assert.equal(c.system_id,original.system);
 assert.deepEqual(c.reference_steps,original.steps);assert.equal(c.reference_steps.length,c.shortest_distance);
 const system=systems.find(x=>x.system_id===c.system_id);replay(c,c.reference_steps,system.rules);
 const derived=JSON.parse(vm.runInNewContext(`${system.reference_solver_js}\nJSON.stringify(solve(${JSON.stringify(c.start)},${JSON.stringify(c.target)}));`,{},{timeout:3000}));
 assert.equal(derived.length,c.shortest_distance);replay(c,derived,system.rules);
}
console.log('PASS: package checksums; 12 SEE tasks, 48 prompts, 792 reference outputs; 60 legal and independently solved DO chains; 3 systems.');
