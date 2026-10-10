/**
 * Serve any Adapter over the adapter protocol.
 *
 * Use it to run an adapter in its own process, or as the reference for what a
 * server in another language must do. Every call must carry the shared token.
 */
import * as grpc from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';
import {
  errors,
  isSethuError,
  type CollectionDefinition,
  type Query,
} from '@sethucms/core';
import type { Adapter } from '../adapter.js';
import { adapterService, PROTOCOL_VERSION, toServiceError } from './shared.js';

/** Options for {@link serveAdapter}. */
export interface ServeOptions {
  /** Shared secret the gateway sends as `authorization: Bearer <token>`. At least 16 characters. */
  token: string;
  /** Address to listen on. Default 127.0.0.1:0 (any free port, this machine only). */
  host?: string;
  port?: number;
  /** Turn TLS on. Without it the server only accepts plain-text connections, which is fine on one machine. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Build a fresh adapter for each Connect. Default: use `adapter` itself. */
  adapterType?: string;
}

/** Handle to a listening server. */
export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

// gRPC unary handler shape. `any` because the request/reply types come
// from the dynamically loaded .proto.
type Handler = (
  call: grpc.ServerUnaryCall<any, any>,
  callback: grpc.sendUnaryData<any>,
) => void;

/**
 * Expose `adapter` over the adapter protocol (v1) on a gRPC port.
 * @param options.token shared secret required on every call.
 * @returns the bound port and a `close()` that shuts the server down.
 */
export async function serveAdapter(
  adapter: Adapter,
  options: ServeOptions,
): Promise<RunningServer> {
  if (options.token.length < 16) {
    throw new Error('The token must be at least 16 characters');
  }
  // Compared in constant time below; building it once avoids rework per call.
  const wanted = Buffer.from(`Bearer ${options.token}`);
  const { service } = adapterService();

  // Wrap every RPC with token auth and error translation, so no handler
  // can forget either. Failures leave through {@link toServiceError}, which
  // hides internal detail.
  const guarded =
    (work: (request: any) => Promise<unknown>): Handler =>
    (call, callback) => {
      const header = String(call.metadata.get('authorization')[0] ?? '');
      const given = Buffer.from(header);
      // `timingSafeEqual` throws on unequal lengths, so check length first.
      // A constant-time compare stops attackers guessing the token byte by
      // byte.
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        callback(toServiceError(errors.authFailed('Bad token')));
        return;
      }
      work(call.request).then(
        (reply) => callback(null, reply),
        (error: unknown) =>
          callback(
            toServiceError(
              isSethuError(error)
                ? error
                : errors.internal('Adapter failed', undefined, error),
            ),
          ),
      );
    };

  // Complex arguments (definitions, queries, records) cross the wire as
  // JSON strings: one schema-free format for every adapter language.
  const parse = <T>(json: string): T => JSON.parse(json) as T;
  // Advertised in `Describe` so the client only exposes optional calls the
  // adapter really implements.
  const optional = [
    ...(typeof adapter.createCollection === 'function'
      ? ['createCollection']
      : []),
    ...(typeof adapter.finishBulkLoad === 'function' ? ['finishBulkLoad'] : []),
  ];

  const server = new grpc.Server({
    // 16 MiB cap on incoming messages, to bound memory per request.
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
  });
  server.addService(service, {
    // `Describe` carries the protocol version; the client refuses a mismatch.
    Describe: guarded(async () => ({
      type: options.adapterType ?? adapter.type,
      protocol_version: PROTOCOL_VERSION,
      optional_calls: optional,
    })),
    Connect: guarded(async (r) => {
      await adapter.connect({
        connectionId: r.connection_id,
        config: parse(r.config_json || '{}'),
        credentials: parse(r.credentials_json || '{}'),
        readOnly: r.read_only,
      });
      return {};
    }),
    Capabilities: guarded(async () => ({
      json: JSON.stringify(adapter.capabilities()),
    })),
    Introspect: guarded(async () => ({
      json: JSON.stringify(await adapter.introspect()),
    })),
    Find: guarded(async (r) => {
      const result = await adapter.find(
        parse<CollectionDefinition>(r.collection_json),
        parse<Query>(r.query_json),
        r.position_json ? parse(r.position_json) : undefined,
      );
      return {
        records_json: JSON.stringify(result.records),
        next_position_json:
          result.nextPosition === undefined
            ? ''
            : JSON.stringify(result.nextPosition),
      };
    }),
    Get: guarded(async (r) => {
      const record = await adapter.get(
        parse<CollectionDefinition>(r.collection_json),
        parse(r.id_json),
      );
      return record
        ? { found: true, record_json: JSON.stringify(record) }
        : { found: false, record_json: '' };
    }),
    Create: guarded(async (r) => ({
      json: JSON.stringify(
        await adapter.create(
          parse<CollectionDefinition>(r.collection_json),
          parse(r.values_json),
        ),
      ),
    })),
    Update: guarded(async (r) => ({
      json: JSON.stringify(
        await adapter.update(
          parse<CollectionDefinition>(r.collection_json),
          parse(r.id_json),
          parse(r.values_json),
        ),
      ),
    })),
    Delete: guarded(async (r) => {
      await adapter.delete(
        parse<CollectionDefinition>(r.collection_json),
        parse(r.id_json),
      );
      return {};
    }),
    // Protocol v1 ends a session with `Disconnect` (not `Close`): the client
    // sends it, then closes the channel itself.
    Disconnect: guarded(async () => {
      await adapter.close();
      return {};
    }),
    CreateCollection: guarded(async (r) => {
      if (!adapter.createCollection) {
        throw errors.unsupported('This adapter cannot create collections');
      }
      await adapter.createCollection(
        parse<CollectionDefinition>(r.collection_json),
      );
      return {};
    }),
    FinishBulkLoad: guarded(async (r) => {
      if (!adapter.finishBulkLoad) {
        throw errors.unsupported('This adapter has no bulk-load step');
      }
      await adapter.finishBulkLoad(
        parse<CollectionDefinition>(r.collection_json),
      );
      return {};
    }),
  });

  // Plain-text is only safe on loopback; the default host is 127.0.0.1.
  // Exposing it elsewhere requires `tls`.
  const credentials = options.tls
    ? grpc.ServerCredentials.createSsl(
        null,
        [
          {
            cert_chain: Buffer.from(options.tls.cert),
            private_key: Buffer.from(options.tls.key),
          },
        ],
        false,
      )
    : grpc.ServerCredentials.createInsecure();
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      `${options.host ?? '127.0.0.1'}:${options.port ?? 0}`,
      credentials,
      (error, bound) => (error ? reject(error) : resolve(bound)),
    );
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}
