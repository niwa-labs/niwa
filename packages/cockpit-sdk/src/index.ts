// The SDK of cockpit modules: the plugin contract, the host as the browser reaches it, the live
// record stream, and the React parts a module renders with.

export { matchRecord, type RecordMatch, type StoredRecord } from "./records.ts";
export { serverEvents, textChunks, type ServerEvent } from "./sse.ts";
export {
  HostCallError,
  httpHostClient,
  type ActionRefLike,
  type CallOptions,
  type FollowOptions,
  type HostClient,
  type HostInfo,
  type HttpHostClientOptions,
  type TypedSchema,
} from "./host-client.ts";
export {
  createRecordStream,
  defineProjection,
  recordList,
  type Projection,
  type RecordStream,
  type RecordStreamOptions,
  type StreamState,
  type StreamStatus,
} from "./record-stream.ts";
