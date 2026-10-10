/**
 * An adapter that lives in another process (any language) and speaks the
 * SethuCMS adapter protocol over gRPC. To the gateway it is an ordinary Adapter.
 *
 * Settings, as the administrator saves them for a connection of type "grpc":
 *   config:       { address: "host:port", tls?: true, caCert?: "<PEM>", callTimeoutMs?: 30000, remote?: { ...settings for the remote adapter } }
 *   credentials:  { token: "<shared secret for the remote adapter>", remote?: { ...secrets for the remote adapter } }
 */
import * as grpc from '@grpc/grpc-js';
import {
  errors,
  type Capabilities,
  type CollectionDefinition,
  type Query,
} from '@sethucms/core';
import type {
  Adapter,
  ConnectInput,
  FindResult,
  RecordData,
} from '../adapter.js';
import {
  adapterService,
  fromServiceError,
  PROTOCOL_VERSION,
} from './shared.js';

// Loosely typed unary call, so methods can be invoked by name.
type Unary = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, reply?: any) => void,
) => void;

/** Options for {@link GrpcAdapter}. */
export interface GrpcAdapterOptions {
  /** Refuse plain-text connections to anything but this machine. The gateway sets this in production. */
  requireTls?: boolean;
}

// Loopback only: plain-text gRPC to another machine would expose the
// token and data.
const isLocalAddress = (host: string): boolean =>
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  host === '[::1]';

/** Split "host:port" or "[v6]:port". */
export function parseAddress(address: unknown): { host: string; port: number } {
  const match =
    typeof address === 'string'
      ? /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(address)
      : null;
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) {
    throw errors.validation('config.address must look like host:port');
  }
  return { host: (match[1] as string).replace(/^\[|\]$/g, ''), port };
}

/**
 * An {@link Adapter} that forwards every call to a remote adapter over
 * gRPC (protocol v1). To the gateway it is indistinguishable from a
 * built-in adapter.
 */
export class GrpcAdapter implements Adapter {
  readonly type: string;
  private client: grpc.Client | undefined;
  private metadata = new grpc.Metadata();
  private caps: Capabilities | undefined;
  private timeoutMs = 30_000;

  /** Present only when the remote adapter says it supports them. */
  // Assigned in `connect()` only when the remote advertises them, so the
  // OPTIONAL members of {@link Adapter} stay absent when unsupported.
  createCollection?: (collection: CollectionDefinition) => Promise<void>;
  finishBulkLoad?: (collection: CollectionDefinition) => Promise<void>;

  constructor(
    private readonly options: GrpcAdapterOptions = {},
    type = 'grpc',
  ) {
    this.type = type;
  }

  /**
   * Dial the remote adapter, check protocol version and optional calls via
   * `Describe`, then `Connect` it to its own database and cache its
   * capabilities. Any failure closes the channel before rethrowing.
   * `config.remote` / `credentials.remote` are passed through verbatim to
   * the remote adapter; the top-level `token` only authenticates this hop.
   */
  async connect(input: ConnectInput): Promise<void> {
    const { host, port } = parseAddress(input.config['address']);
    // TLS is the default; plain-text must be chosen explicitly.
    const tls = input.config['tls'] !== false;
    if (!tls && this.options.requireTls && !isLocalAddress(host)) {
      throw errors.validation(
        'Plain-text connections to an external adapter are only allowed to this machine. Turn on tls',
      );
    }
    const caCert = input.config['caCert'];
    if (
      caCert !== undefined &&
      (typeof caCert !== 'string' ||
        !caCert.includes('BEGIN CERTIFICATE') ||
        caCert.length > 20_000)
    ) {
      throw errors.validation('config.caCert must be a PEM certificate');
    }
    const timeout = input.config['callTimeoutMs'];
    if (timeout !== undefined) {
      if (
        typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < 100 ||
        timeout > 600_000
      ) {
        throw errors.validation('config.callTimeoutMs must be 100 to 600000');
      }
      this.timeoutMs = timeout;
    }
    const token = input.credentials['token'];
    if (typeof token !== 'string' || token.length < 16) {
      throw errors.validation(
        'credentials.token must be at least 16 characters',
      );
    }

    const credentials = tls
      ? grpc.credentials.createSsl(
          typeof caCert === 'string' ? Buffer.from(caCert) : null,
        )
      : grpc.credentials.createInsecure();
    const { Client } = adapterService();
    this.client = new Client(
      `${host.includes(':') ? `[${host}]` : host}:${port}`,
      credentials,
      { 'grpc.max_receive_message_length': 16 * 1024 * 1024 },
    );
    this.metadata = new grpc.Metadata();
    this.metadata.set('authorization', `Bearer ${token}`);

    try {
      const described = (await this.call('Describe', {})) as {
        type: string;
        protocol_version: string;
        optional_calls: string[];
      };
      // Exact match: mixing protocol versions could silently corrupt data.
      if (described.protocol_version !== PROTOCOL_VERSION) {
        throw errors.connectionFailed(
          `The external adapter speaks protocol ${described.protocol_version || 'unknown'}, this gateway needs ${PROTOCOL_VERSION}`,
        );
      }
      if (described.optional_calls.includes('createCollection')) {
        this.createCollection = (c) =>
          this.call('CreateCollection', {
            collection_json: JSON.stringify(c),
          }).then(() => undefined);
      }
      if (described.optional_calls.includes('finishBulkLoad')) {
        this.finishBulkLoad = (c) =>
          this.call('FinishBulkLoad', {
            collection_json: JSON.stringify(c),
          }).then(() => undefined);
      }

      await this.call('Connect', {
        connection_id: input.connectionId,
        read_only: input.readOnly,
        config_json: JSON.stringify(
          isObject(input.config['remote']) ? input.config['remote'] : {},
        ),
        credentials_json: JSON.stringify(
          isObject(input.credentials['remote'])
            ? input.credentials['remote']
            : {},
        ),
      });
      this.caps = JSON.parse(
        ((await this.call('Capabilities', {})) as { json: string }).json,
      ) as Capabilities;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  capabilities(): Capabilities {
    if (!this.caps) {
      throw errors.internal('The external adapter is not connected');
    }
    return this.caps;
  }

  // Remote output is untrusted: shape-check before use.
  async introspect(): Promise<CollectionDefinition[]> {
    const reply = (await this.call('Introspect', {})) as { json: string };
    const list = JSON.parse(reply.json) as unknown;
    if (!Array.isArray(list)) {
      throw errors.internal(
        'The external adapter returned a bad collection list',
      );
    }
    return list as CollectionDefinition[];
  }

  async find(
    collection: CollectionDefinition,
    query: Query,
    position: unknown,
  ): Promise<FindResult> {
    const reply = (await this.call('Find', {
      collection_json: JSON.stringify(collection),
      query_json: JSON.stringify(query),
      position_json: position === undefined ? '' : JSON.stringify(position),
    })) as { records_json: string; next_position_json: string };
    const records = JSON.parse(reply.records_json) as unknown;
    if (!Array.isArray(records)) {
      throw errors.internal('The external adapter returned bad records');
    }
    return {
      records: records as RecordData[],
      ...(reply.next_position_json
        ? { nextPosition: JSON.parse(reply.next_position_json) as unknown }
        : {}),
    };
  }

  async get(
    collection: CollectionDefinition,
    id: string,
  ): Promise<RecordData | null> {
    const reply = (await this.call('Get', {
      collection_json: JSON.stringify(collection),
      id_json: JSON.stringify(id),
    })) as { found: boolean; record_json: string };
    return reply.found ? (JSON.parse(reply.record_json) as RecordData) : null;
  }

  async create(
    collection: CollectionDefinition,
    values: RecordData,
  ): Promise<RecordData> {
    const reply = (await this.call('Create', {
      collection_json: JSON.stringify(collection),
      values_json: JSON.stringify(values),
    })) as { json: string };
    return JSON.parse(reply.json) as RecordData;
  }

  async update(
    collection: CollectionDefinition,
    id: string,
    values: RecordData,
  ): Promise<RecordData> {
    const reply = (await this.call('Update', {
      collection_json: JSON.stringify(collection),
      id_json: JSON.stringify(id),
      values_json: JSON.stringify(values),
    })) as { json: string };
    return JSON.parse(reply.json) as RecordData;
  }

  async delete(collection: CollectionDefinition, id: string): Promise<void> {
    await this.call('Delete', {
      collection_json: JSON.stringify(collection),
      id_json: JSON.stringify(id),
    });
  }

  /** Release the remote connection, then the channel. Safe to call twice. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    // Tell the remote adapter (protocol v1 `Disconnect`) to release its
    // database connection, but never wait long: a dead peer must not block.
    await new Promise<void>((resolve) => {
      (client as unknown as Record<string, Unary>)['Disconnect']?.(
        {},
        this.metadata,
        { deadline: Date.now() + 3000 },
        () => resolve(),
      );
    });
    // Close the channel itself (the generated client class wraps method names, so use the base class directly).
    grpc.Client.prototype.close.call(client);
  }

  // Single place that adds auth metadata, a per-call deadline and error
  // translation.
  private call(method: string, request: object): Promise<unknown> {
    const client = this.client as unknown as Record<string, Unary> | undefined;
    if (!client) {
      return Promise.reject(
        errors.internal('The external adapter is not connected'),
      );
    }
    return new Promise((resolve, reject) => {
      client[method]?.(
        request,
        this.metadata,
        { deadline: Date.now() + this.timeoutMs },
        (error, reply) =>
          error ? reject(fromServiceError(error)) : resolve(reply),
      );
    });
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
