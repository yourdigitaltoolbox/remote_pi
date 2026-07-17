/**
 * Public ephemeral paired-client facade.
 *
 * This subpath intentionally exports only relay-authenticated paired actions.
 * It does not expose the extension router, singleton state, profile readers,
 * private keys, or testing adapters.
 */
export {
  PairedClient,
  EphemeralClientIdentity,
  createEphemeralClientIdentity,
  type PairedClientConnectOptions,
  type LifecycleRepairRequest,
  type LifecycleStatusReply,
  type LifecycleRepairReply,
  type CompactReply,
  type LifecycleOutcome,
  type ClientErrorReply,
  type PairedActionReply,
} from "./paired_client.js";
