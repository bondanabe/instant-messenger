// Protocol types
export type {
  MessageContentType,
  MessageStatus,
  TransportMode,
  WireMessage,
  WireMediaMeta,
  RelayRegisterPayload,
  RelayEnvelope,
  RelayAck,
  TypingEvent,
  ReadReceiptEvent,
  ContactCard,
  LANPeerInfo,
  ConnectionStateChangeEvent,
  MessageDeliveryEvent,
  E2EEPayload,
  E2EEX3DHHeader,
  E2EERatchetHeader,
  PreKeyBundleWire,
  CallType,
  CallSignalType,
  CallIceCandidate,
  CallSignalPayload,
} from './protocol/types.js'

// Connection interfaces
export type { ITransport, IConnectionManager } from './connection/ITransport.js'
export { BaseConnectionManager } from './connection/ConnectionManager.js'

// Outbox utilities
export {
  calculateNextRetry,
  isOutboxExpired,
  MAX_RETRY_COUNT,
} from './queue/OutboxQueue.js'
export type { OutboxEntry } from './queue/OutboxQueue.js'
