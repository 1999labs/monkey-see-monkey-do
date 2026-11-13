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
 const out=aggregateSee(rows);assert.equal(out.robustness,0);assert.equal(out.total,0);
 const t=loadPool().see[0],bad=scoreSee(t,4,'this is invalid code');assert.equal(bad.total,50);assert.equal(bad.threw,50);
 rows[2].callFailure={reason:'timeout'};assert.equal(aggregateSee(rows).total,null);
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
 assert.equal(report.suiteVersion,'2.1.0');assert.equal(report.summary.see.mean,50);assert.equal(report.summary.do.mean,50);
 assert.equal(report.runs[0].calls.see.length,48);assert.equal(report.runs[0].calls.do.length,3);assert.equal(report.adjusted,undefined);
 assert.ok(report.limitations.length>=6);
});

test("cross-realm output comparison preserves null and nonfinite distinctions",()=>{
 assert.equal(equalOutput(NaN,null),false);assert.equal(equalOutput(undefined,null),false);
 assert.equal(equalOutput(Infinity,null),false);assert.equal(equalOutput([NaN],[null]),false);
 assert.equal(equalOutput(Array(1),[null]),false);assert.equal(equalOutput([1,2],[1,2]),true);
});

import { validateEvidence } from '../src/v2/acceptance.mjs';
import { generationBudgets } from '../src/v2/generation.mjs';
import { compileCandidate, runCandidate } from '../src/sandbox.mjs';
import { SUITE_VERSION } from '../src/v2/version.mjs';
import { equal } from '../src/v2/util.mjs';

test('every wrong declared rule fails held-out; eight examples remain ambiguous and sixteen identify the target',()=>{
 for(const t of loadPool().see) {
  const family=familyById[t.family],truth=family.candidates[t.target].fn;
  const remaining=l=>family.candidates.filter(c=>t.shown.slice(0,l).every(x=>equal(c.fn(x.input),x.output))).length;
  assert.ok(remaining(2)>1);assert.ok(remaining(8)>1);assert.equal(remaining(16),1);
  for(let i=0;i<family.candidates.length;i++)if(i!==t.target) {
   assert.ok(t.heldOut.some(x=>!equal(truth(x),family.candidates[i].fn(x))));
   assert.ok(scoreSee(t,16,`const f=${family.candidates[i].source};`).correct<50);
  }
 }
});
test('return getters, proxies and toJSON execute under the VM timeout and do not escape into validation',()=>{
 // Parent timeout makes a regression fail instead of hanging the entire suite.
 const script=`import {compileCandidate,runCandidate} from './src/sandbox.mjs';
 for(const value of ['new Proxy([], {get(){while(true){}}})','{get a(){while(true){}}','{toJSON(){while(true){}}}','{get a(){throw new Proxy({}, {get(){while(true){}}});}}']) {
 const c=compileCandidate('function f(){return '+value+';}',{isolateCalls:true,detachOutput:true,timeoutMs:50});
 if(runCandidate(c,0).ok)throw Error('expected bounded failure');
 }
 console.log('bounded');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/bounded/);
 const replaced=compileCandidate('JSON.stringify=()=>new Proxy([], {get(){while(true){}}}); function f(){return 1;}',{isolateCalls:true,detachOutput:true,timeoutMs:50});
 assert.equal(runCandidate(replaced,0).ok,false);
 for(const value of ['NaN','Infinity','undefined','[undefined]']) {
  const c=compileCandidate(`function f(){return ${value};}`,{isolateCalls:true,detachOutput:true});assert.equal(runCandidate(c,0).ok,false);
 }
});
test('v2 acceptance rejects early-exit overrides before any calls',()=>{
 for(const extra of ['--help','-h','--dry-run','--runs=1','--model=other','--out=/tmp/unused']) {
  const r=spawnSync(process.execPath,['src/v2/acceptance.mjs','--strong','unused-a','--weak','unused-b',extra],{encoding:'utf8',timeout:3000});
  assert.equal(r.status,1,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/PASS/);assert.doesNotMatch(r.stderr,/SyntaxError/);
 }
});
test('acceptance requires two current complete reports and rejects mismatches and missing evidence',async()=>{
 const pool=loadPool(),run=await runSuite(null,{dryRun:true});
 const summary=Object.fromEntries(['see','do'].map(axis=>[axis,{scores:[50,50,50],completedRuns:3,totalRuns:3,mean:50,min:50,max:50}]));
 const reports=['a','b'].map(model=>({model,schema:'monkey-report@2',suiteVersion:SUITE_VERSION,dryRun:false,poolSha256:pool.sha256,runs:[run,run,run],summary}));
 assert.equal(validateEvidence(reports,['a','b']),true);
 assert.equal(validateEvidence([],['a','b']),false);assert.equal(validateEvidence(reports.slice(0,1),['a','b']),false);
 for(const mutate of [r=>r[0].model='b',r=>r[0].dryRun=true,r=>r[0].suiteVersion='2.0.0',r=>r[0].poolSha256='bad',r=>r[0].runs.pop(),r=>r[0].runs[0].calls.see.pop(),r=>r[0].runs[0].calls.do[0].callFailure={reason:'timeout'},r=>r[0].summary.see.mean=49]) {
  const changed=structuredClone(reports);mutate(changed);assert.equal(validateEvidence(changed,['a','b']),false);
 }
});
test('generation budgets distinguish effective adapter defaults and configured overrides',()=>{
 assert.deepEqual(generationBudgets({adapter:'anthropic',model:'m'}).outputTokens,{parameter:'max_tokens',limit:32000,source:'adapter-default'});
 for(const adapter of ['openai','responses','ollama'])assert.equal(generationBudgets({adapter}).outputTokens.source,'provider-default');
 const c=generationBudgets({adapter:'responses',model:'actual',maxOutputTokens:123,timeoutMs:456,maxRetries:0});
 assert.equal(c.outputTokens.limit,123);assert.equal(c.requestTimeoutMs,456);assert.equal(c.maxAttempts,1);assert.equal(c.model,'actual');
 assert.equal(generationBudgets({}).requestTimeoutMs,420000);assert.equal(generationBudgets({}).maxRetries,2);
 assert.equal(generationBudgets({adapter:'ollama',maxTokens:42}).outputTokens.limit,null);
 assert.equal(generationBudgets(null),null);
});
