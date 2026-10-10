/** Loading the protocol file and translating errors. Used by both the client and the server. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import {
  SethuError,
  ERROR_CODES,
  type ErrorCode,
  type ValidationIssue,
} from '@sethucms/core';

// Wire protocol version, exchanged in `Describe`. Client and server must
// match exactly. In v1 a session ends with `Disconnect` (not `Close`).
export const PROTOCOL_VERSION = '1';
// Trailer metadata carries the exact platform error code (and validation
// details) across the wire, since gRPC status codes are too coarse.
export const ERROR_CODE_KEY = 'sethucms-error-code';
export const ERROR_DETAILS_KEY = 'sethucms-error-details';

// Single source of truth for the protocol, shared with non-TS servers.
const PROTO_PATH = fileURLToPath(
  new URL('../../../proto/sethucms/adapter/v1/adapter.proto', import.meta.url),
);

/** The loaded service: server-side definition and client constructor. */
export interface AdapterServiceDefinition {
  service: grpc.ServiceDefinition;
  Client: grpc.ServiceClientConstructor;
}

// Parsing the .proto is synchronous; do it once and reuse.
let loaded: AdapterServiceDefinition | undefined;

/** Load (once) and return the Adapter service from the .proto file. */
export function adapterService(): AdapterServiceDefinition {
  if (loaded) {
    return loaded;
  }
  // `keepCase` keeps snake_case names identical to the .proto, and
  // `longs: String` avoids precision loss on 64-bit values.
  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    sethucms: { adapter: { v1: { Adapter: grpc.ServiceClientConstructor } } };
  };
  const Client = pkg.sethucms.adapter.v1.Adapter;
  loaded = { service: Client.service, Client };
  return loaded;
}

// Platform error code -> gRPC status. FORBIDDEN and READ_ONLY share
// PERMISSION_DENIED, which is why the exact code also travels in metadata.
const STATUS_FOR: Record<ErrorCode, grpc.status> = {
  CONNECTION_FAILED: grpc.status.UNAVAILABLE,
  AUTH_FAILED: grpc.status.UNAUTHENTICATED,
  FORBIDDEN: grpc.status.PERMISSION_DENIED,
  READ_ONLY: grpc.status.PERMISSION_DENIED,
  NOT_FOUND: grpc.status.NOT_FOUND,
  CONFLICT: grpc.status.ALREADY_EXISTS,
  VALIDATION_FAILED: grpc.status.INVALID_ARGUMENT,
  CAPABILITY_UNSUPPORTED: grpc.status.FAILED_PRECONDITION,
  RATE_LIMITED: grpc.status.RESOURCE_EXHAUSTED,
  TIMEOUT: grpc.status.DEADLINE_EXCEEDED,
  INTERNAL: grpc.status.INTERNAL,
};

/** What a failed call looks like on the wire. Internal messages are replaced, so server-side details never travel. */
export function toServiceError(error: unknown): grpc.ServiceError {
  const metadata = new grpc.Metadata();
  if (error instanceof SethuError) {
    metadata.set(ERROR_CODE_KEY, error.code);
    if (error.code === 'VALIDATION_FAILED' && Array.isArray(error.details)) {
      metadata.set(ERROR_DETAILS_KEY, JSON.stringify(error.details));
    }
    return {
      name: 'Error',
      code: STATUS_FOR[error.code],
      message: error.code === 'INTERNAL' ? 'Internal error' : error.message,
      details: '',
      metadata,
    };
  }
  metadata.set(ERROR_CODE_KEY, 'INTERNAL');
  return {
    name: 'Error',
    code: grpc.status.INTERNAL,
    message: 'Internal error',
    details: '',
    metadata,
  };
}

// Reverse lookup used only when the peer sent no code metadata (for
// example a server written in another language).
const CODE_FOR_STATUS = new Map<number, ErrorCode>(
  (Object.entries(STATUS_FOR) as Array<[ErrorCode, grpc.status]>).map(
    ([code, status]) => [status, code],
  ),
);

/** Turn a gRPC failure from a remote adapter into the platform's own error. */
export function fromServiceError(error: grpc.ServiceError): SethuError {
  const declared = String(error.metadata?.get(ERROR_CODE_KEY)[0] ?? '');
  const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(declared)
    ? (declared as ErrorCode)
    : error.code === grpc.status.UNAVAILABLE
      ? 'CONNECTION_FAILED'
      : (CODE_FOR_STATUS.get(error.code) ?? 'INTERNAL');
  let details: ValidationIssue[] | undefined;
  const raw = error.metadata?.get(ERROR_DETAILS_KEY)[0];
  if (code === 'VALIDATION_FAILED' && typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        details = parsed
          .filter(
            (item): item is ValidationIssue =>
              typeof item?.path === 'string' &&
              typeof item?.message === 'string',
          )
          .slice(0, 50);
      }
    } catch {
      // ignore unreadable details
    }
  }
  // A remote adapter's own words are shown for expected failures, never for internal ones or unreachable servers.
  const message =
    code === 'INTERNAL'
      ? 'The external adapter reported an internal error'
      : code === 'CONNECTION_FAILED'
        ? 'The external adapter could not be reached or could not reach its database'
        : String(error.details || error.message)
            .replace(/^\d+ [A-Z_]+: /, '')
            .slice(0, 300);
  return new SethuError(code, message, details);
}
