// @gamerplex/arena — live on-chain (Tier 3) gameplay for Gamerplex games.
//
// ArenaClient: sovereign client over the shared `arena` contract (register →
// create_match → delegate → submit_action → finish → commit/settle).
// SessionPoolClient: legacy server-trusted ER pool (generalized from chess).

export { SessionPoolClient } from "./session-pool";
export type { AssignedGame, GameDescriptor, FinishResult } from "./types";

// Sovereign client over the shared `arena` contract.
export {
  ArenaClient,
  decodeMatch,
  registryPda,
  gamePda,
  matchPda,
  ARENA_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  ER_RPC,
} from "./arena-client";
export type { MatchState } from "./arena-client";

export const ARENA_VERSION = "0.1.0";
