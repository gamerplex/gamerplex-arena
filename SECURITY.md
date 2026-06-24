# Arena — security model

Status: **v0.1, devnet only.** No funds flow through this program (matches hold no
stakes; wagering lives in a separate, opt-in contract). The surface is therefore
access-control and liveness, not value transfer.

## Trust model
- **Off-chain validation.** The contract stores opaque action bytes and enforces
  only turn order + membership. Game rules are validated off-chain by the resolver
  (replay), the same trust model as the arcade contract. The contract is game-agnostic.
- **Admin = resolver/server.** Game registration and match creation are admin-gated.
  The admin pairs players off-chain and creates the match. "Decentralize later" is a
  roadmap item (permissionless registration + on-chain matchmaking), not v0.1.
- **MagicBlock ER = infrastructure dependency, not custody.** Match state is delegated
  to the Ephemeral Rollup for low-latency play and `commit_and_undelegate`'d back to
  L1. State always settles to L1; this is liveness risk, not custodial risk.

## Invariants
- Only the registry admin may `register_game` and `create_match`.
- Only a match's `creator` (the admin that created it) may `finish_match`.
- A match may be undelegated (`commit_match`) **only after** it is `FINISHED` — a live
  match cannot be forced off the rollup by a third party.
- `submit_action` requires the signer to be a player and (when turn-based) the player
  whose turn it is.
- A winner, if set, must be one of the match players; players must be distinct.
- All counters use checked arithmetic. All accounts are PDAs validated by seeds.
- The delegated account is `UncheckedAccount` in the delegate/commit contexts so anchor
  never re-serializes an account whose ownership the delegation program has reassigned.

## Operational notes
- **Registry bootstrap.** `init_registry` makes its first caller the admin. The
  deployer must call it immediately after deploy, in the same operational step, so the
  admin is the deploy authority. (A `ProgramData`-upgrade-authority gate is the mainnet
  hardening; it is omitted in v0.1 because it is incompatible with the non-upgradeable
  localnet test loader.)
- **Rent.** Match accounts are not yet closeable; their rent is paid by the admin and
  not reclaimed. A `close_match` (post-settle refund) is a roadmap item.
- **Keys.** Program keypairs are never committed; they are held out of band as the
  upgrade authority.

## Reporting
This is pre-production. Raise issues internally.
