#!/usr/bin/env bash
# Localnet arena test runner: boots solana-test-validator with the arena program
# loaded, runs the vitest integration suite, tears down. Covers the L1 +
# game-agnostic flow (registry / match / turn-enforced submit_action). The ER
# round-trip (delegate_match / finalize) needs the MagicBlock validator (devnet).
set -euo pipefail
cd "$(dirname "$0")/.."
ARENA_ID=6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR
SO=target/deploy/arena.so
pkill -f solana-test-validator 2>/dev/null || true; sleep 2
rm -rf test-ledger
solana-test-validator --reset --quiet --bpf-program "$ARENA_ID" "$SO" --ledger test-ledger \
  > /tmp/arena-localnet-validator.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break; sleep 1
done
npx vitest run tests/arena.test.ts "$@"
