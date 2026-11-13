import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs,prepareModel } from '../cli.mjs';
import { temperatureStatus } from '../adapters/registry.mjs';
import { runSuite,loadPool,buildPool,POOL_FILE,prompts,SUITE_VERSION } from './suite.mjs';
import { familyById } from './families.mjs';
import { hash,mean } from './util.mjs';
import { gate } from './gate.mjs';
import { generationBudgets } from './generation.mjs';
export const LIMITATIONS=[
 'SEE measures rule identification within six declared finite hypothesis classes. Uniqueness is guaranteed only within those classes; this is not unrestricted abstraction.',
 'DO measures generated solver programs across three formal systems. Chain length, branching and search strategy are confounded; this does not measure the model executing a long chain of thought.',
 'The fixed public examples and algorithms may appear in training data. Version markers and prompt hashes do not detect prior exposure.',
 'Task instances within a family and chains answered by one solver are correlated. Repeat summaries describe this fixed suite, not population confidence intervals.',
 'Provider, reasoning effort, sampling settings and runtime budget are part of the experiment. Missing API calls produce null headline scores, not model zeros.',
 'This suite does not measure repository editing or agentic software engineering, and has no validated relationship to performance on external benchmarks.',
 'Candidate JavaScript runs under node:vm timeouts. This is local evaluation infrastructure, not a security boundary or a memory-limited service.',
];
const command=process.argv[2]??'all';
const argv=process.argv.slice(3);
const write=(report,prefix,out)=>{
 mkdirSync(out,{recursive:true});
 const name=`${prefix}-${String(report.model).replace(/[^a-zA-Z0-9._-]/g,'-')}-${report.timestamp.replace(/[:.]/g,'-')}.json`;
 const path=join(out,name);writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});return path;
};
try {
 if(command==='gen-pool'||command==='check-pool') {
  if(argv.length) throw Error('Pool commands take no arguments; change the frozen seed/version deliberately.');
  const text=JSON.stringify(buildPool(),null,2)+'\n';
  if(command==='check-pool') {if(text!==readFileSync(POOL_FILE,'utf8'))throw Error('Pool regeneration differs');console.log('PASS: pool regenerates byte-identically');}
  else {writeFileSync(POOL_FILE,text);console.log('Generated v2 pool. Prompt pins are updated separately and deliberately.');}
 } else if(command==='self-test') {
  if(argv.some(x=>x!=='--full')) throw Error('self-test accepts only --full');
  const r=await gate({full:argv.includes('--full')});console.log(`PASS: ${r.checks} v2 checks`);
 } else if(command==='prompts') {
  if(argv.length)throw Error('prompts takes no arguments');
  const pins=JSON.parse(readFileSync(new URL('./prompt-digests.json',import.meta.url),'utf8'));
  for(const p of prompts(loadPool())) {console.log(`${p.id}\n${p.text}\nsha256 ${p.sha256}`);if(p.sha256!==pins[p.id])throw Error(`Digest mismatch ${p.id}`);}
  console.log('PASS: all 51 prompt digests match');
 } else if(command==='audit') {
  const p=loadPool();console.log(JSON.stringify(p.see.map(t=>({task:t.id,naiveCorrect:t.heldOut.filter(x=>JSON.stringify(familyById[t.family].naive.fn(x))===JSON.stringify(familyById[t.family].candidates[t.target].fn(x))).length,total:50})),null,2));
 } else {
  if(!['all','see','do','dry-run','diagnose'].includes(command))throw Error(`Unknown command ${command}`);
  const args=parseArgs(argv),dryRun=command==='dry-run'||args.dryRun,mode=command==='diagnose'?'see':command==='dry-run'?'all':command;
  if(args.help||(!args.model&&!dryRun)) {
   console.log(`Monkey See / Monkey Do ${SUITE_VERSION}\nUsage: npm run ${command} -- -m provider/model [-r 3] [--only-provider NAME --no-fallback] [--config FILE] [--out DIR]\n--dry-run uses reference code without network. Full suite: 48 SEE calls + 3 DO calls per repeat.\nSEE and DO are reported separately; v1 scores are not comparable.`);
  } else {
   if(args.perTier!==null)throw Error('v2 does not publish subset scores');
   const passed=await gate();console.log(`Self-test passed (${passed.checks} checks)`);
   const {config,keySource}=dryRun?{config:null,keySource:'none (offline)'}:await prepareModel(args);
   const pool=loadPool(),runs=[];
   for(let i=0;i<args.runs;i++)runs.push(await runSuite(config,{pool,mode,dryRun,log:s=>console.log(`Run ${i+1}/${args.runs}: ${s}`)}));
   const summarize=axis=>{const scores=runs.map(r=>r[axis]?.total??null),valid=scores.filter(x=>x!==null);return {scores,completedRuns:valid.length,totalRuns:runs.length,mean:valid.length===runs.length?mean(valid):null,min:valid.length?Math.min(...valid):null,max:valid.length?Math.max(...valid):null};};
   const report={schema:'monkey-report@2',suiteVersion:SUITE_VERSION,timestamp:new Date().toISOString(),model:dryRun?'reference-offline':args.model,dryRun,poolSha256:pool.sha256,
    generation:{budgets:generationBudgets(config),runtime:{node:process.version,platform:process.platform,arch:process.arch},endpoint:config?.endpoint??null,provider:config?.provider??null,reasoningEffort:config?.reasoningEffort??null,seed:config?.seed??null,temperature:config?temperatureStatus(config):null,keySource,executionTimeoutMs:{see:1000,do:3000}},
    summary:{see:mode!=='do'?summarize('see'):null,do:mode!=='see'?summarize('do'):null},runs,limitations:LIMITATIONS};
   console.log(JSON.stringify(report.summary,null,2));
   const saved=write(report,mode==='all'?'combined':mode,args.out);console.log(`Saved ${saved}`);
   if(mode==='all')for(const axis of ['see','do'])write({...report,summary:{[axis]:report.summary[axis]},runs:runs.map(r=>({[axis]:r[axis],calls:r.calls[axis]}))},axis,args.out);
   if(dryRun) {if(runs.some(r=>(r.see&&r.see.total!==50)||(r.do&&r.do.total!==50)))throw Error('Reference dry-run failed');console.log('PASS: independent reference SEE 50/50; DO 50/50 (60/60 chains).');}
   else if(runs.some(r=>r.calls.see.some(c=>c.callFailure)||r.calls.do.some(c=>c.callFailure)))process.exitCode=2;
  }
 }
} catch(e) {console.error(e.stack??e.message);process.exitCode=1;}
