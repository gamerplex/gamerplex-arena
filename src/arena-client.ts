// ArenaClient — sovereign client over the shared `arena` contract.
//
// The full lifecycle, productized from the proven devnet ER round-trip:
//   register_game → create_match → delegate_match → submit_action (ER) →
//   finish_match (ER) → commit_match (ER, settle to L1).
// Browser-safe: discriminators are precomputed (no node `crypto`), the only
// runtime dep is @solana/web3.js. Pure `ix*` builders let a wallet adapter sign;
// the async convenience methods sign with a Keypair (node / resolver / tests).

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export const ARENA_PROGRAM_ID = new PublicKey("6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const ER_RPC = "https://devnet.magicblock.app";

const REGISTRY_SEED = Buffer.from("registry");
const GAME_SEED = Buffer.from("arena_game");
const MATCH_SEED = Buffer.from("match");

// anchor discriminators — sha256("global:<ix>")[..8], precomputed.
const DISC = {
  initRegistry: Buffer.from([131, 22, 4, 103, 24, 94, 163, 239]),
  registerGame: Buffer.from([122, 44, 95, 58, 89, 33, 40, 59]),
  createMatch: Buffer.from([107, 2, 184, 145, 70, 142, 17, 165]),
  delegateMatch: Buffer.from([30, 116, 9, 69, 147, 61, 133, 238]),
  submitAction: Buffer.from([222, 59, 32, 151, 194, 137, 175, 150]),
  finishMatch: Buffer.from([65, 193, 5, 71, 16, 64, 11, 186]),
  commitMatch: Buffer.from([175, 146, 74, 234, 39, 25, 248, 114]),
};

const u64le = (n: number | bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const vecBytes = (b: Uint8Array): Buffer => Buffer.concat([u32le(b.length), Buffer.from(b)]);
const vecPubkeys = (ks: PublicKey[]): Buffer => Buffer.concat([u32le(ks.length), ...ks.map((k) => k.toBuffer())]);
const optPubkey = (k: PublicKey | null): Buffer =>
  k ? Buffer.concat([Buffer.from([1]), k.toBuffer()]) : Buffer.from([0]);

// ── PDAs ──────────────────────────────────────────────────────────────────
export const registryPda = (programId = ARENA_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync([REGISTRY_SEED], programId)[0];
export const gamePda = (gameId: number, programId = ARENA_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync([GAME_SEED, u64le(gameId)], programId)[0];
export const matchPda = (gameId: number, matchId: number | bigint, programId = ARENA_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync([MATCH_SEED, u64le(gameId), u64le(matchId)], programId)[0];

// delegation PDAs (verified against @magicblock-labs/ephemeral-rollups-sdk).
const bufferPda = (pda: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("buffer"), pda.toBuffer()], owner)[0];
const delegationRecordPda = (pda: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("delegation"), pda.toBuffer()], DELEGATION_PROGRAM_ID)[0];
const delegationMetadataPda = (pda: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), pda.toBuffer()], DELEGATION_PROGRAM_ID)[0];

export interface MatchState {
  gameId: bigint;
  matchId: bigint;
  creator: PublicKey;
  players: PublicKey[];
  turnBased: boolean;
  currentTurn: number;
  actionCount: bigint;
  status: number; // 0 active, 1 finished
  hasWinner: boolean;
  winner: PublicKey;
  lastAction: Buffer;
}

/** Decode a Match account (borsh, fixed field order). */
export function decodeMatch(data: Buffer): MatchState {
  let o = 8;
  const gameId = data.readBigUInt64LE(o); o += 8;
  const matchId = data.readBigUInt64LE(o); o += 8;
  const creator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const n = data.readUInt32LE(o); o += 4;
  const players: PublicKey[] = [];
  for (let i = 0; i < n; i++) { players.push(new PublicKey(data.subarray(o, o + 32))); o += 32; }
  const turnBased = data[o] === 1; o += 1;
  const currentTurn = data[o]; o += 1;
  const actionCount = data.readBigUInt64LE(o); o += 8;
  const status = data[o]; o += 1;
  const hasWinner = data[o] === 1; o += 1;
  const winner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const len = data.readUInt32LE(o); o += 4;
  const lastAction = Buffer.from(data.subarray(o, o + len));
  return { gameId, matchId, creator, players, turnBased, currentTurn, actionCount, status, hasWinner, winner, lastAction };
}

export class ArenaClient {
  readonly l1: Connection;
  readonly er: Connection;
  readonly programId: PublicKey;

  constructor(opts: { l1: Connection; er?: Connection; programId?: PublicKey }) {
    this.l1 = opts.l1;
    this.er = opts.er ?? new Connection(ER_RPC, "confirmed");
    this.programId = opts.programId ?? ARENA_PROGRAM_ID;
  }

  // ── instruction builders (pure — sign with any wallet) ────────────────────
  ixCreateMatch(admin: PublicKey, gameId: number, matchId: number | bigint, players: PublicKey[], turnBased: boolean): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda(this.programId), isSigner: false, isWritable: false },
        { pubkey: gamePda(gameId, this.programId), isSigner: false, isWritable: true },
        { pubkey: matchPda(gameId, matchId, this.programId), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISC.createMatch, u64le(gameId), u64le(matchId), vecPubkeys(players), Buffer.from([turnBased ? 1 : 0])]),
    });
  }

  ixDelegateMatch(payer: PublicKey, gameId: number, matchId: number | bigint): TransactionInstruction {
    const mp = matchPda(gameId, matchId, this.programId);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: bufferPda(mp, this.programId), isSigner: false, isWritable: true },
        { pubkey: delegationRecordPda(mp), isSigner: false, isWritable: true },
        { pubkey: delegationMetadataPda(mp), isSigner: false, isWritable: true },
        { pubkey: mp, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISC.delegateMatch, u64le(gameId), u64le(matchId)]),
    });
  }

  ixSubmitAction(player: PublicKey, gameId: number, matchId: number | bigint, action: Uint8Array): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: matchPda(gameId, matchId, this.programId), isSigner: false, isWritable: true },
        { pubkey: player, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([DISC.submitAction, u64le(gameId), u64le(matchId), vecBytes(action)]),
    });
  }

  ixFinishMatch(creator: PublicKey, gameId: number, matchId: number | bigint, winner: PublicKey | null): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: matchPda(gameId, matchId, this.programId), isSigner: false, isWritable: true },
        { pubkey: creator, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([DISC.finishMatch, u64le(gameId), u64le(matchId), optPubkey(winner)]),
    });
  }

  ixCommitMatch(payer: PublicKey, gameId: number, matchId: number | bigint): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: matchPda(gameId, matchId, this.programId), isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([DISC.commitMatch, u64le(gameId), u64le(matchId)]),
    });
  }

  // ── convenience senders (Keypair) ─────────────────────────────────────────
  private send(conn: Connection, ix: TransactionInstruction, signers: Keypair[]): Promise<string> {
    return sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, { skipPreflight: true, commitment: "confirmed" });
  }

  /** One-time registry bootstrap (admin = deployer; call atomically post-deploy). */
  async initRegistry(admin: Keypair): Promise<string> {
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda(this.programId), isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: DISC.initRegistry,
    });
    return this.send(this.l1, ix, [admin]);
  }

  /** Register a game; returns the allocated game_id (read from the registry). */
  async registerGame(admin: Keypair, slug: string): Promise<{ sig: string; gameId: number; gamePda: PublicKey }> {
    const reg = await this.l1.getAccountInfo(registryPda(this.programId));
    if (!reg) throw new Error("registry not initialized");
    const gameId = Number(reg.data.readBigUInt64LE(8 + 32)); // disc + admin
    const gp = gamePda(gameId, this.programId);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda(this.programId), isSigner: false, isWritable: true },
        { pubkey: gp, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISC.registerGame, vecBytes(Buffer.from(slug, "utf8"))]),
    });
    const sig = await this.send(this.l1, ix, [admin]);
    return { sig, gameId, gamePda: gp };
  }

  createMatch(admin: Keypair, gameId: number, matchId: number | bigint, players: PublicKey[], turnBased = true): Promise<string> {
    return this.send(this.l1, this.ixCreateMatch(admin.publicKey, gameId, matchId, players, turnBased), [admin]);
  }
  delegateMatch(payer: Keypair, gameId: number, matchId: number | bigint): Promise<string> {
    return this.send(this.l1, this.ixDelegateMatch(payer.publicKey, gameId, matchId), [payer]);
  }
  submitAction(player: Keypair, gameId: number, matchId: number | bigint, action: Uint8Array): Promise<string> {
    return this.send(this.er, this.ixSubmitAction(player.publicKey, gameId, matchId, action), [player]);
  }
  finishMatch(creator: Keypair, gameId: number, matchId: number | bigint, winner: PublicKey | null): Promise<string> {
    return this.send(this.er, this.ixFinishMatch(creator.publicKey, gameId, matchId, winner), [creator]);
  }
  commitMatch(payer: Keypair, gameId: number, matchId: number | bigint): Promise<string> {
    return this.send(this.er, this.ixCommitMatch(payer.publicKey, gameId, matchId), [payer]);
  }

  /** Read the match state from L1 (default) or the ER. */
  async getMatch(gameId: number, matchId: number | bigint, from: "l1" | "er" = "l1"): Promise<MatchState | null> {
    const info = await (from === "er" ? this.er : this.l1).getAccountInfo(matchPda(gameId, matchId, this.programId));
    return info ? decodeMatch(info.data) : null;
  }
}
