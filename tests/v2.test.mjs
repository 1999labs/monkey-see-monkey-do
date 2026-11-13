import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,readdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate } from '../src/v2/gate.mjs';
import { loadPool,buildPool,runSuite,aggregateSee,scoreDo,scoreSee,SYSTEMS,solverSource,seePrompt,doPrompt,equalOutput } from '../src/v2/suite.mjs';
import { familyById } from '../src/v2/families.mjs';

test('v2 pool is deterministic, disjoint, identifiable, and independently solvable',async()=>{
 assert.equal((await gate({full:true})).ok,true);
 assert.notDeepEqual(buildPool(123).see,loadPool().see);
});
test('a late-level crash affects robustness; unusable submissions keep their denominator',()=>{
 const rows=[4,8,16].map(level=>({family:'x',level,correct:level===16?0:50,total:50,threw:level===16?50:0,seenCorrect:level,seenTotal:level}));
 const out=aggregateSee(rows);assert.equal(out.robustness,2/3);assert.ok(Math.abs(out.total-100/3)<1e-10);
 const t=loadPool().see[0],bad=scoreSee(t,4,'this is invalid code');assert.equal(bad.total,50);assert.equal(bad.threw,50);
 rows[1].callFailure={reason:'timeout'};assert.equal(aggregateSee(rows).total,null);
});
test('DO rejects malformed returns and legal prefixes without losing subsequent chains',()=>{
 const pool=loadPool();
 for(const system of SYSTEMS) {
  const chains=pool.chains.filter(c=>c.system===system.id);
  for(const value of ['[null]','[{}]','null','42','[]'])assert.ok(scoreDo(system,chains,`function solve(){return ${value};}`).every(c=>!c.solved));
  const prefix=solverSource(system).replace('return search(start,target,','return search(start,target,').replace(/\);\}$/,' ).slice(0,1);}') ;
  assert.ok(scoreDo(system,chains,prefix).every(c=>!c.solved));
 }
});
test('network path matches reference dry-run and failures are missing scores',async()=>{
 const pool=loadPool(),answers=new Map();
 for(const t of pool.see)for(const l of [2,4,8,16])answers.set(seePrompt(t,l),`const f=${familyById[t.family].candidates[t.target].source};`);
 for(const s of SYSTEMS)answers.set(doPrompt(s),solverSource(s));
 let calls=0;
 const result=await runSuite(null,{completeFn:async(_,prompt)=>{calls++;return {text:answers.get(prompt)};}});
 assert.equal(calls,51);assert.equal(result.see.total,50);assert.equal(result.do.total,50);
 const failed=await runSuite(null,{mode:'do',completeFn:async()=>{throw Error('endpoint unavailable');}});
 assert.equal(failed.do.total,null);assert.equal(failed.do.callFailures,3);
});
test('default v2 CLI writes complete offline evidence without an adjusted score',()=>{
 const out=mkdtempSync(join(tmpdir(),'monkey-v2-test-'));
 const run=spawnSync(process.execPath,['src/v2/cli.mjs','dry-run','--out',out],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/60\/60 chains/);
 const file=readdirSync(out).find(f=>f.startsWith('combined-'));
 const report=JSON.parse(readFileSync(join(out,file),'utf8'));
 assert.equal(report.suiteVersion,'2.0.0');assert.equal(report.summary.see.mean,50);assert.equal(report.summary.do.mean,50);
 assert.equal(report.runs[0].calls.see.length,48);assert.equal(report.runs[0].calls.do.length,3);assert.equal(report.adjusted,undefined);
 assert.ok(report.limitations.length>=6);
});

test("cross-realm output comparison preserves null and nonfinite distinctions",()=>{
 assert.equal(equalOutput(NaN,null),false);assert.equal(equalOutput(undefined,null),false);
 assert.equal(equalOutput(Infinity,null),false);assert.equal(equalOutput([NaN],[null]),false);
 assert.equal(equalOutput(Array(1),[null]),false);assert.equal(equalOutput([1,2],[1,2]),true);
});
