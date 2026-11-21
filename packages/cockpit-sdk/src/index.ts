// The SDK of cockpit modules: the plugin contract, the host as the browser reaches it, the live
// record stream, and the React parts a module renders with.

export {
  CORE_SLOTS,
  createViewer,
  definePlugin,
  entityTabSlot,
  faultMessage,
  isCockpitPlugin,
  PLUGIN_ID,
  type CockpitPlugin,
  type EntityChipProps,
  type EntityRef,
  type EntitySpec,
  type NavEntry,
  type PageProps,
  type PageSpec,
  type PluginContext,
  type PluginFault,
  type SlotContribution,
  type SlotKind,
  type SlotMap,
  type SlotName,
  type SlotPropsOf,
  type SlotSpec,
  type Viewer,
} from "./contract.ts";
export { matchPath, pathFor, pathProblem, pathShape, type PathParams, type SearchParams } from "./paths.ts";
export {
  assembleRegistry,
  draftContext,
  RegistrationError,
  runSetup,
  type CockpitRegistry,
  type EntityRegistry,
  type NavItem,
  type Owned,
  type PluginDraft,
  type RegisteredContribution,
  type RegisteredEntity,
  type RegisteredPage,
  type Services,
} from "./registry.ts";
export {
  CockpitCatalogueSchema,
  CockpitModuleSchema,
  parseCatalogue,
  type CockpitCatalogue,
  type CockpitModule,
} from "./catalogue.ts";
export { catalogueSources, DEFAULT_MODULE_TIMEOUT_MS, loadPlugins, type LoadResult, type PluginSource } from "./loader.ts";

export { isStoredRecord, matchRecord, type RecordMatch, type RecordQuery, type StoredRecord } from "./records.ts";
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
  type Wire,
} from "./host-client.ts";
export {
  createRecordStream,
  defineProjection,
  recordList,
  type Projection,
  type RecordFeed,
  type RecordStream,
  type RecordStreamOptions,
  type StreamState,
  type StreamStatus,
} from "./record-stream.ts";

export {
  CockpitContext,
  CockpitProvider,
  useCockpit,
  useHost,
  useNavigate,
  useRegistry,
  useViewer,
  type CockpitNavigator,
  type CockpitRuntime,
} from "./runtime.tsx";
export { FaultNotice, PluginBoundary, type PluginBoundaryProps } from "./boundary.tsx";
export {
  EntityLink,
  PageLink,
  PageView,
  Slot,
  SlotItem,
  SlotPart,
  useEntityHref,
  useSlot,
  type EntityLinkProps,
  type SlotProps,
} from "./slots.tsx";
export { callKey, useAction, useCall, useProjection, useStreamStatus, type UseCallOptions } from "./hooks.ts";
