/**
 * Tests for GuardedAdapter, using a scripted stub adapter so each guard
 * behaviour (read-only, validation, error hiding, cursors, page trimming) is
 * checked in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentModel,
  CursorCodec,
  PRESETS,
  defineCapabilities,
  defineCollection,
  parseQuery,
  isSethuError,
  type Capabilities,
  type CollectionDefinition,
  type Query,
} from '@sethucms/core';
import {
  GuardedAdapter,
  type Adapter,
  type FindResult,
  type RecordData,
} from '../src/index.js';

// Minimal collection used by every guard test.
const things = defineCollection({
  name: 'things',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'name', type: 'string', required: true },
  ],
  relations: [],
});

/** A scripted adapter so each guard behaviour can be tested alone. */
class StubAdapter implements Adapter {
  readonly type = 'stub';
  calls: string[] = [];
  behaviour: () => Promise<unknown> = async () => ({ records: [] });
  constructor(private readonly caps: Capabilities = PRESETS.sql) {}
  async connect() {}
  capabilities() {
    return this.caps;
  }
  async introspect() {
    return [things];
  }
  async find(
    _c: CollectionDefinition,
    _q: Query,
    _p: unknown,
  ): Promise<FindResult> {
    this.calls.push('find');
    return (await this.behaviour()) as FindResult;
  }
  async get(): Promise<RecordData | null> {
    this.calls.push('get');
    return (await this.behaviour()) as RecordData | null;
  }
  async create(): Promise<RecordData> {
    this.calls.push('create');
    return { id: 1, name: 'x' };
  }
  async update(): Promise<RecordData> {
    this.calls.push('update');
    return { id: 1, name: 'x' };
  }
  async delete(): Promise<void> {
    this.calls.push('delete');
  }
  async close() {}
}

// Fixed key so cursors are reproducible.
const cursors = new CursorCodec({ secrets: [new Uint8Array(32).fill(3)] });
// Build a guard around a scripted stub.
const make = (
  adapter: Adapter,
  options: { readOnly?: boolean; timeoutMs?: number } = {},
) =>
  new GuardedAdapter({
    adapter,
    model: new ContentModel([things]),
    cursors,
    ...options,
  });
const q = (body: object = {}) => parseQuery({ collection: 'things', ...body });

// Fail-closed default: forgetting to pass `readOnly` must not enable writes.
test('connections are read-only unless explicitly opened for writes', async () => {
  const stub = new StubAdapter();
  const guarded = make(stub);
  await assert.rejects(
    guarded.create('things', { name: 'a' }),
    (e) => isSethuError(e) && e.code === 'READ_ONLY',
  );
  assert.deepEqual(stub.calls, [], 'the adapter was never called');
  assert.equal(guarded.capabilities().writes, false);
});

test('writes are refused when the adapter itself cannot write', async () => {
  const guarded = make(new StubAdapter(defineCapabilities()), {
    readOnly: false,
  });
  await assert.rejects(
    guarded.create('things', { name: 'a' }),
    (e) => isSethuError(e) && e.code === 'CAPABILITY_UNSUPPORTED',
  );
});

// The guard is the only validator; the stub records whether it was called.
test('invalid queries and records never reach the adapter', async () => {
  const stub = new StubAdapter();
  const guarded = make(stub, { readOnly: false });
  await assert.rejects(
    guarded.find(q({ filter: { field: 'ghost', op: 'eq', value: 1 } })),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    guarded.create('things', { name: 'a', id: 9 }),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    guarded.update('things', '1', {}),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    guarded.get('things', 'bad\nid'),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    guarded.get('nope', '1'),
    (e) => isSethuError(e) && e.code === 'NOT_FOUND',
  );
  assert.deepEqual(stub.calls, []);
});

// Raw driver text must never reach clients.
test('unexpected adapter errors are hidden behind INTERNAL', async () => {
  const stub = new StubAdapter();
  stub.behaviour = async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  };
  const guarded = make(stub);
  await assert.rejects(guarded.find(q()), (e) => {
    assert.ok(isSethuError(e));
    assert.equal(e.code, 'INTERNAL');
    assert.ok(
      !JSON.stringify({ m: e.message, d: e.details }).includes('hunter2'),
    );
    return true;
  });
});

test('adapter errors that are already standard pass through', async () => {
  const stub = new StubAdapter();
  stub.behaviour = async () => {
    throw Object.assign(new Error('x'), {});
  };
  const timeoutStub = new StubAdapter();
  timeoutStub.behaviour = () => new Promise(() => {});
  await assert.rejects(
    make(timeoutStub, { timeoutMs: 20 }).find(q()),
    (e) => isSethuError(e) && e.code === 'TIMEOUT',
  );
});

// Cursor integrity: tampering must be detected.
test('cursors: signed on the way out, checked on the way in', async () => {
  const stub = new StubAdapter();
  const seenPositions: unknown[] = [];
  stub.find = async (_c, _q, position) => {
    seenPositions.push(position);
    return { records: [{ id: 1, name: 'a' }], nextPosition: { offset: 1 } };
  };
  const guarded = make(stub);

  const first = await guarded.find(q({ page: { limit: 1 } }));
  assert.ok(first.nextCursor && first.nextCursor !== '{"offset":1}');
  await guarded.find(q({ page: { limit: 1, cursor: first.nextCursor } }));
  assert.deepEqual(seenPositions, [undefined, { offset: 1 }]);

  await assert.rejects(
    guarded.find(q({ page: { limit: 1, cursor: 'forged.value' } })),
    (e) => isSethuError(e) && e.code === 'VALIDATION_FAILED',
  );
});

// The page limit is enforced by the guard, not trusted to the adapter.
test('extra records from a careless adapter are trimmed to the page limit', async () => {
  const stub = new StubAdapter();
  stub.behaviour = async () => ({ records: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const page = await make(stub).find(q({ page: { limit: 2 } }));
  assert.equal(page.records.length, 2);
  assert.equal(page.nextCursor, null);
});
