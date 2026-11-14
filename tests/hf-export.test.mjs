import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildPackage,writePackage,SOURCE_COMMIT } from '../scripts/export-hf.mjs';

test('HF export is byte-reproducible, preserves frozen source provenance and independently verifies',async()=>{
 const first=await buildPackage(),second=await buildPackage();
 assert.deepEqual(first,second);
 const provenance=JSON.parse(first['provenance.json']);
 assert.equal(provenance.source_commit,SOURCE_COMMIT);
 assert.equal(provenance.dataset_id,'noahmclaughlin/monkey-see-monkey-do');
 assert.equal(provenance.validation.self_test,'passed');
 const dir=mkdtempSync(join(tmpdir(),'monkey-hf-test-'));
 writePackage(first,dir);writePackage(first,dir); // identical re-export is idempotent
 const verify=spawnSync(process.execPath,[join(dir,'verify.mjs')],{encoding:'utf8',timeout:20000});
 assert.equal(verify.status,0,verify.stdout+verify.stderr);assert.match(verify.stdout,/792 reference outputs/);
 // A single altered label must fail the package's standalone integrity check.
 const file=join(dir,'data/see_tasks.jsonl');
 const rows=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 rows[0].held_out_examples[0].output_json='"tampered"';
 writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');
 const tampered=spawnSync(process.execPath,[join(dir,'verify.mjs')],{encoding:'utf8',timeout:10000});
 assert.notEqual(tampered.status,0);
 assert.throws(()=>writePackage(first,dir),/Refusing to overwrite differing package file/);
});
