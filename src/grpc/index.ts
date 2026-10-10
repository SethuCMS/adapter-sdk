/**
 * gRPC transport for the adapter protocol: a client that makes a remote adapter
 * look local, and a server that exposes any local adapter.
 */

export {
  GrpcAdapter,
  parseAddress,
  type GrpcAdapterOptions,
} from './client.js';
export {
  serveAdapter,
  type RunningServer,
  type ServeOptions,
} from './server.js';
export { PROTOCOL_VERSION } from './shared.js';
