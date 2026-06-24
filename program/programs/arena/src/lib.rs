// Gamerplex Arena — shared on-chain lobby + Ephemeral-Rollup match contract.
//
// Games register (game_id, like the arcade contract) and play live PvP matches
// here; rules are validated OFF-CHAIN by the resolver (replay), same trust model
// as arcade — so the contract is game-agnostic and onboarding is cheap. Modeled
// on MagicBlock's rock-paper-scissor + magic-chess delegation pattern.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("6efiRKPtXWCdDTTgH2Qog6BGqbcSBgoLra33UXkGQ3AR");

const REGISTRY_SEED: &[u8] = b"registry";
const GAME_SEED: &[u8] = b"arena_game";
const MATCH_SEED: &[u8] = b"match";
const MAX_SLUG: usize = 32;
const MAX_PLAYERS: usize = 4;
const MAX_ACTION: usize = 256;

const STATUS_ACTIVE: u8 = 0;
const STATUS_FINISHED: u8 = 1;

#[ephemeral]
#[program]
pub mod arena {
    use super::*;

    /// One-time: create the global registry (admin owns game-id allocation).
    pub fn init_registry(ctx: Context<InitRegistry>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.admin = ctx.accounts.admin.key();
        r.next_game_id = 1;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Register a game → allocate the next game_id. Admin-gated (decentralize later).
    pub fn register_game(ctx: Context<RegisterGame>, slug: String) -> Result<()> {
        require!(slug.len() <= MAX_SLUG, ArenaError::SlugTooLong);
        let g = &mut ctx.accounts.game;
        g.game_id = ctx.accounts.registry.next_game_id;
        g.slug = slug;
        g.matches_created = 0;
        g.bump = ctx.bumps.game;
        let r = &mut ctx.accounts.registry;
        r.next_game_id = r.next_game_id.checked_add(1).ok_or(ArenaError::Overflow)?;
        Ok(())
    }

    /// Create a match for game_id between players (L1). Off-chain matchmaking
    /// (resolver) pairs players and calls this.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        game_id: u64,
        match_id: u64,
        players: Vec<Pubkey>,
        turn_based: bool,
    ) -> Result<()> {
        require!(
            players.len() >= 2 && players.len() <= MAX_PLAYERS,
            ArenaError::BadPlayerCount
        );
        // No duplicate players (A-5).
        for i in 0..players.len() {
            for j in (i + 1)..players.len() {
                require!(players[i] != players[j], ArenaError::DuplicatePlayer);
            }
        }
        let m = &mut ctx.accounts.match_account;
        m.game_id = game_id;
        m.match_id = match_id;
        m.creator = ctx.accounts.admin.key();
        m.players = players;
        m.turn_based = turn_based;
        m.current_turn = 0;
        m.action_count = 0;
        m.status = STATUS_ACTIVE;
        m.has_winner = false;
        m.winner = Pubkey::default();
        m.last_action = Vec::new();
        m.bump = ctx.bumps.match_account;
        let g = &mut ctx.accounts.game;
        g.matches_created = g.matches_created.checked_add(1).ok_or(ArenaError::Overflow)?;
        Ok(())
    }

    /// Delegate the match account to the Ephemeral Rollup for low-latency play.
    pub fn delegate_match(ctx: Context<DelegateMatch>, game_id: u64, match_id: u64) -> Result<()> {
        ctx.accounts.delegate_match_account(
            &ctx.accounts.payer,
            &[MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()],
            DelegateConfig::default(),
        )?;
        Ok(())
    }

    /// Submit an OPAQUE action (runs on the ER). Turn-order + membership enforced;
    /// game rules are NOT validated on-chain — the resolver replay-validates.
    pub fn submit_action(
        ctx: Context<SubmitAction>,
        _game_id: u64,
        _match_id: u64,
        action: Vec<u8>,
    ) -> Result<()> {
        require!(action.len() <= MAX_ACTION, ArenaError::ActionTooLong);
        let m = &mut ctx.accounts.match_account;
        require!(m.status == STATUS_ACTIVE, ArenaError::MatchNotActive);
        let signer = ctx.accounts.player.key();
        let idx = m
            .players
            .iter()
            .position(|p| *p == signer)
            .ok_or(ArenaError::NotAPlayer)?;
        if m.turn_based {
            require!(idx as u8 == m.current_turn, ArenaError::NotYourTurn);
            m.current_turn = ((idx + 1) % m.players.len()) as u8;
        }
        m.last_action = action;
        m.action_count = m.action_count.checked_add(1).ok_or(ArenaError::Overflow)?;
        Ok(())
    }

    /// Report the result (ER write, by the match creator/server). Separate from
    /// the commit so the commit ix performs NO account write — anchor's exit must
    /// not re-serialize a committing/undelegating account.
    pub fn finish_match(
        ctx: Context<FinishMatch>,
        _game_id: u64,
        _match_id: u64,
        winner: Option<Pubkey>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        require!(m.status == STATUS_ACTIVE, ArenaError::MatchNotActive);
        m.status = STATUS_FINISHED;
        if let Some(w) = winner {
            require!(m.players.iter().any(|p| *p == w), ArenaError::WinnerNotAPlayer);
            m.has_winner = true;
            m.winner = w;
        }
        Ok(())
    }

    /// Commit + undelegate the match back to L1. NO field writes here (the result
    /// was set by finish_match); the resolver replay-validates the action log,
    /// then score/ELO commits via the arcade contract.
    pub fn commit_match(ctx: Context<CommitMatch>, _game_id: u64, _match_id: u64) -> Result<()> {
        // A-2: only a FINISHED match may be undelegated — blocks griefing a live
        // match off the ER. finish_match is creator-gated, so only the resolver
        // can reach this state. Read-only deserialize; drop the borrow before CPI.
        {
            let data = ctx.accounts.match_account.try_borrow_data()?;
            let m = Match::try_deserialize(&mut &data[..])?;
            require!(m.status == STATUS_FINISHED, ArenaError::MatchNotFinished);
        }
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.match_account.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterGame<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump, has_one = admin @ ArenaError::AdminOnly)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = admin,
        space = 8 + ArenaGame::INIT_SPACE,
        seeds = [GAME_SEED, &registry.next_game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, ArenaGame>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64, match_id: u64)]
pub struct CreateMatch<'info> {
    // A-1: match creation is admin (resolver) gated — prevents match-PDA squatting
    // and junk matches. The resolver pairs players off-chain and creates the match.
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump, has_one = admin @ ArenaError::AdminOnly)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, ArenaGame>,
    #[account(
        init,
        payer = admin,
        space = 8 + Match::INIT_SPACE,
        seeds = [MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()],
        bump
    )]
    pub match_account: Account<'info, Match>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(game_id: u64, match_id: u64)]
pub struct DelegateMatch<'info> {
    /// CHECK: the match PDA being delegated. UncheckedAccount (not Account<Match>)
    /// so anchor does NOT re-serialize on exit — the `del` CPI reassigns it to the
    /// delegation program mid-ix, and a typed-account exit-write would fail with
    /// "modified data of an account it does not own". A-4: seeds still validate the
    /// PDA (safe on UncheckedAccount — no exit write).
    #[account(mut, del, seeds = [MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()], bump)]
    pub match_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64, match_id: u64)]
pub struct SubmitAction<'info> {
    #[account(mut, seeds = [MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()], bump = match_account.bump)]
    pub match_account: Account<'info, Match>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64, match_id: u64)]
pub struct FinishMatch<'info> {
    #[account(
        mut,
        seeds = [MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()],
        bump = match_account.bump,
        has_one = creator @ ArenaError::NotCreator
    )]
    pub match_account: Account<'info, Match>,
    pub creator: Signer<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(game_id: u64, match_id: u64)]
pub struct CommitMatch<'info> {
    /// CHECK: delegated match PDA. UncheckedAccount so anchor does NOT re-serialize
    /// on exit — commit_and_undelegate marks it undelegating; a typed exit-write
    /// would fail with ExternalAccountDataModified.
    #[account(mut, seeds = [MATCH_SEED, &game_id.to_le_bytes(), &match_id.to_le_bytes()], bump)]
    pub match_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

// ── State ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub admin: Pubkey,
    pub next_game_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ArenaGame {
    pub game_id: u64,
    #[max_len(MAX_SLUG)]
    pub slug: String,
    pub matches_created: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub game_id: u64,
    pub match_id: u64,
    pub creator: Pubkey,
    #[max_len(MAX_PLAYERS)]
    pub players: Vec<Pubkey>,
    pub turn_based: bool,
    pub current_turn: u8,
    pub action_count: u64,
    pub status: u8,
    pub has_winner: bool,
    pub winner: Pubkey,
    #[max_len(MAX_ACTION)]
    pub last_action: Vec<u8>,
    pub bump: u8,
}

#[error_code]
pub enum ArenaError {
    #[msg("Only the registry admin may do this.")]
    AdminOnly,
    #[msg("Slug too long.")]
    SlugTooLong,
    #[msg("A match needs 2..=4 players.")]
    BadPlayerCount,
    #[msg("Action exceeds the max length.")]
    ActionTooLong,
    #[msg("Match is not active.")]
    MatchNotActive,
    #[msg("Signer is not a player in this match.")]
    NotAPlayer,
    #[msg("Not your turn.")]
    NotYourTurn,
    #[msg("Only the match creator may finish it.")]
    NotCreator,
    #[msg("Duplicate player in the match.")]
    DuplicatePlayer,
    #[msg("Winner must be one of the players.")]
    WinnerNotAPlayer,
    #[msg("Match is not finished.")]
    MatchNotFinished,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
