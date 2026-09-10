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
  Project,
  CreateDelegatedUserInput,
  DelegatedUserToken,
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
  CreateChatOptions,
  CreateOrResumeChatOptions,
  ChatCreateResult,
  UpdateChatOptions,
  ChatMessage,
  ChatComponent,
  ChatAttachment,
  ChatSendOptions,
  ChatSendInput,
  ChatMessagesQuery,
  ChatStreamOptions,
  StreamFrame,
  // streaming
  StreamHandle,
  SubscribeOptions,
  EventSourceLike,
  EventSourceCtor,
} from "./types.js";

export { defineAppExtension } from "./extensions.js";
export type { AppExtension, AppExtensionContext, AppScope, AppCredential } from "./extensions.js";
export { AppComponentRegistry } from "./components.js";
export type { AppComponentReference, AppComponentSpec, AppComponentContext } from "./components.js";
export { checkAppCompatibility, assertAppCompatibility } from "./apps.js";
export type { InstalledApp, AppRequirements, AppCompatibility } from "./apps.js";
export type { SSEEventMetadata } from "./types.js";

export { loadAppFrontend } from "./frontend.js";
export type { AppFrontendManifest, FrontendAsset, LoadAppOptions, LoadedAppFrontend } from "./frontend.js";

export type { AppAuthOptions, AuthLoginInput, AuthSignupInput, AuthUser, AuthAuthorization, AuthSessionInfo } from "./auth-session.js";
