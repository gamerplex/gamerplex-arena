import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AssignedGame, GameDescriptor, FinishResult } from "./types";

/**
 * Server session-pool client (Tier 3 — OPT-IN, server-trusted).
 *
 * The resolver pre-delegates game accounts to the Ephemeral Rollup and hands the
 * browser a session key to sign its own moves; the server signs the opponent
 * (e.g. AI). Gasless + zero wallet friction, but the session key is server-issued.
 * The *sovereign* path (player-signed delegation via the shared arena contract) is
 * the default; this module is the legacy chess pool, generalized from
 * magic-chess's `ChessOnChain` so any pooled ER game can reuse it until the arena
 * contract + session-keys land.
 */
export class SessionPoolClient<MoveArgs = Record<string, number>> {
  erConnection: Connection | null = null;
  sessionKey: Keypair | null = null;
  gamePda: PublicKey | null = null;
  gameId = 0;
  aiPublicKey: PublicKey | null = null;
  erRpc = "";
  private ready = false;

  constructor(
    private readonly resolverUrl: string,
    private readonly descriptor: GameDescriptor<MoveArgs>,
    private readonly adminToken: string = process.env.ADMIN_HEALTH_TOKEN || "",
  ) {}

  /** Request a free pre-delegated ER game from the resolver pool. */
  async requestGame(): Promise<boolean> {
    try {
      const res = await fetch(`${this.resolverUrl}/game-pool/assign`);
      if (!res.ok) return false;
      const text = await res.text();
      let data: { ok?: boolean; game?: AssignedGame; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        return false; // resolver returned HTML / not deployed
      }
      if (!data.ok || !data.game) return false;
      const g = data.game;
      this.gameId = g.gameId;
      this.gamePda = new PublicKey(g.gamePda);
      this.sessionKey = Keypair.fromSecretKey(new Uint8Array(g.sessionKeySecret));
      this.erConnection = new Connection(g.erRpc, "confirmed");
      this.erRpc = g.erRpc;
      this.aiPublicKey = g.aiPublicKey ? new PublicKey(g.aiPublicKey) : null;
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  get isReady(): boolean {
    return this.ready && this.erConnection !== null && this.sessionKey !== null;
  }

  /** Send the local player's move directly to the ER, signed by the session key. */
  async sendPlayerMove(args: MoveArgs): Promise<string | null> {
    if (!this.isReady) return null;
    try {
      const ix = new TransactionInstruction({
        programId: new PublicKey(this.descriptor.programId),
        keys: this.descriptor.moveAccounts(this.gamePda!, this.sessionKey!.publicKey),
        data: Buffer.from(this.descriptor.encodeMove(args)),
      });
      return await sendAndConfirmTransaction(
        this.erConnection!,
        new Transaction().add(ix),
        [this.sessionKey!],
        { skipPreflight: true },
      );
    } catch {
      return null;
    }
  }

  /** Send the server-controlled opponent's move (e.g. AI) via the resolver. */
  async sendServerMove(body: Record<string, unknown>): Promise<string | null> {
    if (!this.gamePda) return null;
    try {
      const res = await fetch(`${this.resolverUrl}/game-pool/ai-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": this.adminToken },
        body: JSON.stringify({ gamePda: this.gamePda.toBase58(), ...body }),
      });
      const data = await res.json();
      return data.ok && data.sig ? data.sig : null;
    } catch {
      return null;
    }
  }

  /** Finish the game — recycle the pool slot, optional leaderboard save. */
  async finish(playerWallet?: string, result?: FinishResult): Promise<boolean> {
    if (!this.gamePda) return false;
    try {
      const res = await fetch(`${this.resolverUrl}/game-pool/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": this.adminToken },
        body: JSON.stringify({ gamePda: this.gamePda.toBase58(), playerWallet, result }),
      });
      const data = await res.json();
      return !!data.ok;
    } catch {
      return false;
    }
  }

  static explorerUrl(sig: string, erRpc = "https://devnet.magicblock.app"): string {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(erRpc)}`;
  }
}
