// Publication checks validate evidence completeness and observed repeat spread.
// They do not certify a model ranking or external predictive validity.
import { spawnSync } from 'node:child_process';
import { mkdtempSync,readdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args=process.argv.slice(2), models=[];
for(const flag of ['--strong','--weak']) {const i=args.indexOf(flag);if(i>=0){models.push(args[i+1]);args.splice(i,2);}}
if(models.length!==2||models.some(x=>!x)||args.includes('--quick')) {
 console.error('Usage: npm run acceptance -- --strong MODEL --weak MODEL [shared provider/config flags]. Full runs only; labels do not prescribe the ranking.');process.exit(1);
}
if(args.some(a=>['-r','--runs','--dry-run','--out'].includes(a)||a.startsWith('--runs=')||a.startsWith('--out='))throw Error('Acceptance fixes repeats at 3 and uses a fresh evidence directory.');
const dir=mkdtempSync(join(tmpdir(),'monkey-v2-acceptance-'));
let ok=true;
for(const model of models) {
 const r=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'all','-m',model,'-r','3','--out',dir,...args],{stdio:'inherit'});
 if(r.status!==0)ok=false;
}
for(const f of readdirSync(dir).filter(f=>f.startsWith('combined-'))) {
 const r=JSON.parse(readFileSync(join(dir,f),'utf8'));
 for(const axis of ['see','do']) {const s=r.summary[axis];if(s.completedRuns!==3||s.max-s.min>2)ok=false;}
}
console.log(`${ok?'PASS':'FAIL'}: evidence completeness and repeat spread only. Reports: ${dir}`);
process.exitCode=ok?0:1;
