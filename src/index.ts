export { AptevaClient, unwrapMCP } from "./client.js";
export type { AppHandle } from "./client.js";
export { AptevaError } from "./errors.js";
export {
  readAptevaInjection,
  pickKioskKey,
  pickBaseURL,
} from "./window.js";
export type {
  AptevaClientOptions,
  AuthCarrier,
  AuthBranding,
  AuthStatus,
  AptevaAppInjection,
  MCPCallRequest,
  MCPCallResponse,
  User,
  // agents
  Agent,
  AgentMode,
  AgentGrantRule,
  AgentBoundAppGrant,
  AgentCreateInput,
  AgentCreateWarning,
  AgentCreateResult,
  AgentUpdateInput,
  AgentDeleteResult,
  AgentConfig,
  AgentSystemMCPResult,
  AgentCoreEvent,
  AgentStatus,
  AgentRestartResult,
  AgentPauseResult,
  Thread,
  ChannelInfo,
  ChatHistoryMessage,
  // telemetry
  TelemetryEvent,
  TelemetryType,
  TelemetryQuery,
  TelemetryStats,
  TelemetryPeriod,
  TimelineBucket,
  // chat
  Chat,
  ChatMessage,
  ChatComponent,
  ChatMessagesQuery,
  ChatStreamOptions,
  StreamFrame,
  // streaming
  StreamHandle,
  SubscribeOptions,
  EventSourceLike,
  EventSourceCtor,
} from "./types.js";
