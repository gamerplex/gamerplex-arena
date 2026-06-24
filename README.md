# @gamerplex/arena

Shared on-chain **lobby + Ephemeral-Rollup match** contract for Gamerplex games, plus
its TypeScript client. Games **register** for a `game_id` and play live PvP matches on
the shared contract — no per-game program deploy. Rules are validated off-chain by the
resolver (replay), so the contract is game-agnostic and onboarding is cheap.

Part of the shared stack: **arcade** (solo score/payment) · **arena** (live PvP, this
repo) · **cm-sdk** (wagering, separate). A game's mode picks the layer; they compose.

## Layout
- `program/` — the Anchor program (`arena`), Rust. Built with anchor `0.32.1` +
  `ephemeral-rollups-sdk 0.8.8`, pinned `Cargo.lock` (do not regenerate — see below).
- `program/tests/` — `arena.test.ts` (localnet L1) + `arena-er.test.ts` (devnet ER
  round-trip, no mocks).
- `idl/arena.json` — IDL for building a client from another game.
- `src/` — TypeScript client (`SessionPoolClient`, types).

## Program
- **Program id (devnet):** `6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR`
- **Instructions:** `init_registry`, `register_game`, `create_match`, `delegate_match`,
  `submit_action`, `finish_match`, `commit_match`.
- **PDAs:** Registry `["registry"]` · Game `["arena_game", game_id_le]` · Match
  `["match", game_id_le, match_id_le]`.

## Integration (your game, no own contract)
1. Admin `register_game(slug)` once → your `game_id`.
2. Per match (admin/resolver): `create_match(game_id, match_id, players, turn_based)`
   → `delegate_match` → players `submit_action(game_id, match_id, action_bytes)` on the
   ER → `finish_match(winner)` → `commit_match` (settle to L1).
3. Define your own `action` byte encoding + an off-chain replay validator in the resolver.

See [SECURITY.md](SECURITY.md) for the trust model and invariants.

## Build & test
```bash
cd program
anchor build                 # do NOT delete Cargo.lock — it pins solana-program 2.3.0
                             # / borsh 0.10.4 so ephemeral-rollups-sdk 0.8.8 compiles
bash tests/run.sh            # localnet L1 suite
npx vitest run tests/arena-er.test.ts   # devnet ER round-trip (needs a funded devnet wallet)
```
