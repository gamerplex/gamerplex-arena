// Two-player multiplayer e2e on real devnet ER — the exact pipeline the two
// browser tabs use, minus the wallet popup. White and Black are independent
// keypairs; each submits its OWN moves to the ER and READS the opponent's move
// back off the chain (the sync). The match creator (admin = resolver role)
// settles. Game = Fool's mate (1.f3 e5 2.g4 Qh4#) → Black wins.
import { describe, it, expect, beforeAll } from "vitest";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import { ArenaClient } from "../../src/arena-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadKeypair = () =>
  Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))));

describe("arena: two real players play + sync on devnet ER", () => {
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  let arena: ArenaClient;
  let admin: Keypair, white: Keypair, black: Keypair;
  let gameId = 0;
  const matchId = Date.now();

  beforeAll(async () => {
    admin = loadKeypair();
    white = Keypair.generate();
    black = Keypair.generate();
    for (const kp of [white, black]) {
      await sendAndConfirmTransaction(
        l1,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })),
        [admin],
      );
    }
    arena = new ArenaClient({ l1 });
  }, 60_000);

  it("matchmade game: each player reads the other's moves off the ER, then settle", async () => {
    // matchmaking (resolver role): register chess + pair White & Black into a match
    const { gameId: gid } = await arena.registerGame(admin, "magic-chess");
    gameId = gid;
    await arena.createMatch(admin, gameId, matchId, [white.publicKey, black.publicKey], true);
    await arena.delegateMatch(admin, gameId, matchId);
    let synced = false;
    for (let i = 0; i < 25; i++) { if (await arena.getMatch(gameId, matchId, "er")) { synced = true; break; } await sleep(1500); }
    expect(synced).toBe(true);

    // Fool's mate, alternating — each move by its own player; the opponent reads it back.
    const plies: { who: Keypair; mv: number[] }[] = [
      { who: white, mv: [13, 21, 0] }, // f2-f3
      { who: black, mv: [52, 36, 0] }, // e7-e5
      { who: white, mv: [14, 30, 0] }, // g2-g4
      { who: black, mv: [59, 31, 0] }, // Qd8-h4#
    ];
    let applied = 0;
    for (const { who, mv } of plies) {
      await arena.submitAction(who, gameId, matchId, Uint8Array.from(mv));
      applied++;
      // the OTHER player polls the ER and reads the exact move (the live sync)
      let seen: number[] | null = null;
      for (let i = 0; i < 12; i++) {
        const m = await arena.getMatch(gameId, matchId, "er");
        if (m && Number(m.actionCount) === applied) { seen = Array.from(m.lastAction); break; }
        await sleep(800);
      }
      expect(seen).toEqual(mv);
    }

    // settle (creator/resolver): Black won by checkmate → finish + commit to L1
    await arena.finishMatch(admin, gameId, matchId, black.publicKey);
    await arena.commitMatch(admin, gameId, matchId);
    let ok = false;
    for (let i = 0; i < 30; i++) {
      const m = await arena.getMatch(gameId, matchId, "l1");
      if (m && m.status === 1 && m.hasWinner && m.winner.equals(black.publicKey) && Number(m.actionCount) === 4) { ok = true; break; }
      await sleep(2000);
    }
    expect(ok).toBe(true);
  }, 180_000);
});
