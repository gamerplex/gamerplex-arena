// Reference: how a game plugs chess into the shared arena contract.
//
// Arena stores OPAQUE action bytes + enforces turn/membership on-chain; the game
// defines (1) a move codec and (2) an off-chain replay validator. This is the
// pattern every arena game follows (PLG's battles will mirror it). The codec is
// byte-compatible with the resolver's existing chess validator
// (gamerplex-resolver/src/games/chess): from/to are 0–63 board indices
// (idx = (rank-1)*8 + file), promotion is a code (q=10, r=4, b=8, n=6).
import { Chess } from "chess.js";

const FILES = "abcdefgh";
export const idxToAlg = (idx: number): string => `${FILES[idx & 7]}${(idx >> 3) + 1}`;
export const algToIdx = (sq: string): number => (parseInt(sq[1], 10) - 1) * 8 + (sq.charCodeAt(0) - 97);

const PROMO_TO_CODE: Record<string, number> = { r: 4, n: 6, b: 8, q: 10 };
const CODE_TO_PROMO: Record<number, "r" | "n" | "b" | "q" | undefined> = {
  0: undefined, 4: "r", 5: "r", 6: "n", 7: "n", 8: "b", 9: "b", 10: "q", 11: "q",
};

export interface ChessMove {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

/** chess move → arena action bytes [fromIdx, toIdx, promoCode]. */
export const encodeChessAction = (m: ChessMove): Uint8Array =>
  Uint8Array.from([algToIdx(m.from), algToIdx(m.to), m.promotion ? PROMO_TO_CODE[m.promotion] : 0]);

/** arena action bytes → chess move. */
export const decodeChessAction = (b: Uint8Array): ChessMove => ({
  from: idxToAlg(b[0]),
  to: idxToAlg(b[1]),
  promotion: CODE_TO_PROMO[b[2]],
});

export interface ChessReplay {
  legal: boolean;
  reason?: string;
  winner: "white" | "black" | "draw" | null;
  checkmate: boolean;
  fen: string;
  pgn: string;
  plies: number;
}

/**
 * Off-chain validation (the arena trust model): replay an arena chess match's
 * action log through chess.js. Returns legality + the result. The resolver runs
 * this server-side before committing ELO/score via the arcade contract.
 */
export function replayChessActions(actions: Uint8Array[]): ChessReplay {
  const c = new Chess();
  for (let i = 0; i < actions.length; i++) {
    const mv = decodeChessAction(actions[i]);
    try {
      const res = c.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      if (!res) return fail(c, i, "illegal move");
    } catch (e: any) {
      return fail(c, i, e?.message ?? "illegal move");
    }
  }
  let winner: ChessReplay["winner"] = null;
  if (c.isCheckmate()) winner = c.turn() === "w" ? "black" : "white";
  else if (c.isGameOver()) winner = "draw";
  return { legal: true, winner, checkmate: c.isCheckmate(), fen: c.fen(), pgn: c.pgn(), plies: actions.length };
}

function fail(c: Chess, ply: number, reason: string): ChessReplay {
  return { legal: false, reason: `ply ${ply}: ${reason}`, winner: null, checkmate: false, fen: c.fen(), pgn: c.pgn(), plies: ply };
}

/** White = players[0], Black = players[1]. */
export function chessWinnerToPlayer<T>(winner: ChessReplay["winner"], players: [T, T]): T | null {
  if (winner === "white") return players[0];
  if (winner === "black") return players[1];
  return null;
}
