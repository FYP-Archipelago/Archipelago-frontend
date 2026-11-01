import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, safeRunPath } from './run.js';
import { decodeGenome, buildPayload, withClusters } from './payload.js';

test('CSV parser preserves quoted commas, newlines, and escaped quotes', () => {
  assert.deepEqual(csv('id,text\n1,"a,b"\n2,"line\n""two"""\n'), [
    { id: '1', text: 'a,b' }, { id: '2', text: 'line\n"two"' },
  ]);
});

test('run ids stay inside the data root', () => {
  assert.throws(() => safeRunPath('../outside'));
  assert.throws(() => safeRunPath('/tmp/outside'));
  assert.match(safeRunPath('run-1'), /data\/run-1$/);
});

test('compact and full genomes decode to the same vector', () => {
  const raw = Buffer.alloc(16); raw.writeDoubleLE(1.25, 0); raw.writeDoubleLE(-2.5, 8);
  assert.deepEqual(decodeGenome('real_vector', 'compact', raw.toString('base64')), [1.25, -2.5]);
  assert.deepEqual(decodeGenome('real_vector', 'full', '[1.25,-2.5]'), [1.25, -2.5]);
});

test('viewer payload retains lineage and migration endpoints', () => {
  const row = (island, index, id, parents, genome) => ({ island_id:island, eval_index:index, fitness:index+island,
    individual_id:id, parent_ids:parents, genome_encoding:'real_vector', genome_repr_mode:'full', genome_repr:JSON.stringify(genome), genome_hash:`hash-${id}` });
  const run = { id:'test', start:{algorithm:'DE',benchmark:'Rastrigin'}, maximising:false,
    evaluations:[row(0,0,'a','',[1,2]),row(0,1,'b','a',[2,3]),row(1,0,'c','a',[3,4])],
    events:[{type:'migration_arrive',origin_individual_ids:['a'],arrived_individual_ids:['c']}] };
  const payload = buildPayload(run);
  assert.deepEqual(payload.group_lengths,[2,1]);
  const parents = Buffer.from(payload.parent_idx, 'base64');
  assert.equal(parents.length, 4);
  assert.equal(parents.readInt32LE(0), 0);
  assert.equal(Buffer.from(payload.migrations,'base64').length,16);
  const clustered = withClusters(payload,{'0:hash-a':'shared','1:hash-c':'shared'},'result-1');
  assert.equal(clustered.cluster_count,2);
});
