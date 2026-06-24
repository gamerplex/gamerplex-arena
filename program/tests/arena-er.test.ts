// arena ↔ magic-chess LIVE on the MagicBlock Ephemeral Rollup (real devnet).
// Full round-trip: register chess → create match → delegate to ER → play chess
// moves ON the ER (sub-second) → finalize (commit + undelegate) back to L1.
// NO MOCKS — every tx hits devnet / the ER.
import { describe, it, expect, beforeAll } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as crypto from "crypto";
import * as fs from "fs";
import idl from "../target/idl/arena.json";

const DEVNET_RPC = "https://api.devnet.solana.com";
const ER_RPC = "https://devnet.magicblock.app";
const ARENA = new PublicKey("6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

const REGISTRY_SEED = Buffer.from("registry");
const GAME_SEED = Buffer.from("arena_game");
const MATCH_SEED = Buffer.from("match");

const disc = (name: string) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64le = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const vecBytes = (b: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};
const optPubkey = (pk: PublicKey | null) => (pk ? Buffer.concat([Buffer.from([1]), pk.toBuffer()]) : Buffer.from([0]));
const move = (from: number, to: number, promo = 0) => Buffer.from([from, to, promo]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadKeypair = () =>
  Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))));

async function fund(conn: Connection, funder: Keypair, kp: Keypair, sol: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL }),
  );
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
}

describe("arena ↔ magic-chess LIVE on devnet ER", () => {
  const l1 = new Connection(DEVNET_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  let authority: Keypair, p1: Keypair, p2: Keypair;
  let program: anchor.Program;
  let registryPda: PublicKey, gamePda: PublicKey, matchPda: PublicKey;
  let gameId = 0;
  const matchId = Date.now(); // unique per run

  beforeAll(async () => {
    authority = loadKeypair();
    p1 = Keypair.generate();
    p2 = Keypair.generate();
    await fund(l1, authority, p1, 0.05);
    await fund(l1, authority, p2, 0.05);
    const provider = new anchor.AnchorProvider(l1, new anchor.Wallet(authority), { commitment: "confirmed" });
    program = new anchor.Program(idl as anchor.Idl, provider);
    [registryPda] = PublicKey.findProgramAddressSync([REGISTRY_SEED], ARENA);
  }, 60_000);

  it("Step 1: init_registry (idempotent) + register_game(magic-chess) on L1", async () => {
    if (!(await l1.getAccountInfo(registryPda))) {
      await program.methods
        .initRegistry()
        .accounts({ registry: registryPda, admin: authority.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    }
    const reg: any = await (program.account as any).registry.fetch(registryPda);
    gameId = Number(reg.nextGameId);
    [gamePda] = PublicKey.findProgramAddressSync([GAME_SEED, u64le(gameId)], ARENA);
    [matchPda] = PublicKey.findProgramAddressSync([MATCH_SEED, u64le(gameId), u64le(matchId)], ARENA);
    await program.methods
      .registerGame("magic-chess")
      .accounts({ registry: registryPda, game: gamePda, admin: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const g: any = await (program.account as any).arenaGame.fetch(gamePda);
    expect(g.slug).toBe("magic-chess");
    console.log(`  magic-chess registered → arena game_id ${gameId}`);
  }, 60_000);

  it("Step 2: create_match (p1 vs p2, turn-based) on L1", async () => {
    await program.methods
      .createMatch(new anchor.BN(gameId), new anchor.BN(matchId), [p1.publicKey, p2.publicKey], true)
      .accounts({ registry: registryPda, game: gamePda, matchAccount: matchPda, admin: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const m: any = await (program.account as any).match.fetch(matchPda);
    expect(Number(m.actionCount)).toBe(0);
    console.log(`  match ${matchId} created`);
  }, 60_000);

  it("Step 3: delegate_match → MagicBlock ER", async () => {
    const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(matchPda, ARENA);
    const record = delegationRecordPdaFromDelegatedAccount(matchPda);
    const metadata = delegationMetadataPdaFromDelegatedAccount(matchPda);
    const data = Buffer.concat([disc("delegate_match"), u64le(gameId), u64le(matchId)]);
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: ARENA,
        keys: [
          { pubkey: buffer, isSigner: false, isWritable: true },
          { pubkey: record, isSigner: false, isWritable: true },
          { pubkey: metadata, isSigner: false, isWritable: true },
          { pubkey: matchPda, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: ARENA, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    );
    const sig = await sendAndConfirmTransaction(l1, tx, [authority], { skipPreflight: true, commitment: "confirmed" });
    expect(sig).toBeTruthy();
    let synced = false;
    for (let i = 0; i < 25; i++) {
      if (await er.getAccountInfo(matchPda)) {
        synced = true;
        break;
      }
      await sleep(1500);
    }
    expect(synced).toBe(true);
    console.log(`  delegated; ER has the match account ✓`);
  }, 120_000);

  it("Step 4: chess moves on the ER (turn-enforced, sub-second)", async () => {
    const submit = async (player: Keypair, mv: Buffer) => {
      const data = Buffer.concat([disc("submit_action"), u64le(gameId), u64le(matchId), vecBytes(mv)]);
      const tx = new Transaction().add(
        new TransactionInstruction({
          programId: ARENA,
          keys: [
            { pubkey: matchPda, isSigner: false, isWritable: true },
            { pubkey: player.publicKey, isSigner: true, isWritable: false },
          ],
          data,
        }),
      );
      return sendAndConfirmTransaction(er, tx, [player], { skipPreflight: true, commitment: "confirmed" });
    };
    await submit(p1, move(12, 28)); // white e2-e4
    await submit(p2, move(52, 36)); // black e7-e5
    await submit(p1, move(6, 21)); // white Ng1-f3
    const info = await er.getAccountInfo(matchPda);
    const m: any = program.coder.accounts.decode("match",info!.data);
    expect(Number(m.actionCount)).toBe(3);
    expect(m.currentTurn).toBe(1); // p2 to move after 3 plies
    console.log(`  3 chess moves played ON the ER ✓ (action_count=${m.actionCount})`);
  }, 120_000);

  it("Step 5: out-of-turn move rejected on the ER (turn enforcement live)", async () => {
    // p2's turn; p1 tries → NotYourTurn, even on the rollup
    const data = Buffer.concat([disc("submit_action"), u64le(gameId), u64le(matchId), vecBytes(move(0, 1))]);
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: ARENA,
        keys: [
          { pubkey: matchPda, isSigner: false, isWritable: true },
          { pubkey: p1.publicKey, isSigner: true, isWritable: false },
        ],
        data,
      }),
    );
    await expect(sendAndConfirmTransaction(er, tx, [p1], { skipPreflight: true })).rejects.toThrow();
  }, 60_000);

  it("Step 6: finish_match (result) + commit_match → undelegate back to L1", async () => {
    // finish_match: ER write of the result, by the match creator (authority)
    const finishData = Buffer.concat([disc("finish_match"), u64le(gameId), u64le(matchId), optPubkey(p1.publicKey)]);
    await sendAndConfirmTransaction(
      er,
      new Transaction().add(
        new TransactionInstruction({
          programId: ARENA,
          keys: [
            { pubkey: matchPda, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          ],
          data: finishData,
        }),
      ),
      [authority],
      { skipPreflight: true, commitment: "confirmed" },
    );
    // commit_match: no field writes, just commit + undelegate
    const commitData = Buffer.concat([disc("commit_match"), u64le(gameId), u64le(matchId)]);
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: ARENA,
        keys: [
          { pubkey: matchPda, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
        ],
        data: commitData,
      }),
    );
    const sig = await sendAndConfirmTransaction(er, tx, [authority], { skipPreflight: true, commitment: "confirmed" });
    expect(sig).toBeTruthy();
    // poll L1 until the account is undelegated (owned by arena again) + Finished
    let ok = false;
    for (let i = 0; i < 30; i++) {
      const info = await l1.getAccountInfo(matchPda);
      if (info && info.owner.equals(ARENA)) {
        const m: any = program.coder.accounts.decode("match",info.data);
        if (m.status === 1 && m.hasWinner && new PublicKey(m.winner).equals(p1.publicKey)) {
          ok = true;
          break;
        }
      }
      await sleep(2000);
    }
    expect(ok).toBe(true);
    console.log(`  match finalized + committed to L1, winner = p1 ✓`);
  }, 120_000);
});
