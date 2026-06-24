import type { PublicKey, AccountMeta } from "@solana/web3.js";

/** The resolver's /game-pool/assign response for one pre-delegated ER game. */
export interface AssignedGame {
  gameId: number;
  gamePda: string;
  sessionKeySecret: number[];
  sessionKeyPublic: string;
  erRpc: string;
  aiPublicKey?: string;
}

/** Per-game wiring the SessionPoolClient needs to build move instructions. */
export interface GameDescriptor<MoveArgs = Record<string, number>> {
  programId: string;
  /** Encode a move instruction's data (Anchor discriminator + args). */
  encodeMove(args: MoveArgs): Uint8Array;
  /** Accounts for a move instruction (game PDA + session signer + any extras). */
  moveAccounts(gamePda: PublicKey, signer: PublicKey): AccountMeta[];
}

export interface FinishResult {
  winner: "white" | "black" | "draw" | string;
  moves: number;
}
