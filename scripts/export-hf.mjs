// Deterministic packaging only: no model calls and no Hub writes.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPool, seePrompt, doPrompt, solverSource, SYSTEMS } from '../src/v2/suite.mjs';
import { FAMILIES, familyById } from '../src/v2/families.mjs';
import { SUITE_VERSION, GENERATOR_VERSION, LEVELS, SCORED_LEVELS } from '../src/v2/version.mjs';
import { hash, equal } from '../src/v2/util.mjs';
import { gate } from '../src/v2/gate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SOURCE_COMMIT = '6b1a6be1975561240edfd4dffab77236b036798e';
export const REPO_ID = 'noahmclaughlin/monkey-see-monkey-do';
export const DEFAULT_OUT = resolve(ROOT, 'hf/monkey-see-monkey-do');
const SOURCE_FILES = ['LICENSE', 'src/v2/version.mjs', 'src/v2/suite.mjs',
  'src/v2/families.mjs', 'src/v2/util.mjs', 'src/v2/pool.json',
  'src/v2/prompt-digests.json', 'src/v2/gate.mjs', 'src/sandbox.mjs',
  'docs/calibration.md', 'docs/scoring-detail.md'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

export async function buildPackage() {
  if (SUITE_VERSION !== '2.1.0' || GENERATOR_VERSION !== '2.1.0') throw Error('This exporter is frozen to suite 2.1.0');
  const sourceFiles = SOURCE_FILES.map(path => {
    const actual = readFileSync(resolve(ROOT, path));
    const committed = execFileSync('git', ['show', `${SOURCE_COMMIT}:${path}`], {cwd: ROOT});
    if (!actual.equals(committed)) throw Error(`Source differs from pinned commit: ${path}`);
    return {path, sha256: hash(actual.toString('utf8')), bytes: actual.length};
  });
  const checked = await gate({full: true});
  const pool = loadPool();
  const common = {suite_version: SUITE_VERSION, pool_sha256: pool.sha256, source_commit: SOURCE_COMMIT};
  const seeTasks = pool.see.map(task => {
    const family = familyById[task.family];
    const target = family.candidates[task.target];
    return {...common, task_id: task.id, family_id: task.family, input_type: family.inputType,
      hypothesis_class: family.hypothesis, target_candidate_index: task.target,
      reference_function_js: `const f = ${target.source};`,
      shown_examples: task.shown.map((x,i) => ({index:i, input_json:JSON.stringify(x.input), output_json:JSON.stringify(x.output)})),
      held_out_examples: task.heldOut.map((input,i) => ({index:i, input_json:JSON.stringify(input), output_json:JSON.stringify(target.fn(input))}))};
  });
  const seePrompts = pool.see.flatMap(task => LEVELS.map(level => {
    const prompt = seePrompt(task, level);
    return {...common, task_id:task.id, family_id:task.family, sample_level:level,
      contributes_to_headline:SCORED_LEVELS.includes(level), prompt, prompt_sha256:hash(prompt),
      compatible_candidate_count:familyById[task.family].candidates.filter(c=>task.shown.slice(0,level).every(x=>equal(c.fn(x.input),x.output))).length};
  }));
  const doSystems = SYSTEMS.map(system => {
    const prompt = doPrompt(system);
    return {...common, system_id:system.id, rules:system.rules, prompt, prompt_sha256:hash(prompt),
      reference_solver_js:solverSource(system), chain_count:pool.chains.filter(c=>c.system===system.id).length};
  });
  const doChains = pool.chains.map(chain => ({...common, chain_id:chain.id,
    system_id:chain.system, shortest_distance:chain.length, band:`L${chain.length}`,
    start:chain.start, target:chain.target, reference_steps:chain.steps}));
  const rules = {suite_version:SUITE_VERSION,
    see:FAMILIES.map(f=>({family_id:f.id,input_type:f.inputType,hypothesis_class:f.hypothesis,
      candidates:f.candidates.map((c,index)=>({index,function_js:c.source})),naive_baseline_js:f.naive.source})),
    do:SYSTEMS};
  const files = {
    'data/see_tasks.jsonl':jsonl(seeTasks), 'data/see_prompts.jsonl':jsonl(seePrompts),
    'data/do_chains.jsonl':jsonl(doChains), 'data/do_systems.jsonl':jsonl(doSystems),
    'rules.json':json(rules), 'source/pool.json':readFileSync(resolve(ROOT,'src/v2/pool.json'),'utf8'),
    'source/prompt-digests.json':readFileSync(resolve(ROOT,'src/v2/prompt-digests.json'),'utf8'),
    'LICENSE':readFileSync(resolve(ROOT,'LICENSE'),'utf8'),
  };
  for (const [template,dest] of [['dataset-card.md','README.md'],['verify.mjs','verify.mjs'],['UPLOAD.md','UPLOAD.md']]) {
    files[dest] = readFileSync(resolve(ROOT,'hf/templates',template),'utf8')
      .replaceAll('{{SOURCE_COMMIT}}',SOURCE_COMMIT).replaceAll('{{POOL_SHA256}}',pool.sha256);
  }
  files['provenance.json'] = json({schema:'monkey-hf-package@1', dataset_id:REPO_ID,
    suite_version:SUITE_VERSION, generator_version:GENERATOR_VERSION, seed:pool.seed, seed_hex:'0xC0FFEE',
    source_repository:'https://github.com/1999labs/monkey-see-monkey-do', source_commit:SOURCE_COMMIT,
    source_commit_time:execFileSync('git',['show','-s','--format=%cI',SOURCE_COMMIT],{cwd:ROOT,encoding:'utf8'}).trim(),
    pool_sha256:pool.sha256, pool_hash_algorithm:'SHA-256 of JSON.stringify(pool without sha256), not file bytes',
    source_files:sourceFiles, exporter_sha256:hash(readFileSync(fileURLToPath(import.meta.url),'utf8')),
    validation:{self_test:'passed',full_regeneration:true,checks:checked.checks},
    counts:{see_tasks:12,see_prompts:48,shown_examples:192,held_out_examples:600,do_chains:60,do_systems:3,see_families:6},
    scored_see_levels:SCORED_LEVELS, diagnostic_see_levels:LEVELS.filter(l=>!SCORED_LEVELS.includes(l)),
    transformations:['SEE mixed-type input/output values encoded as JSON strings',
      'Held-out reference outputs derived from the selected reference function',
      'Prompt text and hashes preserved exactly', 'DO recorded legal reference paths preserved exactly'],
    privacy:'Synthetic task data only; no model responses, credentials or user records included',
    generated_at_policy:'No wall-clock export time: identical source and exporter produce identical bytes'});
  files['manifest.json'] = json({algorithm:'sha256',scope:'All package files except manifest.json itself',
    files:Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([path,text])=>({path,bytes:Buffer.byteLength(text),sha256:hash(text)}))});
  return files;
}
export function writePackage(files,out) {
  // Preflight all collisions so a differing existing package is never partially overwritten.
  for (const [path,text] of Object.entries(files)) {
    const dest=resolve(out,path);
    if (existsSync(dest)&&readFileSync(dest,'utf8')!==text) throw Error(`Refusing to overwrite differing package file: ${dest}. Use a new --out directory.`);
  }
  for (const [path,text] of Object.entries(files)) {
    const dest=resolve(out,path);mkdirSync(dirname(dest),{recursive:true});
    if(!existsSync(dest))writeFileSync(dest,text,{flag:'wx'});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);
    if(args.length && (args.length!==2||args[0]!=='--out'))throw Error('Usage: node scripts/export-hf.mjs [--out DIRECTORY]');
    const out=args.length?resolve(args[1]):DEFAULT_OUT;
    const files=await buildPackage();writePackage(files,out);
    console.log(`Prepared ${Object.keys(files).length} files for ${REPO_ID} at ${out}`);
  } catch(e){console.error(e.message);process.exitCode=1;}
}
