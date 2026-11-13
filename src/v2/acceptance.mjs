import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from '../cli.mjs';
import { SUITE_VERSION, loadPool, prompts } from './suite.mjs';

export function validateEvidence(reports, models, pool = loadPool()) {
  if (reports.length !== 2 || new Set(models).size !== 2) return false;
  const expected = new Map(prompts(pool).map(p => [p.id, p.sha256]));
  return models.every(model => {
    const matching = reports.filter(r => r.model === model);
    if (matching.length !== 1) return false;
    const r = matching[0];
    if (r.schema !== 'monkey-report@2' || r.suiteVersion !== SUITE_VERSION || r.dryRun !== false || r.poolSha256 !== pool.sha256 || r.runs?.length !== 3) return false;
    for (const run of r.runs) {
      if (run.calls?.see?.length !== 48 || run.calls?.do?.length !== 3) return false;
      const calls = [...run.calls.see.map(c => [`SEE/${c.taskId}/${c.level}`, c]), ...run.calls.do.map(c => [`DO/${c.system}`, c])];
      if (new Set(calls.map(([id]) => id)).size !== 51) return false;
      if (calls.some(([id,c]) => c.callFailure || !expected.has(id) || c.promptDigest !== expected.get(id))) return false;
    }
    return ['see', 'do'].every(axis => {
      const scores = r.runs.map(run => run[axis]?.total);
      if (scores.some(x => !Number.isFinite(x) || x < 0 || x > 50)) return false;
      const s = r.summary?.[axis];
      return s?.completedRuns === 3 && s.totalRuns === 3 && JSON.stringify(s.scores) === JSON.stringify(scores)
        && s.min === Math.min(...scores) && s.max === Math.max(...scores) && s.max-s.min <= 2
        && s.mean === scores.reduce((a,b)=>a+b,0)/3;
    });
  });
}

export function main(argv) {
  const args = [...argv], models = [];
  for (const flag of ['--strong','--weak']) {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i+1] || args[i+1].startsWith('-')) throw Error('Supply --strong MODEL and --weak MODEL');
    models.push(args[i+1]); args.splice(i,2);
  }
  if (new Set(models).size !== 2) throw Error('Acceptance requires two distinct model IDs');
  // Restrict forwarded arguments; help/model/out/run overrides cannot turn a
  // child process's successful early exit into publication approval.
  const values = new Set(['--config','--key','-k','--only-provider','--order-provider','--seed','-s']);
  const flags = new Set(['--no-fallback','--i-cannot-control-temperature']);
  for (let i=0; i<args.length; i++) {
    const [name,inline] = args[i].split('=',2);
    if (values.has(name)) { if (inline === undefined) i++; }
    else if (!flags.has(name) || inline !== undefined) throw Error(`Unsupported acceptance option: ${args[i]}`);
  }
  parseArgs(args); // validate values before any model calls
  const dir = mkdtempSync(join(tmpdir(),'monkey-v2-acceptance-'));
  let childrenOk = true;
  for (const model of models) {
    const r = spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'all','-m',model,'-r','3','--out',dir,...args],{stdio:'inherit'});
    if (r.status !== 0) childrenOk = false;
  }
  const reports = readdirSync(dir).filter(f=>f.startsWith('combined-')).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')));
  const ok = childrenOk && validateEvidence(reports,models);
  console.log(`${ok?'PASS':'FAIL'}: evidence completeness and repeat spread only. Reports: ${dir}`);
  return ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch(e) { console.error(e.message); process.exitCode = 1; }
}
