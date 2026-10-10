/**
 * The safety layer around every adapter.
 *
 * Callers (the API gateway) talk to a GuardedAdapter, never to an adapter
 * directly. It makes sure that, for every database:
 *
 *   - queries are validated and capability-checked before the adapter sees them
 *   - writes are refused on read-only connections
 *   - records are validated (no unknown, generated or read-only fields)
 *   - cursors are signed, bound to the query, and checked
 *   - slow calls time out
 *   - unexpected adapter failures become a generic INTERNAL error, so database
 *     messages (which can contain hostnames or SQL) never reach clients
 *
 * Permissions (who may see which fields and rows) are applied BEFORE this layer
 * using restrictQuery / maskRecord from @sethucms/core.
 */
import {
  ContentModel,
  applyReadOnly,
  assertValidRecord,
  errors,
  isSethuError,
  planQuery,
  type Capabilities,
  type CursorCodec,
  type Query,
} from '@sethucms/core';
import type { Adapter, RecordData } from './adapter.js';

/** Options for {@link GuardedAdapter}. */
export interface GuardedAdapterOptions {
  adapter: Adapter;
  model: ContentModel;
  cursors: CursorCodec;
  /** Connections are read-only unless this is explicitly false. */
  readOnly?: boolean;
  /** Longest an adapter call may take. Default 15 seconds. */
  timeoutMs?: number;
}

/** One page returned to the API layer. The cursor is opaque and signed. */
export interface PageResult {
  records: RecordData[];
  nextCursor: string | null;
  /** Warnings the API passes on to clients, for example "sorting needs an index". */
  notes: string[];
}

// Defaults: a slow database must not hold a request open forever, and
// ids are short, so a hard length cap rejects abuse before it reaches
// a driver.
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ID_LENGTH = 256;

/**
 * Wraps an {@link Adapter} so every database gets the same safety rules.
 * The gateway must only ever hold this wrapper, never the raw adapter.
 */
export class GuardedAdapter {
  private readonly adapter: Adapter;
  private readonly model: ContentModel;
  private readonly cursors: CursorCodec;
  private readonly readOnly: boolean;
  private readonly timeoutMs: number;

  constructor(options: GuardedAdapterOptions) {
    this.adapter = options.adapter;
    this.model = options.model;
    this.cursors = options.cursors;
    // Fail closed: anything but an explicit `false` means read-only.
    this.readOnly = options.readOnly ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** What this connection can do right now (writes are off when read-only). */
  capabilities(): Capabilities {
    return applyReadOnly(this.adapter.capabilities(), this.readOnly);
  }

  /**
   * Validate and plan the query against the adapter's capabilities, decode
   * the signed cursor, and sign the next position. The adapter never sees
   * an unchecked query or a cursor the client could have forged.
   */
  async find(query: Query): Promise<PageResult> {
    const collection = this.model.require(query.collection);
    const { notes } = planQuery(query, collection, this.adapter.capabilities());

    const position = query.page.cursor
      ? await this.cursors.decode(query, query.page.cursor)
      : undefined;
    const result = await this.run(() =>
      this.adapter.find(collection, query, position),
    );

    // Trim in case the adapter over-returns; the limit is a guarantee to
    // callers, not a request to the adapter.
    const records = result.records.slice(0, query.page.limit);
    const nextCursor =
      result.nextPosition === undefined
        ? null
        : await this.cursors.encode(query, result.nextPosition);
    return { records, nextCursor, notes };
  }

  /**
   * Fetch one record. A missing record becomes NOT_FOUND here, so adapters
   * may simply return `null`.
   */
  async get(collectionName: string, id: string): Promise<RecordData> {
    const collection = this.model.require(collectionName);
    assertValidId(id);
    const record = await this.run(() => this.adapter.get(collection, id));
    if (!record) {
      throw errors.notFound('Record not found');
    }
    return record;
  }

  /**
   * Validate against the collection (no unknown, generated or read-only
   * fields: blocks mass assignment), then insert.
   */
  async create(collectionName: string, values: unknown): Promise<RecordData> {
    this.assertCanWrite();
    const collection = this.model.require(collectionName);
    assertValidRecord(collection, values, 'create');
    return this.run(() =>
      this.adapter.create(collection, values as RecordData),
    );
  }

  /** Partial update with the same field validation as create. */
  async update(
    collectionName: string,
    id: string,
    values: unknown,
  ): Promise<RecordData> {
    this.assertCanWrite();
    const collection = this.model.require(collectionName);
    assertValidId(id);
    assertValidRecord(collection, values, 'update');
    if (Object.keys(values as RecordData).length === 0) {
      throw errors.validation('Nothing to update');
    }
    return this.run(() =>
      this.adapter.update(collection, id, values as RecordData),
    );
  }

  /** Delete by id. */
  async delete(collectionName: string, id: string): Promise<void> {
    this.assertCanWrite();
    const collection = this.model.require(collectionName);
    assertValidId(id);
    await this.run(() => this.adapter.delete(collection, id));
  }

  /** Close the adapter. Goes through `run` so a hung close times out. */
  async close(): Promise<void> {
    await this.run(() => this.adapter.close());
  }

  // -------------------------------------------------------------------------

  // Two independent gates: the connection setting and the adapter's own
  // declared ability to write.
  private assertCanWrite(): void {
    if (this.readOnly) {
      throw errors.readOnly();
    }
    if (!this.adapter.capabilities().writes) {
      throw errors.unsupported('This database adapter cannot write');
    }
  }

  /** Run an adapter call with a timeout, hiding unexpected failures behind INTERNAL. */
  private async run<T>(call: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(errors.timeout('The database took too long to respond')),
        this.timeoutMs,
      );
    });

    try {
      return await Promise.race([call(), timeout]);
    } catch (error) {
      // Standard errors are safe to show. Anything else (driver text can
      // contain hostnames or SQL) is replaced by a generic INTERNAL error,
      // keeping the original only as the cause for server-side logs.
      if (isSethuError(error)) {
        throw error;
      }
      throw errors.internal('Adapter failure', undefined, error);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

// Ids come from URLs. Reject empty, oversized and control-character ids
// (NUL and friends can truncate strings in some drivers).
function assertValidId(id: unknown): asserts id is string {
  const valid =
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f]/.test(id);
  if (!valid) {
    throw errors.validation('Invalid record id');
  }
}
