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
} from "./types.js";
