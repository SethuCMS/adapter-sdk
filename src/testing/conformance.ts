/**
 * The conformance suite: the same scenarios run against every adapter.
 * An adapter is not releasable until all of them pass.
 *
 * Usage (node:test):
 *
 *   import { test } from 'node:test';
 *   import { defineConformanceSuite } from '@sethucms/adapter-sdk/testing';
 *
 *   defineConformanceSuite(test, {
 *     async prepare({ readOnly }) {
 *       // Return a connected adapter whose database contains EMPTY storage for
 *       // `conformanceCollection` (build it from the definition).
 *       return { adapter, cleanup: async () => { ... } };
 *     },
 *   });
 */
import assert from 'node:assert/strict';
import {
  ContentModel,
  CursorCodec,
  defineCollection,
  eq,
  and,
  or,
  not,
  parseQuery,
  isSethuError,
  type CollectionDefinition,
  type ErrorCode,
  type Query,
} from '@sethucms/core';
import type { Adapter, RecordData } from '../adapter.js';
import { GuardedAdapter } from '../guarded.js';

/** The collection every adapter must be able to store for the suite. */
export const conformanceCollection: CollectionDefinition = defineCollection({
  name: 'items',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    {
      name: 'title',
      type: 'string',
      required: true,
      validation: { maxLength: 200 },
    },
    { name: 'score', type: 'integer' },
    { name: 'status', type: 'string' },
  ],
  relations: [],
});

/** What `prepare()` hands back: a connected adapter and optional teardown. */
export interface PreparedAdapter {
  adapter: Adapter;
  /** Remove test data and close connections. */
  cleanup?: () => Promise<void>;
}

/** Options for {@link defineConformanceSuite}. */
export interface ConformanceOptions {
  /** Return a connected adapter with empty storage for `conformanceCollection`. */
  prepare(options: { readOnly: boolean }): Promise<PreparedAdapter>;
  /** Prefix for test names, usually the adapter type. */
  label?: string;
}

// Minimal shape of `node:test`'s `test`, so any runner can be used.
type TestFunction = (name: string, run: () => Promise<void>) => unknown;

// Fixed secret: the suite checks cursor behaviour, not key secrecy.
const CURSOR_SECRET = new Uint8Array(32).fill(7);

// A GuardedAdapter around the adapter under test. Scenarios go through
// the guard (not the raw adapter) because that is what clients really
// use, so guard and adapter are verified together.
interface Harness {
  guarded: GuardedAdapter;
  cleanup: () => Promise<void>;
}

// Build a fresh adapter plus guard for one scenario.
async function open(
  options: ConformanceOptions,
  readOnly: boolean,
): Promise<Harness> {
  const prepared = await options.prepare({ readOnly });
  const guarded = new GuardedAdapter({
    adapter: prepared.adapter,
    model: new ContentModel([conformanceCollection]),
    cursors: new CursorCodec({ secrets: [CURSOR_SECRET] }),
    readOnly,
  });
  return {
    guarded,
    cleanup: async () =>
      prepared.cleanup ? prepared.cleanup() : prepared.adapter.close(),
  };
}

const q = (body: Record<string, unknown> = {}): Query =>
  parseQuery({ collection: 'items', ...body });

// Assert a call fails with a specific platform error code.
async function expectCode(
  code: ErrorCode,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(
      isSethuError(error),
      `expected an SethuError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected error ${code}, but nothing was thrown`);
}

async function seed(
  guarded: GuardedAdapter,
  rows: Array<{ title: string; score: number; status: string }>,
): Promise<RecordData[]> {
  const created: RecordData[] = [];
  for (const row of rows) {
    created.push(await guarded.create('items', row));
  }
  return created;
}

// Follow cursors to the end; the 100-page cap turns a pagination bug
// (cursor that never ends) into a failure instead of a hang.
async function allPages(
  guarded: GuardedAdapter,
  body: Record<string, unknown>,
): Promise<RecordData[]> {
  const records: RecordData[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await guarded.find(
      q({
        ...body,
        page: {
          limit: (body['page'] as { limit?: number } | undefined)?.limit ?? 3,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );
    records.push(...result.records);
    cursor = result.nextCursor;
    if (!cursor) {
      return records;
    }
  }
  throw new Error('pagination did not finish within 100 pages');
}

/**
 * Register the shared scenarios with a test runner. Every adapter must
 * pass all of them: they pin the cross-database behaviour that API
 * clients rely on (CRUD, paging, filters, refusal of unsupported
 * queries, read-only, injection safety, cursor integrity).
 */
export function defineConformanceSuite(
  test: TestFunction,
  options: ConformanceOptions,
): void {
  const name = (text: string) => `${options.label ?? 'adapter'}: ${text}`;

  /** Wrap a scenario so the adapter is always cleaned up. */
  const scenario = (
    title: string,
    run: (guarded: GuardedAdapter) => Promise<void>,
    readOnly = false,
  ) =>
    test(name(title), async () => {
      const harness = await open(options, readOnly);
      try {
        await run(harness.guarded);
      } finally {
        await harness.cleanup();
      }
    });

  test(
    name('introspect describes the collection with canonical types'),
    async () => {
      const { adapter, cleanup } = await options.prepare({ readOnly: true });
      try {
        const found = (await adapter.introspect()).find(
          (c) => c.name === 'items',
        );
        assert.ok(found, 'introspect must return the "items" collection');
        const types = Object.fromEntries(
          found.fields.map((f) => [f.name, f.type]),
        );
        assert.equal(types['id'], 'integer');
        assert.equal(types['title'], 'string');
        assert.equal(found.fields.find((f) => f.primaryKey)?.name, 'id');
      } finally {
        await (cleanup ? cleanup() : adapter.close());
      }
    },
  );

  scenario('create, get, update and delete round trip', async (guarded) => {
    const created = await guarded.create('items', {
      title: 'First',
      score: 10,
      status: 'new',
    });
    assert.ok(
      created['id'] !== undefined && created['id'] !== null,
      'generated id is returned',
    );

    const id = String(created['id']);
    assert.equal((await guarded.get('items', id))['title'], 'First');

    const updated = await guarded.update('items', id, { score: 11 });
    assert.equal(updated['score'], 11);
    assert.equal(
      updated['title'],
      'First',
      'untouched fields stay as they were',
    );

    await guarded.delete('items', id);
    await expectCode('NOT_FOUND', () => guarded.get('items', id));
  });

  // Adapters differ on how a missing row surfaces; the contract is one
  // code (NOT_FOUND) for get, update and delete alike.
  scenario('missing records give NOT_FOUND', async (guarded) => {
    await expectCode('NOT_FOUND', () => guarded.get('items', '999999'));
    await expectCode('NOT_FOUND', () =>
      guarded.update('items', '999999', { score: 1 }),
    );
    await expectCode('NOT_FOUND', () => guarded.delete('items', '999999'));
  });

  scenario(
    'cursor pagination returns every record exactly once',
    async (guarded) => {
      const created = await seed(
        guarded,
        Array.from({ length: 8 }, (_, i) => ({
          title: `Item ${i}`,
          score: i,
          status: 'ok',
        })),
      );
      const seen = (await allPages(guarded, {})).map((r) => String(r['id']));

      assert.equal(seen.length, created.length);
      assert.equal(
        new Set(seen).size,
        created.length,
        'no duplicates across pages',
      );
      assert.deepEqual(
        [...seen].sort(),
        created.map((r) => String(r['id'])).sort(),
      );
    },
  );

  scenario('filters and sorting', async (guarded) => {
    await seed(guarded, [
      { title: 'Alpha', score: 5, status: 'open' },
      { title: 'Beta', score: 20, status: 'open' },
      { title: 'Gamma', score: 35, status: 'closed' },
    ]);
    const titles = async (body: Record<string, unknown>) =>
      (await allPages(guarded, body)).map((r) => r['title']).sort();
    const caps = guarded.capabilities();

    assert.deepEqual(await titles({ filter: eq('status', 'open') }), [
      'Alpha',
      'Beta',
    ]);
    assert.deepEqual(
      await titles({
        filter: { field: 'status', op: 'in', value: ['closed', 'nope'] },
      }),
      ['Gamma'],
    );
    assert.deepEqual(
      await titles({
        filter: { field: 'title', op: 'startsWith', value: 'Be' },
      }),
      ['Beta'],
    );
    // A database without inequality filters must refuse them, not silently ignore them.
    if (caps.filters.inequality === 'none') {
      await expectCode('CAPABILITY_UNSUPPORTED', () =>
        guarded.find(
          q({
            filter: and(eq('status', 'open'), {
              field: 'score',
              op: 'gte',
              value: 20,
            }),
          }),
        ),
      );
    } else {
      assert.deepEqual(
        await titles({
          filter: and(eq('status', 'open'), {
            field: 'score',
            op: 'gte',
            value: 20,
          }),
        }),
        ['Beta'],
      );
    }
    if (caps.filters.or) {
      assert.deepEqual(
        await titles({
          filter: or(eq('title', 'Alpha'), eq('title', 'Gamma')),
        }),
        ['Alpha', 'Gamma'],
      );
    }
    assert.deepEqual(await titles({ filter: not(eq('status', 'open')) }), [
      'Gamma',
    ]);

    if (caps.sort === 'any-field') {
      const sorted = await allPages(guarded, {
        sort: [{ field: 'score', dir: 'desc' }],
      });
      assert.deepEqual(
        sorted.map((r) => r['score']),
        [35, 20, 5],
      );
    }
  });

  // Capabilities are a promise: if an adapter says it cannot do something
  // it must refuse (CAPABILITY_UNSUPPORTED), never return approximate
  // rows.
  scenario(
    'queries the database cannot run are refused, not approximated',
    async (guarded) => {
      const caps = guarded.capabilities();
      if (!caps.filters.or) {
        await expectCode('CAPABILITY_UNSUPPORTED', () =>
          guarded.find(q({ filter: or(eq('title', 'a'), eq('title', 'b')) })),
        );
      } else if (caps.filters.inequality === 'none') {
        await expectCode('CAPABILITY_UNSUPPORTED', () =>
          guarded.find(q({ filter: { field: 'score', op: 'gt', value: 1 } })),
        );
      } else if (caps.sort === 'key-only') {
        await expectCode('CAPABILITY_UNSUPPORTED', () =>
          guarded.find(q({ sort: [{ field: 'score' }] })),
        );
      }
      // Otherwise this adapter supports everything the suite can ask for.
    },
  );

  scenario(
    'read-only connections reject every write',
    async (guarded) => {
      await expectCode('READ_ONLY', () =>
        guarded.create('items', { title: 'x' }),
      );
      await expectCode('READ_ONLY', () =>
        guarded.update('items', '1', { score: 1 }),
      );
      await expectCode('READ_ONLY', () => guarded.delete('items', '1'));
      assert.equal(guarded.capabilities().writes, false);
      assert.deepEqual(
        (await guarded.find(q())).records,
        [],
        'reads still work',
      );
    },
    true,
  );

  // Injection safety: hostile text must round-trip as plain data, and
  // hostile names or operator-shaped values must be rejected before
  // reaching the adapter.
  scenario('hostile input is treated as data or rejected', async (guarded) => {
    const nasty = `'; DROP TABLE items; --`;
    const stored = await guarded.create('items', {
      title: nasty,
      score: 1,
      status: `"quoted" & 'single'`,
    });
    assert.equal(
      stored['title'],
      nasty,
      'special characters round-trip unchanged',
    );

    const found = await allPages(guarded, { filter: eq('title', nasty) });
    assert.equal(found.length, 1);
    assert.equal(
      (await allPages(guarded, { filter: eq('title', `${nasty} x`) })).length,
      0,
    );
    assert.equal(
      (await allPages(guarded, {})).length,
      1,
      'the table is still intact',
    );

    // Injection through names or operators never reaches the adapter.
    assert.throws(() => q({ filter: eq('title; DROP TABLE items', 1) }));
    assert.throws(() =>
      q({ filter: { field: 'title', op: 'eq', value: { $ne: null } } }),
    );
    assert.throws(() => q({ sort: [{ field: 'score desc; --' }] }));

    // Unknown, generated and mass-assigned fields are rejected.
    await expectCode('VALIDATION_FAILED', () =>
      guarded.create('items', { title: 'x', isAdmin: true }),
    );
    await expectCode('VALIDATION_FAILED', () =>
      guarded.create('items', { title: 'x', id: 5 }),
    );
    await expectCode('VALIDATION_FAILED', () =>
      guarded.find(q({ filter: eq('nonexistent', 1) })),
    );

    // LIKE wildcards in user text must not act as wildcards.
    await seed(guarded, [
      { title: '100% sure', score: 2, status: 'a' },
      { title: 'anything', score: 3, status: 'a' },
    ]);
    const percent = await allPages(guarded, {
      filter: { field: 'title', op: 'contains', value: '%' },
    });
    assert.deepEqual(
      percent.map((r) => r['title']),
      ['100% sure'],
    );
  });

  // Cursors are signed and bound to the query that made them, so a
  // tampered cursor or one replayed against a different filter fails.
  scenario('forged or reused cursors are rejected', async (guarded) => {
    await seed(
      guarded,
      Array.from({ length: 4 }, (_, i) => ({
        title: `T${i}`,
        score: i,
        status: 'x',
      })),
    );
    const first = await guarded.find(q({ page: { limit: 2 } }));
    assert.ok(first.nextCursor);

    await expectCode('VALIDATION_FAILED', () =>
      guarded.find(q({ page: { limit: 2, cursor: `${first.nextCursor}x` } })),
    );
    await expectCode('VALIDATION_FAILED', () =>
      guarded.find(
        q({
          filter: eq('status', 'x'),
          page: { limit: 2, cursor: first.nextCursor },
        }),
      ),
    );
  });
}
