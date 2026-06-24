// arena ↔ magic-chess integration (localnet L1).
// Chess moves are encoded as OPAQUE arena action bytes [from, to, promotion];
// arena enforces turn order + membership; chess rules are validated off-chain.
import { describe, it, beforeAll, expect } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, SystemProgram } from "@solana/web3.js";
import idl from "../target/idl/arena.json";

const ARENA_ID = new PublicKey("6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const REGISTRY_SEED = Buffer.from("registry");
const GAME_SEED = Buffer.from("arena_game");
const MATCH_SEED = Buffer.from("match");

const u64le = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
// chess move → opaque arena action
const move = (from: number, to: number, promo = 0): Buffer => Buffer.from([from, to, promo]);

async function fund(kp: Keypair) {
  const sig = await conn.requestAirdrop(kp.publicKey, 2_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
}

describe("arena ↔ magic-chess (localnet L1)", () => {
  let program: anchor.Program;
  let admin: Keypair, p1: Keypair, p2: Keypair;
  let registryPda: PublicKey, gamePda: PublicKey, matchPda: PublicKey;
  const gameId = 1;
  const matchId = 1;

  beforeAll(async () => {
    admin = Keypair.generate();
    p1 = Keypair.generate();
    p2 = Keypair.generate();
    await fund(admin);
    await fund(p1);
    await fund(p2);
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
    program = new anchor.Program(idl as anchor.Idl, provider);
    [registryPda] = PublicKey.findProgramAddressSync([REGISTRY_SEED], ARENA_ID);
    [gamePda] = PublicKey.findProgramAddressSync([GAME_SEED, u64le(gameId)], ARENA_ID);
    [matchPda] = PublicKey.findProgramAddressSync([MATCH_SEED, u64le(gameId), u64le(matchId)], ARENA_ID);
  });

  it("init_registry + register_game(magic-chess) → game_id 1", async () => {
    await program.methods
      .initRegistry()
      .accounts({ registry: registryPda, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    await program.methods
      .registerGame("magic-chess")
      .accounts({ registry: registryPda, game: gamePda, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const game: any = await (program.account as any).arenaGame.fetch(gamePda);
    expect(Number(game.gameId)).toBe(1);
    expect(game.slug).toBe("magic-chess");
  });

  it("create_match (2 players, turn-based) + chess moves via submit_action", async () => {
    await program.methods
      .createMatch(new anchor.BN(gameId), new anchor.BN(matchId), [p1.publicKey, p2.publicKey], true)
      .accounts({ registry: registryPda, game: gamePda, matchAccount: matchPda, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    // p1 (white) e2-e4: 12→28 ; p2 (black) e7-e5: 52→36
    await program.methods
      .submitAction(new anchor.BN(gameId), new anchor.BN(matchId), move(12, 28))
      .accounts({ matchAccount: matchPda, player: p1.publicKey })
      .signers([p1])
      .rpc();
    await program.methods
      .submitAction(new anchor.BN(gameId), new anchor.BN(matchId), move(52, 36))
      .accounts({ matchAccount: matchPda, player: p2.publicKey })
      .signers([p2])
      .rpc();
    const m: any = await (program.account as any).match.fetch(matchPda);
    expect(Number(m.actionCount)).toBe(2);
    expect(m.currentTurn).toBe(0); // back to p1 after both moved
    expect(Buffer.from(m.lastAction).equals(move(52, 36))).toBe(true);
  });

  it("rejects an out-of-turn move (turn enforcement)", async () => {
    // it's p1's turn; p2 tries → NotYourTurn
    await expect(
      program.methods
        .submitAction(new anchor.BN(gameId), new anchor.BN(matchId), move(52, 36))
        .accounts({ matchAccount: matchPda, player: p2.publicKey })
        .signers([p2])
        .rpc(),
    ).rejects.toThrow(/NotYourTurn/);
  });

  it("rejects a non-player (membership enforcement)", async () => {
    const stranger = Keypair.generate();
    await fund(stranger);
    await expect(
      program.methods
        .submitAction(new anchor.BN(gameId), new anchor.BN(matchId), move(12, 28))
        .accounts({ matchAccount: matchPda, player: stranger.publicKey })
        .signers([stranger])
        .rpc(),
    ).rejects.toThrow(/NotAPlayer/);
  });
});
