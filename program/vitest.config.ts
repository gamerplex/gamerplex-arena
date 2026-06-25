import { defineConfig } from "vitest/config";

// Devnet suites share one admin wallet and allocate sequential game_ids via
// register_game; running test FILES in parallel races them (two reads of the same
// next_game_id → colliding game PDA). Force sequential files. Per-test devnet ops
// are slow, so allow generous timeouts.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
