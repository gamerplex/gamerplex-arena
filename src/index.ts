// @gamerplex/arena — live on-chain (Tier 3) gameplay for Gamerplex games.
//
// Today: the SessionPoolClient (legacy chess server-trusted pool, generalized).
// Next: the sovereign client over the shared `arena` contract (register → lobby
// → submit_action → settle) + VRF/commit-reveal helpers. See
// ENGINEERING/GAME_SDK_AND_SAVE_FLOW_DESIGN.md.

export { SessionPoolClient } from "./session-pool";
export type { AssignedGame, GameDescriptor, FinishResult } from "./types";

export const ARENA_VERSION = "0.1.0";
