// Proves the productized ArenaClient drives the full lifecycle on real devnet ER
// (same flow as arena-er.test.ts, but through the SDK — catches discriminator /
// encoding slips in the client).
import { describe, it, expect, beforeAll } from "vitest";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import { ArenaClient } from "../../src/arena-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadKeypair = () =>
  Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))));
const move = (from: number, to: number, promo = 0) => Uint8Array.from([from, to, promo]);

describe("ArenaClient — full lifecycle on devnet ER", () => {
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  let arena: ArenaClient;
  let admin: Keypair, p1: Keypair, p2: Keypair;
  let gameId = 0;
  const matchId = Date.now();

  beforeAll(async () => {
    admin = loadKeypair();
    p1 = Keypair.generate();
    p2 = Keypair.generate();
    for (const kp of [p1, p2]) {
      await sendAndConfirmTransaction(
        l1,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
        [admin],
      );
    }
    arena = new ArenaClient({ l1 });
  }, 60_000);

  it("register → match → delegate → 2 moves → finish → commit", async () => {
    const { gameId: gid } = await arena.registerGame(admin, "magic-chess");
    gameId = gid;
    await arena.createMatch(admin, gameId, matchId, [p1.publicKey, p2.publicKey], true);

    await arena.delegateMatch(admin, gameId, matchId);
    let synced = false;
    for (let i = 0; i < 25; i++) {
      if (await arena.getMatch(gameId, matchId, "er")) { synced = true; break; }
      await sleep(1500);
    }
    expect(synced).toBe(true);

    await arena.submitAction(p1, gameId, matchId, move(12, 28));
    await arena.submitAction(p2, gameId, matchId, move(52, 36));
    const onEr = await arena.getMatch(gameId, matchId, "er");
    expect(Number(onEr!.actionCount)).toBe(2);

    await arena.finishMatch(admin, gameId, matchId, p1.publicKey);
    await arena.commitMatch(admin, gameId, matchId);

    let ok = false;
    for (let i = 0; i < 30; i++) {
      const m = await arena.getMatch(gameId, matchId, "l1");
      if (m && m.status === 1 && m.hasWinner && m.winner.equals(p1.publicKey)) { ok = true; break; }
      await sleep(2000);
    }
    expect(ok).toBe(true);
  }, 180_000);
});
