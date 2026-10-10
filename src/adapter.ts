/**
 * The contract every database adapter implements.
 *
 * An adapter is the only code that knows a database's native language. It
 * translates the portable query into native calls and native results back into
 * plain records. It does NOT enforce permissions, read-only mode, validation or
 * pagination signing: the GuardedAdapter (guarded.ts) does that for every adapter,
 * so those rules cannot be forgotten by an adapter author.
 */
import type { Capabilities, CollectionDefinition, Query } from '@sethucms/core';

/**
 * A record in portable form: plain JSON values keyed by field name, with
 * canonical types (ISO strings for dates, base64 for binary).
 */
export type RecordData = Record<string, unknown>;

/** What the worker hands an adapter when opening a connection. */
export interface ConnectInput {
  connectionId: string;
  /** Non-secret settings: host, port, database, tls, pool size. */
  config: Record<string, unknown>;
  /** Secrets, resolved in memory by the vault. Never log or store these. */
  credentials: Record<string, unknown>;
  /** Informational: the guard enforces read-only, but adapters may also open read-only sessions. */
  readOnly: boolean;
}

/** One page of results from {@link Adapter.find}. */
export interface FindResult {
  records: RecordData[];
  /**
   * Where the next page starts, in whatever form the adapter needs. Undefined
   * means "no more records". The guard signs this into a cursor for the client.
   */
  nextPosition?: unknown;
}

/**
 * The SDK contract. Implement this to add a database. Adapters stay thin
 * on purpose: no permission, read-only or validation logic belongs here,
 * because {@link GuardedAdapter} applies it uniformly to all of them.
 */
export interface Adapter {
  /** Adapter id, for example "postgres". */
  readonly type: string;

  /**
   * Open the connection. Must validate settings first and never put
   * credential values in error messages.
   */
  connect(input: ConnectInput): Promise<void>;

  /** Honest description of what this database can do. See PRESETS in @sethucms/core. */
  capabilities(): Capabilities;

  /** Describe every collection found in the database, with canonical field types. */
  introspect(): Promise<CollectionDefinition[]>;

  /**
   * List records. `query` has already been validated against `collection` and
   * checked against `capabilities()`. `position` is what this adapter returned
   * as `nextPosition` for the previous page, or undefined for the first page.
   * Return at most `query.page.limit` records.
   */
  find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult>;

  /** Return the record, or null when it does not exist. */
  get(collection: CollectionDefinition, id: string): Promise<RecordData | null>;

  /** Insert and return the stored record (including generated fields). */
  create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData>;

  /** Change the given fields and return the stored record. Throw NOT_FOUND if missing. */
  update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData>;

  /** Remove the record. Throw NOT_FOUND if missing. */
  delete(collection: CollectionDefinition, id: string): Promise<void>;

  /** Release connections and clients. Must be safe to call twice. */
  close(): Promise<void>;

  /**
   * OPTIONAL. Create empty storage for a collection that does not exist yet
   * (a table, a collection). Only migration calls this, and only when an
   * administrator asked for missing collections to be created. Must refuse to
   * overwrite something that exists, and must build names only from the
   * definition (checked identifiers), never from free text.
   */
  createCollection?(collection: CollectionDefinition): Promise<void>;

  /**
   * OPTIONAL. Called once after a bulk copy that wrote ids explicitly into a
   * key the database normally numbers itself, so the database's counter moves
   * past the largest id (PostgreSQL sequences need this; others do not).
   */
  finishBulkLoad?(collection: CollectionDefinition): Promise<void>;
}
