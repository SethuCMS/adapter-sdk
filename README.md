# @sethucms/adapter-sdk

Everything needed to write a database adapter for SethuCMS.

| Piece | What it is |
|---|---|
| `Adapter` | The interface an adapter implements: `connect`, `capabilities`, `introspect`, `find`, `get`, `create`, `update`, `delete`, `close` |
| `GuardedAdapter` | A wrapper that adds the rules every database needs, so adapter authors cannot forget them |
| `@sethucms/adapter-sdk/testing` | The conformance suite. An adapter is not releasable until it passes |

## What the guard does for you

An adapter only translates. The guard, which the gateway always puts in front of it, handles:

- validating the query against the collection and the database's capabilities (unsupported means `CAPABILITY_UNSUPPORTED`, never a silent approximation)
- refusing writes on read-only connections (connections are read-only unless opened otherwise)
- validating records (no unknown, generated or read-only fields)
- signing and checking pagination cursors
- timeouts, and hiding unexpected failures behind a generic `INTERNAL` error so database messages never reach clients

Permissions (who sees which fields and rows) are applied before the guard with `restrictQuery` and `maskRecord` from `@sethucms/core`.

## Writing an adapter

1. Copy `packages/memory` from [sethucms-adapters](https://github.com/sethucms/sethucms-adapters). It is the smallest complete example.
2. Implement the `Adapter` interface. Declare `capabilities()` honestly.
3. Return at most `query.page.limit` records from `find`, and a `nextPosition` only when more exist. The position can be anything JSON-serialisable; the guard signs it.
4. Map database errors to the platform's codes (see `packages/postgres/src/errors.ts` in sethucms-adapters) and never copy native messages into them.
5. Add a test that runs the conformance suite:

```ts
import { test } from 'node:test';
import { defineConformanceSuite, conformanceCollection } from '@sethucms/adapter-sdk/testing';

defineConformanceSuite(test, {
  label: 'my-db',
  async prepare({ readOnly }) {
    // Return a connected adapter whose storage for `conformanceCollection` is empty.
    return { adapter, cleanup: async () => { /* drop test data, close */ } };
  },
});
```

The suite checks introspection, the create/get/update/delete round trip, `NOT_FOUND`, cursor pagination (every record exactly once), filters and sorting, refusal of unsupported queries, read-only enforcement, hostile input (SQL injection text, operator injection, wildcard characters, mass assignment) and forged cursors.

## Working on it locally

`@sethucms/core` is not published yet, so `package.json` links it from a sibling folder.
Clone this repo next to the main one:

```
~/sethucms/               (core lives in packages/core; build it first)
~/sethucms-adapter-sdk/   (this repo)
```

```bash
(cd ../sethucms/packages/core && pnpm install && pnpm build)
pnpm install
pnpm test
```

Once core is published, delete the `pnpm.overrides` block in `package.json`.
