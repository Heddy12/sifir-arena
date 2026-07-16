'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const MODES = ['solo', 'multiplayer', 'sprint'];
const connectionString = process.env.DATABASE_URL || '';
let pool = null;
let schemaReady = false;
let lastError = null;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/.test(email) && email.length <= 254 ? email : null;
}

function normalizePlayerName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_]{3,20}$/.test(name) ? name : null;
}

function normalizePassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 ? value : null;
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
  if (!email) throw authError('INVALID_EMAIL', 'Gunakan alamat Gmail yang sah.');
  if (!playerName) throw authError('INVALID_PLAYER_NAME', 'Player ID mesti 3-20 aksara: huruf, nombor atau _.');
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
      throw authError('EMAIL_TAKEN', 'Alamat Gmail itu sudah didaftarkan.');
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
    const token = await createSession(client, accountId);
    await client.query('COMMIT');
    return { account: publicAccount(result.rows[0]), token: token };
  } catch (error) {
    await client.query('ROLLBACK').catch(function () {});
    if (error.code === '23505') {
      const detail = String(error.constraint || error.detail || '').toLowerCase();
      if (detail.includes('player_name')) throw authError('PLAYER_NAME_TAKEN', 'Player ID itu sudah digunakan.');
      throw authError('EMAIL_TAKEN', 'Alamat Gmail itu sudah didaftarkan.');
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
  if (!email || !password) throw authError('INVALID_CREDENTIALS', 'Gmail atau kata laluan tidak betul.');

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
  if (!row || !matches) throw authError('INVALID_CREDENTIALS', 'Gmail atau kata laluan tidak betul.');

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

async function initialize() {
  if (!connectionString) return false;
  await ensureSchema();
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
  recordBest,
  recordMultiplayerGame,
  normalizeProfileId,
  normalizeName,
  normalizeEmail,
  normalizePlayerName,
  registerAccount,
  loginAccount,
  getAccountBySession,
  logoutSession,
  status
};
