// A COMPLETE, LEGAL chess game played through the shared arena contract on real
// devnet ER — the full trust model end-to-end:
//   arena enforces turn/membership ON-CHAIN (cheap, game-agnostic),
//   chess.js validates the rules OFF-CHAIN (replay) and derives the real winner,
//   the winner is committed back to L1.
// Game = Fool's mate (1.f3 e5 2.g4 Qh4#) → black checkmates in 4 plies.
import { describe, it, expect, beforeAll } from "vitest";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import { ArenaClient } from "../../src/arena-client";
import { encodeChessAction, replayChessActions, chessWinnerToPlayer, type ChessMove } from "../../examples/chess-arena";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadKeypair = () =>
  Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))));

describe("magic-chess: a full legal game through arena on devnet ER", () => {
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

  it("plays 1.f3 e5 2.g4 Qh4# → real checkmate, black wins, committed on-chain", async () => {
    // White = players[0], Black = players[1].
    const { gameId: gid } = await arena.registerGame(admin, "magic-chess");
    gameId = gid;
    await arena.createMatch(admin, gameId, matchId, [white.publicKey, black.publicKey], true);
    await arena.delegateMatch(admin, gameId, matchId);
    let synced = false;
    for (let i = 0; i < 25; i++) {
      if (await arena.getMatch(gameId, matchId, "er")) { synced = true; break; }
      await sleep(1500);
    }
    expect(synced).toBe(true);

    // The game, alternating turns (arena enforces turn order on-chain).
    const plies: { player: Keypair; move: ChessMove }[] = [
      { player: white, move: { from: "f2", to: "f3" } },
      { player: black, move: { from: "e7", to: "e5" } },
      { player: white, move: { from: "g2", to: "g4" } },
      { player: black, move: { from: "d8", to: "h4" } }, // Qh4#
    ];
    const actionLog: Uint8Array[] = [];
    for (const { player, move } of plies) {
      const action = encodeChessAction(move);
      await arena.submitAction(player, gameId, matchId, action);
      actionLog.push(action);
    }

    // On-chain: 4 actions recorded on the ER.
    const onEr = await arena.getMatch(gameId, matchId, "er");
    expect(Number(onEr!.actionCount)).toBe(4);

    // Off-chain validation: replay the action log through chess.js.
    const replay = replayChessActions(actionLog);
    expect(replay.legal).toBe(true);
    expect(replay.checkmate).toBe(true);
    expect(replay.winner).toBe("black");
    console.log(`  validated game: ${replay.pgn} → checkmate, winner=black`);

    // Commit the REAL result derived from the rules engine.
    const winner = chessWinnerToPlayer(replay.winner, [white.publicKey, black.publicKey])!;
    expect(winner.equals(black.publicKey)).toBe(true);
    await arena.finishMatch(admin, gameId, matchId, winner);
    await arena.commitMatch(admin, gameId, matchId);

    // Settled on L1: finished, black is the winner, 4 plies.
    let ok = false;
    for (let i = 0; i < 30; i++) {
      const m = await arena.getMatch(gameId, matchId, "l1");
      if (m && m.status === 1 && m.hasWinner && m.winner.equals(black.publicKey) && Number(m.actionCount) === 4) { ok = true; break; }
      await sleep(2000);
    }
    expect(ok).toBe(true);
  }, 180_000);

  it("rejects an ILLEGAL chess move at the validation layer", () => {
    // e2 to e5 is not a legal opening pawn move; replay must flag it.
    const bad = replayChessActions([encodeChessAction({ from: "e2", to: "e5" })]);
    expect(bad.legal).toBe(false);
  });
});
