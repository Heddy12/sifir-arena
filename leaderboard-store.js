'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');
const botCatalog = require('./bot-catalog');

const scryptAsync = promisify(crypto.scrypt);

const MODES = ['solo', 'multiplayer', 'sprint'];
const connectionString = process.env.DATABASE_URL || '';
let pool = null;
let schemaReady = false;
let lastError = null;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || crypto.randomBytes(32).toString('hex');
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SEASON_MS = 56 * 24 * 60 * 60 * 1000;
const AVATAR_KEYS = ['hero-blue', 'hero-fire', 'hero-shadow', 'hero-gold', 'mage-cyan', 'knight-red', 'star-green', 'crown-purple'];
const RANK_MODES = ['solo', 'multiplayer', 'sprint'];

function unavailableError(message) {
  const error = new Error(message || 'Leaderboard database is unavailable');
  error.code = 'LEADERBOARD_UNAVAILABLE';
  return error;
}

function normalizeProfileId(value) {
  if (typeof value !== 'string') return null;
  const profileId = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(profileId) ? profileId : null;
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim().slice(0, 20) : '';
  return name || 'Player';
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const valid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email);
  return valid && email.length <= 254 ? email : null;
}

function normalizePlayerName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_]{3,20}$/.test(name) ? name : null;
}

function normalizePassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 ? value : null;
}

function normalizeAvatar(value) {
  return AVATAR_KEYS.includes(value) ? value : 'hero-blue';
}

function normalizeBio(value) {
  if (typeof value !== 'string') return '';
  const bio = value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (/(?:https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(bio)) return null;
  return bio;
}

function rankInfo(rp, position) {
  const points = Math.max(0, Number(rp) || 0);
  if (points >= 2100 && position && position <= 50) return { key: 'times-immortal', name: 'Times Immortal', division: null };
  if (points >= 1800) return { key: 'arena-hero', name: 'Arena Hero', division: null };
  const tiers = [
    ['number-novice', 'Number Novice'],
    ['times-apprentice', 'Times Apprentice'],
    ['multiply-warrior', 'Multiply Warrior'],
    ['number-knight', 'Number Knight'],
    ['times-commander', 'Times Commander'],
    ['math-legend', 'Math Legend']
  ];
  const tierIndex = Math.min(5, Math.floor(points / 300));
  const divisionOffset = points % 300;
  const division = divisionOffset < 100 ? 'III' : (divisionOffset < 200 ? 'II' : 'I');
  return { key: tiers[tierIndex][0], name: tiers[tierIndex][1], division: division };
}

function tierFloor(rp) {
  if (rp >= 2100) return 2100;
  if (rp >= 1800) return 1800;
  return Math.floor(Math.max(0, rp) / 300) * 300;
}

function publicAccount(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    email: row.email,
    playerName: row.player_name
  };
}

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function hashPassword(password, salt) {
  const derived = await scryptAsync(password, Buffer.from(salt, 'hex'), 64, SCRYPT_OPTIONS);
  return Buffer.from(derived).toString('hex');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPasswordResetCode(accountId, code) {
  return crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(accountId + ':' + code).digest('hex');
}

function getPool() {
  if (!connectionString) throw unavailableError('DATABASE_URL is not configured');
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString,
      ssl: process.env.PGSSL_DISABLE === '1' ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    pool.on('error', function (error) {
      lastError = error;
      schemaReady = false;
      console.error('Leaderboard database connection error:', error.message);
    });
  }
  return pool;
}

async function ensureSchema() {
  if (schemaReady) return true;
  const db = getPool();
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_profiles (
        profile_id VARCHAR(80) PRIMARY KEY,
        display_name VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS leaderboard_stats (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('solo', 'multiplayer', 'sprint')),
        best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
        best_correct INTEGER NOT NULL DEFAULT 0 CHECK (best_correct >= 0),
        best_wrong INTEGER NOT NULL DEFAULT 0 CHECK (best_wrong >= 0),
        best_accuracy INTEGER NOT NULL DEFAULT 0 CHECK (best_accuracy BETWEEN 0 AND 100),
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
        achieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_id, mode)
      );

      CREATE INDEX IF NOT EXISTS leaderboard_stats_mode_idx ON leaderboard_stats(mode);

      CREATE TABLE IF NOT EXISTS player_accounts (
        account_id VARCHAR(80) PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        player_name VARCHAR(20) NOT NULL,
        player_name_key VARCHAR(20) NOT NULL UNIQUE,
        password_salt VARCHAR(64) NOT NULL,
        password_hash VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(80) NOT NULL REFERENCES player_accounts(account_id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        account_id VARCHAR(80) PRIMARY KEY REFERENCES player_accounts(account_id) ON DELETE CASCADE,
        code_hash VARCHAR(64) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS password_reset_expiry_idx ON password_reset_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS player_profile_details (
        profile_id VARCHAR(80) PRIMARY KEY REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        avatar_key VARCHAR(32) NOT NULL DEFAULT 'hero-blue',
        bio VARCHAR(80) NOT NULL DEFAULT '',
        xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
        current_win_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_win_streak >= 0),
        best_win_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_win_streak >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_mode_stats (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('solo', 'multiplayer', 'sprint')),
        games_played INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        ranked_games INTEGER NOT NULL DEFAULT 0,
        ranked_wins INTEGER NOT NULL DEFAULT 0,
        total_score INTEGER NOT NULL DEFAULT 0,
        total_correct INTEGER NOT NULL DEFAULT 0,
        total_wrong INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, mode)
      );

      CREATE TABLE IF NOT EXISTS player_table_stats (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 12),
        correct INTEGER NOT NULL DEFAULT 0,
        wrong INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, table_number)
      );

      CREATE TABLE IF NOT EXISTS player_card_stats (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        card_id VARCHAR(32) NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, card_id)
      );

      CREATE TABLE IF NOT EXISTS player_badges (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        badge_key VARCHAR(40) NOT NULL,
        earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_id, badge_key)
      );

      CREATE TABLE IF NOT EXISTS rank_seasons (
        season_id VARCHAR(40) PRIMARY KEY,
        season_number INTEGER NOT NULL UNIQUE,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_rank_stats (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        season_id VARCHAR(40) NOT NULL REFERENCES rank_seasons(season_id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('solo', 'multiplayer', 'sprint')),
        rp INTEGER NOT NULL DEFAULT 600 CHECK (rp >= 0),
        peak_rp INTEGER NOT NULL DEFAULT 600 CHECK (peak_rp >= 0),
        placement_games INTEGER NOT NULL DEFAULT 5,
        shield_tiers TEXT NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_id, season_id, mode)
      );

      CREATE INDEX IF NOT EXISTS player_rank_ladder_idx ON player_rank_stats(season_id, mode, rp DESC);

      CREATE TABLE IF NOT EXISTS player_bot_rotation (
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('multiplayer', 'sprint')),
        active BOOLEAN NOT NULL DEFAULT FALSE,
        next_bot_index INTEGER NOT NULL DEFAULT 0 CHECK (next_bot_index BETWEEN 0 AND 10),
        pending_bot_profile_id VARCHAR(80),
        cycle_number INTEGER NOT NULL DEFAULT 0 CHECK (cycle_number >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_id, mode)
      );

      CREATE TABLE IF NOT EXISTS player_match_history (
        match_id VARCHAR(80) NOT NULL,
        profile_id VARCHAR(80) NOT NULL REFERENCES leaderboard_profiles(profile_id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL CHECK (mode IN ('solo', 'multiplayer', 'sprint')),
        match_type VARCHAR(16) NOT NULL,
        ranked BOOLEAN NOT NULL DEFAULT FALSE,
        result VARCHAR(8) NOT NULL CHECK (result IN ('win', 'loss')),
        opponent_name VARCHAR(20) NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0,
        wrong INTEGER NOT NULL DEFAULT 0,
        accuracy INTEGER NOT NULL DEFAULT 0,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        xp_awarded INTEGER NOT NULL DEFAULT 0,
        rank_before INTEGER,
        rank_delta INTEGER,
        rank_after INTEGER,
        settings_json TEXT NOT NULL DEFAULT '{}',
        played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, profile_id)
      );

      CREATE INDEX IF NOT EXISTS player_match_history_profile_idx ON player_match_history(profile_id, played_at DESC);

      CREATE TABLE IF NOT EXISTS app_migrations (
        migration_key VARCHAR(80) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    schemaReady = true;
    lastError = null;
    return true;
  } catch (error) {
    lastError = error;
    schemaReady = false;
    throw unavailableError(error.message);
  }
}

async function createSession(client, accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await client.query(
    'INSERT INTO auth_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
    [hashSessionToken(token), accountId, expiresAt]
  );
  return token;
}

async function registerAccount(input) {
  const email = normalizeEmail(input && input.email);
  const playerName = normalizePlayerName(input && input.playerName);
  const password = normalizePassword(input && input.password);
  if (!email) throw authError('INVALID_EMAIL', 'Gunakan alamat emel yang sah.');
  if (!playerName) throw authError('INVALID_PLAYER_NAME', 'Player ID mesti 3-20 aksara: huruf, nombor atau _.');
  if (botCatalog.isReservedBotName(playerName)) throw authError('PLAYER_NAME_TAKEN', 'Player ID itu sudah digunakan.');
  if (!password) throw authError('INVALID_PASSWORD', 'Kata laluan mesti 8-128 aksara.');

  await ensureSchema();
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(password, salt);
  const accountId = 'acct_' + crypto.randomBytes(24).toString('hex');
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT email, player_name_key FROM player_accounts
       WHERE email = $1 OR player_name_key = $2`,
      [email, playerName.toLowerCase()]
    );
    if (existing.rows.some(function (row) { return row.email === email; })) {
      throw authError('EMAIL_TAKEN', 'Alamat emel itu sudah didaftarkan.');
    }
    if (existing.rows.some(function (row) { return row.player_name_key === playerName.toLowerCase(); })) {
      throw authError('PLAYER_NAME_TAKEN', 'Player ID itu sudah digunakan.');
    }
    const result = await client.query(
      `INSERT INTO player_accounts
        (account_id, email, player_name, player_name_key, password_salt, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING account_id, email, player_name`,
      [accountId, email, playerName, playerName.toLowerCase(), salt, passwordHash]
    );
    await ensureProfileRows(client, { profileId: accountId, name: playerName });
    const token = await createSession(client, accountId);
    await client.query('COMMIT');
    return { account: publicAccount(result.rows[0]), token: token };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    if (error.code === '23505') {
      const detail = String(error.constraint || error.detail || '').toLowerCase();
      if (detail.includes('player_name')) throw authError('PLAYER_NAME_TAKEN', 'Player ID itu sudah digunakan.');
      throw authError('EMAIL_TAKEN', 'Alamat emel itu sudah didaftarkan.');
    }
    if (error.code && (error.code.startsWith('INVALID_') || error.code === 'EMAIL_TAKEN' || error.code === 'PLAYER_NAME_TAKEN')) throw error;
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function loginAccount(input) {
  const email = normalizeEmail(input && input.email);
  const password = normalizePassword(input && input.password);
  if (!email || !password) throw authError('INVALID_CREDENTIALS', 'Emel atau kata laluan tidak betul.');

  await ensureSchema();
  const result = await getPool().query(
    `SELECT account_id, email, player_name, password_salt, password_hash
     FROM player_accounts WHERE email = $1`,
    [email]
  );
  const row = result.rows[0];
  const salt = row ? row.password_salt : '00000000000000000000000000000000';
  const expected = row ? row.password_hash : '0'.repeat(128);
  const actual = await hashPassword(password, salt);
  const matches = crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  if (!row || !matches) throw authError('INVALID_CREDENTIALS', 'Emel atau kata laluan tidak betul.');

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
    const token = await createSession(client, row.account_id);
    await client.query('COMMIT');
    return { account: publicAccount(row), token: token };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function createPasswordReset(input) {
  const email = normalizeEmail(input && input.email);
  if (!email) throw authError('INVALID_EMAIL', 'Gunakan alamat emel yang sah.');
  await ensureSchema();
  const db = getPool();
  await db.query('DELETE FROM password_reset_tokens WHERE expires_at <= NOW()');
  const accountResult = await db.query(
    'SELECT account_id, email FROM player_accounts WHERE email = $1',
    [email]
  );
  const account = accountResult.rows[0];
  if (!account) return null;
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  await db.query(
    `INSERT INTO password_reset_tokens (account_id, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, 0, $3, NOW())
     ON CONFLICT (account_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [account.account_id, hashPasswordResetCode(account.account_id, code), expiresAt]
  );
  return { email: account.email, code: code, expiresAt: expiresAt };
}

async function invalidatePasswordReset(emailValue) {
  const email = normalizeEmail(emailValue);
  if (!email) return false;
  await ensureSchema();
  await getPool().query(
    `DELETE FROM password_reset_tokens
     WHERE account_id IN (SELECT account_id FROM player_accounts WHERE email = $1)`,
    [email]
  );
  return true;
}

async function resetPassword(input) {
  const email = normalizeEmail(input && input.email);
  const code = typeof (input && input.code) === 'string' ? input.code.trim() : '';
  const password = normalizePassword(input && (input.newPassword || input.password));
  if (!email) throw authError('INVALID_EMAIL', 'Gunakan alamat emel yang sah.');
  if (!/^\d{6}$/.test(code)) throw authError('INVALID_RESET_CODE', 'Kod reset mesti mengandungi 6 digit.');
  if (!password) throw authError('INVALID_PASSWORD', 'Kata laluan mesti 8-128 aksara.');

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT a.account_id, r.code_hash, r.attempts, r.expires_at
       FROM player_accounts a
       LEFT JOIN password_reset_tokens r ON r.account_id = a.account_id
       WHERE a.email = $1 FOR UPDATE`,
      [email]
    );
    const row = result.rows[0];
    const actualHash = row ? hashPasswordResetCode(row.account_id, code) : '0'.repeat(64);
    const expectedHash = row && row.code_hash ? row.code_hash : '1'.repeat(64);
    const codeMatches = crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
    const expired = !row || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now();
    if (!row || !row.code_hash || expired || Number(row.attempts) >= 5 || !codeMatches) {
      if (row && row.code_hash) {
        if (expired || Number(row.attempts) >= 4) {
          await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [row.account_id]);
        } else {
          await client.query('UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE account_id = $1', [row.account_id]);
        }
      }
      await client.query('COMMIT');
      throw authError('INVALID_RESET_CODE', 'Kod reset tidak sah atau sudah tamat tempoh.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);
    await client.query(
      'UPDATE player_accounts SET password_salt = $2, password_hash = $3, updated_at = NOW() WHERE account_id = $1',
      [row.account_id, salt, passwordHash]
    );
    await client.query('DELETE FROM auth_sessions WHERE account_id = $1', [row.account_id]);
    await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [row.account_id]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    if (!String(error.code || '').startsWith('INVALID_')) {
      await client.query('ROLLBACK').catch(function () {});
      throw unavailableError(error.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getAccountBySession(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
  await ensureSchema();
  const result = await getPool().query(
    `SELECT a.account_id, a.email, a.player_name
     FROM auth_sessions s
     JOIN player_accounts a ON a.account_id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashSessionToken(token)]
  );
  return publicAccount(result.rows[0]);
}

async function logoutSession(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return false;
  await ensureSchema();
  await getPool().query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
  return true;
}

async function ensureCurrentSeason(client) {
  const db = client || getPool();
  let result = await db.query(
    'SELECT season_id, season_number, starts_at, ends_at FROM rank_seasons WHERE ends_at > NOW() ORDER BY season_number DESC LIMIT 1'
  );
  if (result.rows[0]) return result.rows[0];

  const previous = await db.query('SELECT season_id, season_number FROM rank_seasons ORDER BY season_number DESC LIMIT 1');
  const seasonNumber = previous.rows[0] ? Number(previous.rows[0].season_number) + 1 : 1;
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + SEASON_MS);
  const seasonId = 'season_' + seasonNumber + '_' + crypto.randomBytes(6).toString('hex');
  const inserted = await db.query(
    `INSERT INTO rank_seasons (season_id, season_number, starts_at, ends_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (season_number) DO NOTHING RETURNING season_id, season_number, starts_at, ends_at`,
    [seasonId, seasonNumber, startsAt, endsAt]
  );
  if (!inserted.rows[0]) {
    const concurrent = await db.query('SELECT season_id, season_number, starts_at, ends_at FROM rank_seasons WHERE season_number = $1', [seasonNumber]);
    return concurrent.rows[0];
  }

  if (previous.rows[0]) {
    const oldRanks = await db.query('SELECT profile_id, mode, rp FROM player_rank_stats WHERE season_id = $1', [previous.rows[0].season_id]);
    for (const row of oldRanks.rows) {
      const oldRp = Number(row.rp);
      const resetRp = oldRp < 900 ? oldRp : Math.min(1500, 900 + Math.floor((oldRp - 900) * 0.5));
      await db.query(
        `INSERT INTO player_rank_stats (profile_id, season_id, mode, rp, peak_rp, placement_games, shield_tiers)
         VALUES ($1, $2, $3, $4, $4, 5, $5) ON CONFLICT DO NOTHING`,
        [row.profile_id, seasonId, row.mode, resetRp, JSON.stringify([rankInfo(resetRp, null).key])]
      );
    }
  }
  return { season_id: seasonId, season_number: seasonNumber, starts_at: startsAt, ends_at: endsAt };
}

async function ensureProfileRows(client, profile, initialRanks) {
  const normalized = await upsertProfile(client, profile);
  const knownBot = botCatalog.BOT_PROFILES.find(function (bot) { return bot.profileId === normalized.profileId; });
  const botInitialRank = knownBot && Number.isInteger(knownBot.initialRank) ? knownBot.initialRank : null;
  await client.query(
    `INSERT INTO player_profile_details (profile_id) VALUES ($1)
     ON CONFLICT (profile_id) DO NOTHING`,
    [normalized.profileId]
  );
  const season = await ensureCurrentSeason(client);
  for (const mode of RANK_MODES) {
    const initial = initialRanks && Number.isInteger(initialRanks[mode]) ? initialRanks[mode] : (botInitialRank === null ? 600 : botInitialRank);
    await client.query(
      `INSERT INTO player_rank_stats (profile_id, season_id, mode, rp, peak_rp, placement_games, shield_tiers)
       VALUES ($1, $2, $3, $4, $4, 5, $5) ON CONFLICT DO NOTHING`,
      [normalized.profileId, season.season_id, mode, initial, JSON.stringify([rankInfo(initial, null).key])]
    );
  }
  return normalized;
}

async function initialize() {
  if (!connectionString) return false;
  await ensureSchema();
  await seedArenaBots();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const accounts = await client.query('SELECT account_id, player_name FROM player_accounts');
    for (const row of accounts.rows) {
      await ensureProfileRows(client, { profileId: row.account_id, name: row.player_name });
    }
    const unfinishedPlacements = await client.query('SELECT profile_id, season_id, mode, rp FROM player_rank_stats WHERE placement_games < 5');
    for (const row of unfinishedPlacements.rows) {
      await client.query(
        'UPDATE player_rank_stats SET placement_games = 5, shield_tiers = $4 WHERE profile_id = $1 AND season_id = $2 AND mode = $3',
        [row.profile_id, row.season_id, row.mode, JSON.stringify([rankInfo(Number(row.rp), null).key])]
      );
    }
    await client.query(
      `INSERT INTO player_mode_stats
        (profile_id, mode, games_played, wins, losses, ranked_games, ranked_wins)
       SELECT profile_id, 'multiplayer', games_played, wins, GREATEST(games_played - wins, 0), games_played, wins
       FROM leaderboard_stats WHERE mode = 'multiplayer' AND games_played > 0
       ON CONFLICT (profile_id, mode) DO NOTHING`
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
  return true;
}

async function upsertProfile(client, profile) {
  const profileId = normalizeProfileId(profile && profile.profileId);
  if (!profileId) throw new Error('A valid profile ID is required');
  const name = normalizeName(profile && profile.name);
  await client.query(
    `INSERT INTO leaderboard_profiles (profile_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (profile_id) DO UPDATE
     SET display_name = EXCLUDED.display_name, updated_at = NOW()`,
    [profileId, name]
  );
  return { profileId: profileId, name: name };
}

const BOT_SEED_RANKS = [350, 500, 650, 800, 1000, 1200, 1400, 1600, 1900, 2200];
const BOT_SEED_AVATARS = ['star-green', 'mage-cyan', 'hero-fire', 'knight-red', 'crown-purple', 'hero-blue', 'hero-shadow', 'hero-gold', 'mage-cyan', 'crown-purple'];
const BOT_SEED_BIOS = [
  'Learning one table at a time. See you in the arena!',
  'Chill player chasing a longer winning streak.',
  'Powered by roti canai and multiplication practice.',
  'Training speed, accuracy and smarter card plays.',
  'Cloudy name, focused mind. Ready for quick match.',
  'Every battle is another chance to improve.',
  'Numbers are my power. Consistency is my strategy.',
  'Fast answers, clean plays and zero lag.',
  'Always searching for the next difficult challenge.',
  'Climbing the season rank one victory at a time.'
];
const BOT_SEED_CARDS = ['shield', 'healPotion', 'revealHint', 'doubleStrike', 'timeFreeze', 'streakBoost', 'stealHP', 'secondChance', 'mirrorShield', 'skipQuestion'];

function clampNumber(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function buildBotSeed(bot, index, rank) {
  const accuracy = Math.round((bot.accuracyMin + bot.accuracyMax) * 50);
  const winRate = clampNumber(Math.round(37 + (rank - 300) * 52 / 1900), 37, 89);
  function modeStats(games, accuracyOffset) {
    const wins = Math.round(games * winRate / 100);
    const attempts = games * (7 + Math.floor(index / 3));
    const modeAccuracy = clampNumber(accuracy + accuracyOffset, 45, 98);
    const correct = Math.round(attempts * modeAccuracy / 100);
    return {
      games: games, wins: wins, losses: games - wins, correct: correct,
      wrong: attempts - correct, accuracy: modeAccuracy, score: correct * 10 + wins * 5
    };
  }
  const multiplayer = modeStats(28 + index * 7, 0);
  const sprint = modeStats(16 + index * 4, index % 2 ? 1 : -1);
  const totalGames = multiplayer.games + sprint.games;
  const totalWins = multiplayer.wins + sprint.wins;
  return {
    rank: rank,
    accuracy: accuracy,
    winRate: winRate,
    multiplayer: multiplayer,
    sprint: sprint,
    xp: totalGames * 7 + totalWins * 13,
    currentStreak: clampNumber(Math.floor((winRate - 30) / 15), 0, 5),
    bestStreak: clampNumber(2 + Math.floor((rank - 300) / 280), 2, 10),
    avatar: BOT_SEED_AVATARS[index],
    bio: BOT_SEED_BIOS[index]
  };
}

async function addBotModeSeed(client, profileId, mode, stats) {
  await client.query(
    `INSERT INTO player_mode_stats
      (profile_id, mode, games_played, wins, losses, ranked_games, ranked_wins, total_score, total_correct, total_wrong)
     VALUES ($1,$2,$3,$4,$5,$3,$4,$6,$7,$8)
     ON CONFLICT (profile_id, mode) DO UPDATE SET
       games_played = player_mode_stats.games_played + EXCLUDED.games_played,
       wins = player_mode_stats.wins + EXCLUDED.wins,
       losses = player_mode_stats.losses + EXCLUDED.losses,
       ranked_games = player_mode_stats.ranked_games + EXCLUDED.ranked_games,
       ranked_wins = player_mode_stats.ranked_wins + EXCLUDED.ranked_wins,
       total_score = player_mode_stats.total_score + EXCLUDED.total_score,
       total_correct = player_mode_stats.total_correct + EXCLUDED.total_correct,
       total_wrong = player_mode_stats.total_wrong + EXCLUDED.total_wrong`,
    [profileId, mode, stats.games, stats.wins, stats.losses, stats.score, stats.correct, stats.wrong]
  );
}

async function seedBotProfileActivity(client, bot, index, rank) {
  const seed = buildBotSeed(bot, index, rank);
  await client.query(
    `UPDATE player_profile_details SET avatar_key = $2, bio = $3,
       xp = GREATEST(xp, $4), current_win_streak = GREATEST(current_win_streak, $5),
       best_win_streak = GREATEST(best_win_streak, $6), updated_at = NOW()
     WHERE profile_id = $1`,
    [bot.profileId, seed.avatar, seed.bio, seed.xp, seed.currentStreak, seed.bestStreak]
  );
  await addBotModeSeed(client, bot.profileId, 'multiplayer', seed.multiplayer);
  await addBotModeSeed(client, bot.profileId, 'sprint', seed.sprint);
  await client.query(
    `INSERT INTO leaderboard_stats
      (profile_id, mode, wins, games_played, updated_at)
     VALUES ($1, 'multiplayer', $2, $3, NOW())
     ON CONFLICT (profile_id, mode) DO UPDATE SET
       wins = leaderboard_stats.wins + EXCLUDED.wins,
       games_played = leaderboard_stats.games_played + EXCLUDED.games_played,
       updated_at = NOW()`,
    [bot.profileId, seed.multiplayer.wins, seed.multiplayer.games]
  );
  await client.query(
    `INSERT INTO leaderboard_stats
      (profile_id, mode, best_score, best_correct, best_wrong, best_accuracy, wins, games_played, updated_at)
     VALUES ($1, 'sprint', $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (profile_id, mode) DO UPDATE SET
       best_score = GREATEST(leaderboard_stats.best_score, EXCLUDED.best_score),
       best_correct = GREATEST(leaderboard_stats.best_correct, EXCLUDED.best_correct),
       best_accuracy = GREATEST(leaderboard_stats.best_accuracy, EXCLUDED.best_accuracy),
       wins = leaderboard_stats.wins + EXCLUDED.wins,
       games_played = leaderboard_stats.games_played + EXCLUDED.games_played,
       updated_at = NOW()`,
    [bot.profileId, Math.max(80, Math.round(seed.sprint.correct / seed.sprint.games) * 10), Math.max(8, Math.round(seed.sprint.correct / seed.sprint.games)), Math.max(0, Math.round(seed.sprint.wrong / seed.sprint.games)), seed.sprint.accuracy, seed.sprint.wins, seed.sprint.games]
  );
  for (let table = 1; table <= 12; table++) {
    const attempts = 12 + index * 2 + (table % 4);
    const tableAccuracy = clampNumber(seed.accuracy + ((table * 7 + index * 3) % 9) - 4, 42, 99);
    const correct = Math.round(attempts * tableAccuracy / 100);
    await client.query(
      `INSERT INTO player_table_stats (profile_id, table_number, correct, wrong) VALUES ($1,$2,$3,$4)
       ON CONFLICT (profile_id, table_number) DO UPDATE SET
         correct = player_table_stats.correct + EXCLUDED.correct,
         wrong = player_table_stats.wrong + EXCLUDED.wrong`,
      [bot.profileId, table, correct, attempts - correct]
    );
  }
  for (let cardOffset = 0; cardOffset < 4; cardOffset++) {
    const cardId = BOT_SEED_CARDS[(index + cardOffset) % BOT_SEED_CARDS.length];
    const uses = Math.max(2, Math.round((seed.multiplayer.games + seed.sprint.games) / (5 + cardOffset)));
    await client.query(
      `INSERT INTO player_card_stats (profile_id, card_id, uses) VALUES ($1,$2,$3)
       ON CONFLICT (profile_id, card_id) DO UPDATE SET uses = player_card_stats.uses + EXCLUDED.uses`,
      [bot.profileId, cardId, uses]
    );
  }
  const badges = ['first-victory'];
  if (seed.multiplayer.wins + seed.sprint.wins >= 10) badges.push('ten-wins');
  if (seed.multiplayer.wins + seed.sprint.wins >= 50) badges.push('fifty-wins');
  if (seed.multiplayer.games + seed.sprint.games >= 100) badges.push('hundred-battles');
  if (seed.bestStreak >= 5) badges.push('hot-streak');
  if (seed.accuracy >= 90) badges.push('perfect-battle');
  if (seed.sprint.games >= 20) badges.push('sprint-star');
  for (const badge of badges) {
    await client.query('INSERT INTO player_badges (profile_id, badge_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [bot.profileId, badge]);
  }
  for (let historyIndex = 0; historyIndex < 8; historyIndex++) {
    const mode = historyIndex % 3 === 0 ? 'sprint' : 'multiplayer';
    const won = ((historyIndex * 37 + index * 13) % 100) < seed.winRate;
    const attempts = 8 + ((historyIndex + index) % 5);
    const matchAccuracy = clampNumber(seed.accuracy + ((historyIndex * 5 + index) % 7) - 3, 40, 99);
    const correct = Math.round(attempts * matchAccuracy / 100);
    const delta = won ? 12 + ((historyIndex + index) % 8) : -(9 + ((historyIndex + index) % 7));
    const rankAfter = Math.max(0, rank - historyIndex * 4);
    const opponent = botCatalog.BOT_PROFILES[(index + historyIndex + 1) % botCatalog.BOT_PROFILES.length];
    await client.query(
      `INSERT INTO player_match_history
        (match_id, profile_id, mode, match_type, ranked, result, opponent_name, score, correct, wrong,
         accuracy, duration_seconds, xp_awarded, rank_before, rank_delta, rank_after, settings_json, played_at)
       VALUES ($1,$2,$3,'quick',TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING`,
      ['bot_profile_seed_v1_' + index + '_' + historyIndex, bot.profileId, mode, won ? 'win' : 'loss', opponent.name,
        correct * 10, correct, attempts - correct, matchAccuracy, mode === 'sprint' ? 60 : 42 + historyIndex,
        won ? 24 : 12, Math.max(0, rankAfter - delta), delta, rankAfter,
        JSON.stringify({ timer: mode === 'multiplayer' ? 6 : 20, sifir: 0, difficulty: 'random', sprintTime: 60 }),
        new Date(Date.now() - (historyIndex + 1) * 86400000)]
    );
  }
}

async function seedArenaBots() {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < botCatalog.BOT_PROFILES.length; index++) {
      const bot = botCatalog.BOT_PROFILES[index];
      const originalIndex = botCatalog.MATCHMAKING_BOTS.indexOf(bot);
      const initialRank = Number.isInteger(bot.initialRank) ? bot.initialRank : BOT_SEED_RANKS[originalIndex];
      const profile = await ensureProfileRows(client, bot, { solo: initialRank, multiplayer: initialRank, sprint: initialRank });
      if (bot.league) {
        await client.query(
          `UPDATE player_profile_details
           SET avatar_key = $2, bio = $3, updated_at = NOW()
           WHERE profile_id = $1 AND bio = ''`,
          [profile.profileId, BOT_SEED_AVATARS[index % BOT_SEED_AVATARS.length], 'Strong challenger. Starting from the lowest rank and earning every point.']
        );
      }
      for (const mode of ['multiplayer', 'sprint']) {
        await client.query(
          `INSERT INTO leaderboard_stats (profile_id, mode, wins, games_played, updated_at)
           VALUES ($1, $2, 0, 0, NOW())
           ON CONFLICT (profile_id, mode) DO NOTHING`,
          [profile.profileId, mode]
        );
      }
    }
    const activitySeeded = await client.query("SELECT 1 FROM app_migrations WHERE migration_key = 'bot_profile_activity_v1'");
    if (!activitySeeded.rows[0]) {
      const season = await ensureCurrentSeason(client);
      for (let index = 0; index < botCatalog.MATCHMAKING_BOTS.length; index++) {
        const bot = botCatalog.MATCHMAKING_BOTS[index];
        const rankResult = await client.query(
          `SELECT rp FROM player_rank_stats WHERE profile_id = $1 AND season_id = $2 AND mode = 'multiplayer'`,
          [bot.profileId, season.season_id]
        );
        const rank = rankResult.rows[0] ? Number(rankResult.rows[0].rp) : BOT_SEED_RANKS[index];
        await seedBotProfileActivity(client, bot, index, rank);
      }
      await client.query("INSERT INTO app_migrations (migration_key) VALUES ('bot_profile_activity_v1')");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

function isBetterResult(mode, next, current) {
  if (!current) return true;
  if (mode === 'solo') {
    if (next.score !== current.best_score) return next.score > current.best_score;
    if (next.accuracy !== current.best_accuracy) return next.accuracy > current.best_accuracy;
    return next.correct > current.best_correct;
  }
  if (next.correct !== current.best_correct) return next.correct > current.best_correct;
  if (next.accuracy !== current.best_accuracy) return next.accuracy > current.best_accuracy;
  return next.wrong < current.best_wrong;
}

async function recordBest(profile, mode, stats) {
  if (mode !== 'solo' && mode !== 'sprint') throw new Error('Unsupported best-result mode');
  await ensureSchema();
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const normalizedProfile = await upsertProfile(client, profile);
    const result = await client.query(
      `SELECT best_score, best_correct, best_wrong, best_accuracy
       FROM leaderboard_stats WHERE profile_id = $1 AND mode = $2 FOR UPDATE`,
      [normalizedProfile.profileId, mode]
    );
    const current = result.rows[0] || null;
    const better = isBetterResult(mode, stats, current);
    if (better) {
      await client.query(
        `INSERT INTO leaderboard_stats
          (profile_id, mode, best_score, best_correct, best_wrong, best_accuracy, achieved_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (profile_id, mode) DO UPDATE SET
           best_score = EXCLUDED.best_score,
           best_correct = EXCLUDED.best_correct,
           best_wrong = EXCLUDED.best_wrong,
           best_accuracy = EXCLUDED.best_accuracy,
           achieved_at = NOW(),
           updated_at = NOW()`,
        [normalizedProfile.profileId, mode, stats.score, stats.correct, stats.wrong, stats.accuracy]
      );
    }
    await client.query('COMMIT');
    return { recorded: true, improved: better };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    if (error.code === 'LEADERBOARD_UNAVAILABLE') throw error;
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function recordMultiplayerGame(participants) {
  await ensureSchema();
  const valid = (Array.isArray(participants) ? participants : []).filter(function (participant) {
    return normalizeProfileId(participant && participant.profileId);
  });
  if (valid.length === 0) throw new Error('No valid leaderboard profiles');
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const participant of valid) {
      const profile = await upsertProfile(client, participant);
      await client.query(
        `INSERT INTO leaderboard_stats (profile_id, mode, wins, games_played, updated_at)
         VALUES ($1, 'multiplayer', $2, 1, NOW())
         ON CONFLICT (profile_id, mode) DO UPDATE SET
           wins = leaderboard_stats.wins + EXCLUDED.wins,
           games_played = leaderboard_stats.games_played + 1,
           updated_at = NOW()`,
        [profile.profileId, participant.winner ? 1 : 0]
      );
    }
    await client.query('COMMIT');
    return { recorded: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    if (error.code === 'LEADERBOARD_UNAVAILABLE') throw error;
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function getLeaderboard(mode, limit) {
  if (!MODES.includes(mode)) throw new Error('Invalid leaderboard mode');
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  let orderBy;
  if (mode === 'solo') {
    orderBy = 's.best_score DESC, s.best_accuracy DESC, s.best_correct DESC, s.achieved_at ASC';
  } else if (mode === 'sprint') {
    orderBy = 's.best_correct DESC, s.best_accuracy DESC, s.best_wrong ASC, s.achieved_at ASC';
  } else {
    orderBy = 's.wins DESC, CASE WHEN s.games_played > 0 THEN s.wins::numeric / s.games_played ELSE 0 END DESC, s.games_played ASC, s.updated_at ASC';
  }
  const result = await getPool().query(
    `SELECT p.display_name, s.best_score, s.best_correct, s.best_wrong, s.best_accuracy,
            s.wins, s.games_played,
            CASE WHEN s.games_played > 0 THEN (s.wins * 100.0) / s.games_played ELSE 0 END AS win_rate
     FROM leaderboard_stats s
     JOIN leaderboard_profiles p ON p.profile_id = s.profile_id
     WHERE s.mode = $1
     ORDER BY ${orderBy}
     LIMIT $2`,
    [mode, safeLimit]
  );
  return result.rows.map(function (row, index) {
    return {
      rank: index + 1,
      name: row.display_name,
      score: Number(row.best_score),
      correct: Number(row.best_correct),
      wrong: Number(row.best_wrong),
      accuracy: Number(row.best_accuracy),
      wins: Number(row.wins),
      gamesPlayed: Number(row.games_played),
      winRate: Math.round(Number(row.win_rate))
    };
  });
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (error) { return fallback; }
}

async function rankPosition(client, seasonId, mode, profileId, rp) {
  const result = await client.query(
    `SELECT COUNT(*) AS better FROM player_rank_stats
     WHERE season_id = $1 AND mode = $2 AND (rp > $3 OR (rp = $3 AND profile_id < $4))`,
    [seasonId, mode, rp, profileId]
  );
  return Number(result.rows[0].better) + 1;
}

async function getRankedLadder(mode, limit) {
  if (!RANK_MODES.includes(mode)) throw new Error('Invalid rank mode');
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const season = await ensureCurrentSeason(client);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const result = await client.query(
      `SELECT r.profile_id, p.display_name, d.avatar_key, r.rp, r.peak_rp
       FROM player_rank_stats r
       JOIN leaderboard_profiles p ON p.profile_id = r.profile_id
       LEFT JOIN player_profile_details d ON d.profile_id = r.profile_id
       WHERE r.season_id = $1 AND r.mode = $2
       ORDER BY r.rp DESC, r.updated_at ASC, r.profile_id ASC LIMIT $3`,
      [season.season_id, mode, safeLimit]
    );
    return {
      season: { number: Number(season.season_number), startsAt: season.starts_at, endsAt: season.ends_at },
      entries: result.rows.map(function (row, index) {
        const info = rankInfo(Number(row.rp), index + 1);
        return {
          rank: index + 1,
          name: row.display_name,
          avatarKey: row.avatar_key || 'hero-blue',
          rp: Number(row.rp),
          peakRp: Number(row.peak_rp),
          tier: info.name,
          division: info.division
        };
      })
    };
  } finally {
    client.release();
  }
}

async function getRankSnapshot(profileId, mode) {
  if (!normalizeProfileId(profileId) || !RANK_MODES.includes(mode)) return null;
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const season = await ensureCurrentSeason(client);
    const result = await client.query(
      'SELECT rp, peak_rp FROM player_rank_stats WHERE profile_id = $1 AND season_id = $2 AND mode = $3',
      [profileId, season.season_id, mode]
    );
    const row = result.rows[0];
    if (!row) return { rp: 600, peakRp: 600, position: null, tier: 'Multiply Warrior', division: 'III' };
    const position = await rankPosition(client, season.season_id, mode, profileId, Number(row.rp));
    const info = rankInfo(Number(row.rp), position);
    return {
      rp: Number(row.rp), peakRp: Number(row.peak_rp), position: position, tier: info.name, division: info.division
    };
  } finally {
    client.release();
  }
}

function normalizeRotationMode(mode) {
  return mode === 'sprint' ? 'sprint' : (mode === 'multiplayer' ? 'multiplayer' : null);
}

function rotationState(row) {
  const rotationBots = botCatalog.MATCHMAKING_BOTS;
  const index = row ? Math.max(0, Math.min(rotationBots.length, Number(row.next_bot_index) || 0)) : 0;
  const active = !!(row && row.active && index < rotationBots.length);
  const pending = active && row.pending_bot_profile_id
    ? rotationBots.find(function (bot) { return bot.profileId === row.pending_bot_profile_id; })
    : null;
  const bot = active ? (pending || rotationBots[index]) : null;
  return {
    active: active,
    completed: active ? index : (row && Number(row.next_bot_index) >= rotationBots.length ? rotationBots.length : 0),
    total: rotationBots.length,
    position: active ? index + 1 : null,
    botIndex: active ? index : null,
    bot: bot ? { profileId: bot.profileId, name: bot.name, level: bot.level } : null,
    cycleNumber: Number(row && row.cycle_number) || 0
  };
}

async function beginBotRotation(profileIds, mode) {
  const normalizedMode = normalizeRotationMode(mode);
  const ids = Array.from(new Set((Array.isArray(profileIds) ? profileIds : [profileIds]).map(normalizeProfileId).filter(Boolean)));
  if (!normalizedMode || ids.length === 0) throw new Error('Invalid bot rotation request');
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const profileId of ids) {
      await client.query(
        `INSERT INTO player_bot_rotation
          (profile_id, mode, active, next_bot_index, pending_bot_profile_id, cycle_number, updated_at)
         VALUES ($1,$2,TRUE,0,NULL,1,NOW())
         ON CONFLICT (profile_id, mode) DO UPDATE SET
           active = TRUE, next_bot_index = 0, pending_bot_profile_id = NULL,
           cycle_number = player_bot_rotation.cycle_number + 1, updated_at = NOW()`,
        [profileId, normalizedMode]
      );
    }
    await client.query('COMMIT');
    return { active: true, completed: 0, total: botCatalog.MATCHMAKING_BOTS.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function claimBotRotation(profileId, mode) {
  const id = normalizeProfileId(profileId);
  const normalizedMode = normalizeRotationMode(mode);
  if (!id || !normalizedMode) return rotationState(null);
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM player_bot_rotation WHERE profile_id = $1 AND mode = $2 FOR UPDATE',
      [id, normalizedMode]
    );
    const row = result.rows[0];
    if (!row || !row.active || Number(row.next_bot_index) >= botCatalog.MATCHMAKING_BOTS.length) {
      if (row && row.active) {
        await client.query(
          'UPDATE player_bot_rotation SET active = FALSE, next_bot_index = $3, pending_bot_profile_id = NULL, updated_at = NOW() WHERE profile_id = $1 AND mode = $2',
          [id, normalizedMode, botCatalog.MATCHMAKING_BOTS.length]
        );
      }
      await client.query('COMMIT');
      return rotationState(row && Object.assign({}, row, { active: false, next_bot_index: botCatalog.MATCHMAKING_BOTS.length }));
    }
    const index = Number(row.next_bot_index);
    const expectedBot = botCatalog.MATCHMAKING_BOTS[index];
    let pendingBot = botCatalog.MATCHMAKING_BOTS.find(function (bot) { return bot.profileId === row.pending_bot_profile_id; });
    if (!pendingBot || pendingBot.profileId !== expectedBot.profileId) {
      pendingBot = expectedBot;
      await client.query(
        'UPDATE player_bot_rotation SET pending_bot_profile_id = $3, updated_at = NOW() WHERE profile_id = $1 AND mode = $2',
        [id, normalizedMode, pendingBot.profileId]
      );
      row.pending_bot_profile_id = pendingBot.profileId;
    }
    await client.query('COMMIT');
    return rotationState(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function completeBotRotation(profileId, mode, botProfileId) {
  const id = normalizeProfileId(profileId);
  const normalizedMode = normalizeRotationMode(mode);
  const completedBotId = normalizeProfileId(botProfileId);
  if (!id || !normalizedMode || !completedBotId) return Object.assign(rotationState(null), { advanced: false });
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM player_bot_rotation WHERE profile_id = $1 AND mode = $2 FOR UPDATE',
      [id, normalizedMode]
    );
    const row = result.rows[0];
    if (!row || !row.active || row.pending_bot_profile_id !== completedBotId) {
      await client.query('COMMIT');
      return Object.assign(rotationState(row), { advanced: false });
    }
    const nextIndex = Math.min(botCatalog.MATCHMAKING_BOTS.length, Number(row.next_bot_index) + 1);
    const active = nextIndex < botCatalog.MATCHMAKING_BOTS.length;
    const updated = await client.query(
      `UPDATE player_bot_rotation SET active = $3, next_bot_index = $4,
         pending_bot_profile_id = NULL, updated_at = NOW()
       WHERE profile_id = $1 AND mode = $2 RETURNING *`,
      [id, normalizedMode, active, nextIndex]
    );
    await client.query('COMMIT');
    return Object.assign(rotationState(updated.rows[0]), { advanced: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

async function updateProfile(profileId, input) {
  const id = normalizeProfileId(profileId);
  if (!id) throw authError('PROFILE_NOT_FOUND', 'Profile tidak ditemui.');
  const avatarKey = normalizeAvatar(input && input.avatarKey);
  const bio = normalizeBio(input && input.bio);
  if (bio === null) throw authError('INVALID_BIO', 'Bio tidak boleh mengandungi URL atau alamat emel.');
  await ensureSchema();
  const db = getPool();
  const owner = await db.query('SELECT 1 FROM player_accounts WHERE account_id = $1', [id]);
  if (!owner.rows[0]) throw authError('PROFILE_NOT_EDITABLE', 'Hanya pemilik akaun boleh mengedit profile ini.');
  const result = await db.query(
    `UPDATE player_profile_details SET avatar_key = $2, bio = $3, updated_at = NOW()
     WHERE profile_id = $1 RETURNING avatar_key, bio`,
    [id, avatarKey, bio]
  );
  if (!result.rows[0]) throw authError('PROFILE_NOT_FOUND', 'Profile tidak ditemui.');
  return { avatarKey: result.rows[0].avatar_key, bio: result.rows[0].bio };
}

async function getPlayerProfile(playerName, viewerProfileId) {
  const name = normalizePlayerName(playerName);
  if (!name) return null;
  await ensureSchema();
  const client = await getPool().connect();
  try {
    let result = await client.query(
      `SELECT p.profile_id, p.display_name, p.created_at, d.avatar_key, d.bio, d.xp,
              d.current_win_streak, d.best_win_streak
       FROM leaderboard_profiles p
       LEFT JOIN player_profile_details d ON d.profile_id = p.profile_id
       WHERE LOWER(p.display_name) = $1 LIMIT 1`,
      [name.toLowerCase()]
    );
    let profile = result.rows[0];
    if (!profile) return null;
    if (!profile.avatar_key) {
      await client.query('BEGIN');
      await ensureProfileRows(client, { profileId: profile.profile_id, name: profile.display_name });
      await client.query('COMMIT');
      result = await client.query(
        `SELECT p.profile_id, p.display_name, p.created_at, d.avatar_key, d.bio, d.xp,
                d.current_win_streak, d.best_win_streak
         FROM leaderboard_profiles p JOIN player_profile_details d ON d.profile_id = p.profile_id
         WHERE p.profile_id = $1`, [profile.profile_id]
      );
      profile = result.rows[0];
    }

    const season = await ensureCurrentSeason(client);
    const [modeResult, tableResult, cardResult, badgeResult, historyResult, rankResult, bestResult] = await Promise.all([
      client.query('SELECT * FROM player_mode_stats WHERE profile_id = $1 ORDER BY mode', [profile.profile_id]),
      client.query('SELECT table_number, correct, wrong FROM player_table_stats WHERE profile_id = $1 ORDER BY table_number', [profile.profile_id]),
      client.query('SELECT card_id, uses FROM player_card_stats WHERE profile_id = $1 ORDER BY uses DESC, card_id LIMIT 10', [profile.profile_id]),
      client.query('SELECT badge_key, earned_at FROM player_badges WHERE profile_id = $1 ORDER BY earned_at', [profile.profile_id]),
      client.query('SELECT * FROM player_match_history WHERE profile_id = $1 ORDER BY played_at DESC LIMIT 50', [profile.profile_id]),
      client.query('SELECT mode, rp, peak_rp FROM player_rank_stats WHERE profile_id = $1 AND season_id = $2', [profile.profile_id, season.season_id]),
      client.query('SELECT mode, best_score, best_correct, best_wrong, best_accuracy, wins, games_played FROM leaderboard_stats WHERE profile_id = $1', [profile.profile_id])
    ]);

    const ranks = {};
    for (const row of rankResult.rows) {
      const position = await rankPosition(client, season.season_id, row.mode, profile.profile_id, Number(row.rp));
      const info = rankInfo(Number(row.rp), position);
      ranks[row.mode] = {
        rp: Number(row.rp), peakRp: Number(row.peak_rp), position: position, tier: info.name, division: info.division
      };
    }
    RANK_MODES.forEach(function (mode) {
      if (!ranks[mode]) ranks[mode] = { rp: 600, peakRp: 600, position: null, tier: 'Multiply Warrior', division: 'III' };
    });

    const modes = {};
    let totalGames = 0;
    let totalWins = 0;
    let totalCorrect = 0;
    let totalWrong = 0;
    modeResult.rows.forEach(function (row) {
      const attempts = Number(row.total_correct) + Number(row.total_wrong);
      const games = Number(row.games_played);
      modes[row.mode] = {
        gamesPlayed: games, wins: Number(row.wins), losses: Number(row.losses),
        winRate: games > 0 ? Math.round(Number(row.wins) * 100 / games) : 0,
        rankedGames: Number(row.ranked_games), rankedWins: Number(row.ranked_wins),
        totalScore: Number(row.total_score), correct: Number(row.total_correct), wrong: Number(row.total_wrong),
        accuracy: attempts > 0 ? Math.round(Number(row.total_correct) * 100 / attempts) : 0
      };
      totalGames += games; totalWins += Number(row.wins); totalCorrect += Number(row.total_correct); totalWrong += Number(row.total_wrong);
    });
    RANK_MODES.forEach(function (mode) {
      if (!modes[mode]) modes[mode] = { gamesPlayed: 0, wins: 0, losses: 0, winRate: 0, rankedGames: 0, rankedWins: 0, totalScore: 0, correct: 0, wrong: 0, accuracy: 0 };
    });

    const tables = tableResult.rows.map(function (row) {
      const correct = Number(row.correct), wrong = Number(row.wrong), attempts = correct + wrong;
      return { table: Number(row.table_number), correct: correct, wrong: wrong, attempts: attempts, accuracy: attempts ? Math.round(correct * 100 / attempts) : 0 };
    });
    const qualifiedTables = tables.filter(function (row) { return row.attempts >= 5; });
    const strongest = qualifiedTables.slice().sort(function (a, b) { return b.accuracy - a.accuracy || b.attempts - a.attempts; })[0] || null;
    const weakest = qualifiedTables.slice().sort(function (a, b) { return a.accuracy - b.accuracy || b.attempts - a.attempts; })[0] || null;
    const favoriteMode = Object.keys(modes).sort(function (a, b) { return modes[b].gamesPlayed - modes[a].gamesPlayed; })[0];
    const cards = cardResult.rows.map(function (row) { return { cardId: row.card_id, uses: Number(row.uses) }; });
    const history = historyResult.rows.map(function (row) {
      return {
        matchId: row.match_id, mode: row.mode, matchType: row.match_type, ranked: row.ranked,
        result: row.result, opponentName: row.opponent_name, score: Number(row.score), correct: Number(row.correct),
        wrong: Number(row.wrong), accuracy: Number(row.accuracy), durationSeconds: Number(row.duration_seconds),
        xpAwarded: Number(row.xp_awarded), rankBefore: row.rank_before === null ? null : Number(row.rank_before),
        rankDelta: row.rank_delta === null ? null : Number(row.rank_delta), rankAfter: row.rank_after === null ? null : Number(row.rank_after),
        settings: parseJson(row.settings_json, {}), playedAt: row.played_at
      };
    });
    const xp = Number(profile.xp || 0);
    return {
      isOwner: profile.profile_id === viewerProfileId,
      player: { name: profile.display_name, avatarKey: profile.avatar_key || 'hero-blue', bio: profile.bio || '', joinedAt: profile.created_at },
      progression: { level: Math.floor(xp / 100) + 1, xp: xp, currentLevelXp: xp % 100, xpToNext: 100 },
      overview: {
        totalGames: totalGames, totalWins: totalWins, winRate: totalGames ? Math.round(totalWins * 100 / totalGames) : 0,
        correct: totalCorrect, wrong: totalWrong,
        accuracy: totalCorrect + totalWrong ? Math.round(totalCorrect * 100 / (totalCorrect + totalWrong)) : 0,
        currentWinStreak: Number(profile.current_win_streak || 0), bestWinStreak: Number(profile.best_win_streak || 0)
      },
      season: { number: Number(season.season_number), startsAt: season.starts_at, endsAt: season.ends_at },
      ranks: ranks, modes: modes, tables: tables, strongestTable: strongest, weakestTable: weakest,
      favoriteMode: modes[favoriteMode] && modes[favoriteMode].gamesPlayed > 0 ? favoriteMode : null,
      favoriteCard: cards[0] || null, cards: cards,
      badges: badgeResult.rows.map(function (row) { return { key: row.badge_key, earnedAt: row.earned_at }; }),
      recentForm: history.slice(0, 5).map(function (row) { return row.result; }), history: history,
      records: bestResult.rows.map(function (row) { return { mode: row.mode, bestScore: Number(row.best_score), bestCorrect: Number(row.best_correct), bestWrong: Number(row.best_wrong), bestAccuracy: Number(row.best_accuracy), wins: Number(row.wins), gamesPlayed: Number(row.games_played) }; }),
      avatarOptions: AVATAR_KEYS.slice()
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {}
    throw error;
  } finally {
    client.release();
  }
}

function normalizedParticipant(participant) {
  const correct = Math.max(0, Number(participant.correct) || 0);
  const wrong = Math.max(0, Number(participant.wrong) || 0);
  const attempts = correct + wrong;
  return {
    profileId: normalizeProfileId(participant.profileId),
    name: normalizeName(participant.name),
    winner: !!participant.winner,
    isBot: !!participant.isBot,
    score: Math.max(0, Number(participant.score) || 0),
    correct: correct,
    wrong: wrong,
    accuracy: attempts ? Math.round(correct * 100 / attempts) : 0,
    tableStats: Array.isArray(participant.tableStats) ? participant.tableStats : [],
    cardUsage: participant.cardUsage && typeof participant.cardUsage === 'object' ? participant.cardUsage : {}
  };
}

function pvpRankDelta(playerRp, opponentRp, winner, accuracy, attempts) {
  const expected = 1 / (1 + Math.pow(10, (opponentRp - playerRp) / 400));
  const factor = 32;
  let delta = Math.round(factor * ((winner ? 1 : 0) - expected));
  if (attempts >= 5 && accuracy >= 90) delta += winner ? 3 : 3;
  if (attempts >= 5 && accuracy < 60) delta += winner ? -3 : -3;
  return winner ? Math.max(5, Math.min(35, delta)) : Math.min(-5, Math.max(-35, delta));
}

function soloRankDelta(winner, accuracy) {
  return winner ? 18 + Math.floor(accuracy / 10) : -18 + Math.floor(accuracy / 20);
}

async function awardBadges(client, profileId, event) {
  const totals = await client.query(
    'SELECT COALESCE(SUM(games_played), 0) AS games, COALESCE(SUM(wins), 0) AS wins FROM player_mode_stats WHERE profile_id = $1',
    [profileId]
  );
  const games = Number(totals.rows[0].games), wins = Number(totals.rows[0].wins);
  const detail = await client.query('SELECT best_win_streak FROM player_profile_details WHERE profile_id = $1', [profileId]);
  const badges = [];
  if (wins >= 1) badges.push('first-victory');
  if (wins >= 10) badges.push('ten-wins');
  if (wins >= 50) badges.push('fifty-wins');
  if (games >= 100) badges.push('hundred-battles');
  if (Number(detail.rows[0] && detail.rows[0].best_win_streak) >= 5) badges.push('hot-streak');
  if (event.accuracy === 100 && event.correct >= 5) badges.push('perfect-battle');
  if (event.mode === 'sprint' && event.correct >= 15) badges.push('sprint-star');
  if (event.mode === 'sprint' && event.correct >= 30) badges.push('sprint-legend');
  if (Number(detail.rows[0] && detail.rows[0].best_win_streak) >= 20) badges.push('streak-legend');

  const multiplayer = await client.query(
    "SELECT wins FROM player_mode_stats WHERE profile_id = $1 AND mode = 'multiplayer'",
    [profileId]
  );
  if (Number(multiplayer.rows[0] && multiplayer.rows[0].wins) >= 25) badges.push('arena-champion');

  const cardUses = await client.query(
    'SELECT COALESCE(SUM(uses), 0) AS uses FROM player_card_stats WHERE profile_id = $1',
    [profileId]
  );
  if (Number(cardUses.rows[0].uses) >= 50) badges.push('card-master');

  const tables = await client.query('SELECT correct, wrong FROM player_table_stats WHERE profile_id = $1', [profileId]);
  if (tables.rows.some(function (row) {
    const correct = Number(row.correct), attempts = correct + Number(row.wrong);
    return attempts >= 25 && correct * 100 / attempts >= 90;
  })) badges.push('table-specialist');
  if (tables.rows.length === 12 && tables.rows.every(function (row) {
    const correct = Number(row.correct), attempts = correct + Number(row.wrong);
    return attempts >= 10 && correct * 100 / attempts >= 80;
  })) badges.push('times-master');

  const defeatedBots = await client.query(
    "SELECT DISTINCT opponent_name FROM player_match_history WHERE profile_id = $1 AND result = 'win' AND opponent_name = ANY($2::text[])",
    [profileId, botCatalog.BOT_PROFILES.map(function (bot) { return bot.name; })]
  );
  if (defeatedBots.rows.length === botCatalog.BOT_PROFILES.length) badges.push('bot-breaker');
  if (event.ranked && Number(event.rankAfter) >= 300) badges.push('rank-climber');
  for (const badge of badges) {
    await client.query('INSERT INTO player_badges (profile_id, badge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [profileId, badge]);
  }
}

async function recordCompletedMatch(input) {
  await ensureSchema();
  const matchId = normalizeProfileId(input && input.matchId);
  const mode = input && RANK_MODES.includes(input.mode) ? input.mode : null;
  const participants = (input && Array.isArray(input.participants) ? input.participants : []).map(normalizedParticipant).filter(function (p) { return p.profileId; });
  if (!matchId || !mode || participants.length === 0) throw new Error('Invalid completed match');
  const ranked = !!input.ranked;
  const matchType = ['solo', 'room', 'quick'].includes(input.matchType) ? input.matchType : 'room';
  const duration = Math.max(0, Math.min(7200, Math.round(Number(input.durationSeconds) || 0)));
  const settingsJson = JSON.stringify(input.settings || {});
  const hasBot = participants.some(function (p) { return p.isBot; });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT 1 FROM player_match_history WHERE match_id = $1 LIMIT 1', [matchId]);
    if (duplicate.rows[0]) {
      await client.query('ROLLBACK');
      return { recorded: false, duplicate: true, rankResults: [] };
    }
    const season = await ensureCurrentSeason(client);
    for (const participant of participants) await ensureProfileRows(client, participant);

    const rankRows = {};
    for (const participant of participants) {
      const result = await client.query(
        'SELECT rp, peak_rp, shield_tiers FROM player_rank_stats WHERE profile_id = $1 AND season_id = $2 AND mode = $3 FOR UPDATE',
        [participant.profileId, season.season_id, mode]
      );
      rankRows[participant.profileId] = result.rows[0];
    }

    const rankResults = [];
    for (const participant of participants) {
      const row = rankRows[participant.profileId];
      const before = Number(row.rp);
      let delta = 0;
      let after = before;
      let shieldUsed = false;
      let shields = parseJson(row.shield_tiers, []);
      if (ranked) {
        if (mode === 'solo' || participants.length === 1) {
          delta = soloRankDelta(participant.winner, participant.accuracy);
        } else {
          const opponent = participants.find(function (other) { return other.profileId !== participant.profileId; });
          const opponentRow = rankRows[opponent.profileId];
          delta = pvpRankDelta(before, Number(opponentRow.rp), participant.winner, participant.accuracy, participant.correct + participant.wrong);
        }
        after = Math.max(0, before + delta);
        const beforeInfo = rankInfo(before, null);
        const afterInfo = rankInfo(after, null);
        if (after > before && beforeInfo.key !== afterInfo.key && !shields.includes(afterInfo.key)) shields.push(afterInfo.key);
        if (after < tierFloor(before) && shields.includes(beforeInfo.key)) {
          after = tierFloor(before);
          delta = after - before;
          shieldUsed = true;
          shields = shields.filter(function (key) { return key !== beforeInfo.key; });
        }
        await client.query(
          `UPDATE player_rank_stats SET rp = $4, peak_rp = GREATEST(peak_rp, $4),
             shield_tiers = $5, updated_at = NOW()
           WHERE profile_id = $1 AND season_id = $2 AND mode = $3`,
          [participant.profileId, season.season_id, mode, after, JSON.stringify(shields)]
        );
      }

      const rawXp = 20 + (participant.winner ? 20 : 0) + (ranked ? 10 : 0) + Math.floor(participant.accuracy / 10);
      const fullXp = ranked && !hasBot && (mode === 'solo' || participants.length > 1);
      const xpAwarded = fullXp ? rawXp : Math.max(1, Math.floor(rawXp * 0.5));
      await client.query(
        `UPDATE player_profile_details SET xp = xp + $2,
           current_win_streak = CASE WHEN $3 THEN current_win_streak + 1 ELSE 0 END,
           best_win_streak = GREATEST(best_win_streak, CASE WHEN $3 THEN current_win_streak + 1 ELSE best_win_streak END),
           updated_at = NOW() WHERE profile_id = $1`,
        [participant.profileId, xpAwarded, participant.winner]
      );
      await client.query(
        `INSERT INTO player_mode_stats
          (profile_id, mode, games_played, wins, losses, ranked_games, ranked_wins, total_score, total_correct, total_wrong)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (profile_id, mode) DO UPDATE SET
           games_played = player_mode_stats.games_played + 1,
           wins = player_mode_stats.wins + EXCLUDED.wins,
           losses = player_mode_stats.losses + EXCLUDED.losses,
           ranked_games = player_mode_stats.ranked_games + EXCLUDED.ranked_games,
           ranked_wins = player_mode_stats.ranked_wins + EXCLUDED.ranked_wins,
           total_score = player_mode_stats.total_score + EXCLUDED.total_score,
           total_correct = player_mode_stats.total_correct + EXCLUDED.total_correct,
           total_wrong = player_mode_stats.total_wrong + EXCLUDED.total_wrong`,
        [participant.profileId, mode, participant.winner ? 1 : 0, participant.winner ? 0 : 1, ranked ? 1 : 0, ranked && participant.winner ? 1 : 0, participant.score, participant.correct, participant.wrong]
      );
      for (const table of participant.tableStats) {
        const tableNumber = Number(table.table), correct = Math.max(0, Number(table.correct) || 0), wrong = Math.max(0, Number(table.wrong) || 0);
        if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 12 || correct + wrong === 0) continue;
        await client.query(
          `INSERT INTO player_table_stats (profile_id, table_number, correct, wrong) VALUES ($1, $2, $3, $4)
           ON CONFLICT (profile_id, table_number) DO UPDATE SET
             correct = player_table_stats.correct + EXCLUDED.correct,
             wrong = player_table_stats.wrong + EXCLUDED.wrong`,
          [participant.profileId, tableNumber, correct, wrong]
        );
      }
      for (const cardId of Object.keys(participant.cardUsage)) {
        const uses = Math.max(0, Math.min(20, Number(participant.cardUsage[cardId]) || 0));
        if (!/^[A-Za-z0-9_-]{2,32}$/.test(cardId) || uses === 0) continue;
        await client.query(
          `INSERT INTO player_card_stats (profile_id, card_id, uses) VALUES ($1, $2, $3)
           ON CONFLICT (profile_id, card_id) DO UPDATE SET uses = player_card_stats.uses + EXCLUDED.uses`,
          [participant.profileId, cardId, uses]
        );
      }
      const opponent = participants.find(function (other) { return other.profileId !== participant.profileId; });
      const opponentName = opponent ? opponent.name : 'Times Tower';
      await client.query(
        `INSERT INTO player_match_history
          (match_id, profile_id, mode, match_type, ranked, result, opponent_name, score, correct, wrong,
           accuracy, duration_seconds, xp_awarded, rank_before, rank_delta, rank_after, settings_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [matchId, participant.profileId, mode, matchType, ranked, participant.winner ? 'win' : 'loss', opponentName,
          participant.score, participant.correct, participant.wrong, participant.accuracy, duration, xpAwarded,
          ranked ? before : null, ranked ? delta : null, ranked ? after : null, settingsJson]
      );
      await awardBadges(client, participant.profileId, {
        mode: mode, correct: participant.correct, accuracy: participant.accuracy,
        ranked: ranked, rankAfter: after
      });
      const oldHistory = await client.query('SELECT match_id FROM player_match_history WHERE profile_id = $1 ORDER BY played_at DESC OFFSET 50', [participant.profileId]);
      for (const old of oldHistory.rows) await client.query('DELETE FROM player_match_history WHERE profile_id = $1 AND match_id = $2', [participant.profileId, old.match_id]);
      const position = ranked ? await rankPosition(client, season.season_id, mode, participant.profileId, after) : null;
      const info = ranked ? rankInfo(after, position) : null;
      rankResults.push({ profileId: participant.profileId, before: before, delta: delta, after: after, xpAwarded: xpAwarded, shieldUsed: shieldUsed, tier: info && info.name, division: info && info.division, position: position });
    }
    await client.query('COMMIT');
    return { recorded: true, duplicate: false, rankResults: rankResults };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    throw unavailableError(error.message);
  } finally {
    client.release();
  }
}

function status() {
  return {
    configured: !!connectionString,
    ready: schemaReady,
    error: lastError ? lastError.message : null
  };
}

module.exports = {
  initialize,
  getLeaderboard,
  getRankedLadder,
  getRankSnapshot,
  beginBotRotation,
  claimBotRotation,
  completeBotRotation,
  getPlayerProfile,
  updateProfile,
  recordCompletedMatch,
  rankInfo,
  recordBest,
  recordMultiplayerGame,
  normalizeProfileId,
  normalizeName,
  normalizeEmail,
  normalizePlayerName,
  registerAccount,
  loginAccount,
  createPasswordReset,
  invalidatePasswordReset,
  resetPassword,
  getAccountBySession,
  logoutSession,
  status
};
