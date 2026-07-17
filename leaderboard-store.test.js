'use strict';

const assert = require('assert');
const { newDb } = require('pg-mem');
const botCatalog = require('./bot-catalog');
const botLeague = require('./bot-league');

async function run() {
  process.env.DATABASE_URL = 'postgresql://leaderboard-test';
  process.env.PGSSL_DISABLE = '1';

  const memoryDb = newDb({ noAstCoverageCheck: true });
  const memoryPg = memoryDb.adapters.createPg();
  const pgPath = require.resolve('pg');
  const originalPg = require(pgPath);
  require.cache[pgPath].exports = Object.assign({}, originalPg, { Pool: memoryPg.Pool });

  const storePath = require.resolve('./leaderboard-store');
  delete require.cache[storePath];
  let store = require('./leaderboard-store');
  assert.strictEqual(await store.initialize(), true);
  assert.strictEqual(await store.getPlayerProfile('SifirStorm76', null), null);
  assert.strictEqual(await store.getPlayerProfile('KuasaNombor39', null), null);

  const leagueBotA = botCatalog.LEAGUE_BOTS[0];
  const leagueBotB = botCatalog.LEAGUE_BOTS[botCatalog.LEAGUE_BOTS.length - 1];
  const initialLeagueRank = await store.getRankSnapshot(leagueBotA.profileId, 'multiplayer');
  assert.strictEqual(initialLeagueRank.rp, 0, 'new league bots must begin at the lowest rank');
  const leagueResult = await botLeague.runLeagueSlot(store, 0, function () { return 0.5; });
  assert.strictEqual(leagueResult.recorded, true);
  assert.strictEqual(leagueResult.rankResults.length, 2);
  const leagueProfileA = await store.getPlayerProfile(leagueBotA.name, null);
  const leagueProfileB = await store.getPlayerProfile(leagueBotB.name, null);
  assert.strictEqual(leagueProfileA.history.length, 1);
  assert.strictEqual(leagueProfileB.history.length, 1);
  assert.strictEqual(leagueProfileA.modes.multiplayer.gamesPlayed, 1);
  assert.strictEqual(leagueProfileB.modes.multiplayer.gamesPlayed, 1);
  assert.ok(
    leagueProfileA.ranks.multiplayer.rp > initialLeagueRank.rp || leagueProfileB.ranks.multiplayer.rp > initialLeagueRank.rp,
    'the winning bot should gain rank points'
  );

  const registered = await store.registerAccount({
    email: 'G-97558615@moe-dl.edu.my',
    password: 'secure-pass-123',
    playerName: 'Hero_Test'
  });
  assert.strictEqual(registered.account.email, 'g-97558615@moe-dl.edu.my');
  assert.strictEqual(registered.account.playerName, 'Hero_Test');
  assert.ok(registered.token.length >= 32);
  assert.deepStrictEqual(await store.getAccountBySession(registered.token), registered.account);

  const loggedIn = await store.loginAccount({ email: 'g-97558615@moe-dl.edu.my', password: 'secure-pass-123' });
  assert.strictEqual(loggedIn.account.accountId, registered.account.accountId);
  await assert.rejects(
    store.loginAccount({ email: 'g-97558615@moe-dl.edu.my', password: 'wrong-password' }),
    function (error) { return error.code === 'INVALID_CREDENTIALS'; }
  );
  await assert.rejects(
    store.registerAccount({ email: 'g-97558615@moe-dl.edu.my', password: 'another-pass-123', playerName: 'DifferentHero' }),
    function (error) { return error.code === 'EMAIL_TAKEN'; }
  );
  await assert.rejects(
    store.registerAccount({ email: 'another.hero@gmail.com', password: 'another-pass-123', playerName: 'hero_test' }),
    function (error) { return error.code === 'PLAYER_NAME_TAKEN'; }
  );
  assert.strictEqual(await store.logoutSession(loggedIn.token), true);
  assert.strictEqual(await store.getAccountBySession(loggedIn.token), null);
  const passwordReset = await store.createPasswordReset({ email: 'g-97558615@moe-dl.edu.my' });
  assert.match(passwordReset.code, /^\d{6}$/);
  await assert.rejects(
    store.resetPassword({ email: 'g-97558615@moe-dl.edu.my', code: '000000', newPassword: 'new-secure-pass-123' }),
    function (error) { return error.code === 'INVALID_RESET_CODE'; }
  );
  assert.strictEqual(await store.resetPassword({
    email: 'g-97558615@moe-dl.edu.my',
    code: passwordReset.code,
    newPassword: 'new-secure-pass-123'
  }), true);
  assert.strictEqual(await store.getAccountBySession(registered.token), null);
  await assert.rejects(
    store.loginAccount({ email: 'g-97558615@moe-dl.edu.my', password: 'secure-pass-123' }),
    function (error) { return error.code === 'INVALID_CREDENTIALS'; }
  );
  const resetLogin = await store.loginAccount({ email: 'g-97558615@moe-dl.edu.my', password: 'new-secure-pass-123' });
  assert.strictEqual(resetLogin.account.accountId, registered.account.accountId);
  assert.strictEqual(await store.logoutSession(resetLogin.token), true);
  assert.strictEqual(await store.createPasswordReset({ email: 'unknown@example.com' }), null);
  assert.strictEqual(store.normalizeEmail('teacher@example.com'), 'teacher@example.com');
  assert.strictEqual(store.normalizeEmail('not-an-email'), null);
  assert.strictEqual(store.normalizePlayerName('bad name'), null);
  await assert.rejects(
    store.registerAccount({ email: 'reserved.bot@example.com', password: 'secure-pass-123', playerName: botCatalog.BOT_PROFILES[0].name }),
    function (error) { return error.code === 'PLAYER_NAME_TAKEN'; }
  );

  let profile = await store.getPlayerProfile('Hero_Test', registered.account.accountId);
  assert.strictEqual(profile.isOwner, true);
  assert.strictEqual(profile.player.name, 'Hero_Test');
  assert.strictEqual(profile.progression.level, 1);
  assert.deepStrictEqual(Object.keys(profile.ranks).sort(), ['multiplayer', 'solo', 'sprint']);
  assert.strictEqual(profile.ranks.solo.tier, 'Multiply Warrior');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(profile.ranks.solo, 'provisional'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(profile.ranks.solo, 'placementGames'), false);
  await store.updateProfile(registered.account.accountId, { avatarKey: 'hero-gold', bio: 'Learning every table!' });
  profile = await store.getPlayerProfile('Hero_Test', registered.account.accountId);
  assert.strictEqual(profile.player.avatarKey, 'hero-gold');
  assert.strictEqual(profile.player.bio, 'Learning every table!');
  await assert.rejects(
    store.updateProfile(registered.account.accountId, { avatarKey: 'hero-blue', bio: 'email me at hero@example.com' }),
    function (error) { return error.code === 'INVALID_BIO'; }
  );
  const seededBot = botCatalog.BOT_PROFILES[0];
  const seededBotProfile = await store.getPlayerProfile(seededBot.name, registered.account.accountId);
  assert.strictEqual(seededBotProfile.isOwner, false);
  assert.ok(seededBotProfile.overview.totalGames > 0);
  assert.ok(seededBotProfile.modes.multiplayer.gamesPlayed > 0);
  assert.ok(seededBotProfile.modes.sprint.gamesPlayed > 0);
  assert.strictEqual(seededBotProfile.tables.length, 12);
  assert.ok(seededBotProfile.history.length >= 8);
  assert.ok(seededBotProfile.badges.length > 0);
  assert.ok(seededBotProfile.favoriteCard);
  assert.ok(seededBotProfile.overview.accuracy >= 45 && seededBotProfile.overview.accuracy <= 60);
  await assert.rejects(
    store.updateProfile(seededBot.profileId, { avatarKey: 'hero-gold', bio: 'Changed by another player' }),
    function (error) { return error.code === 'PROFILE_NOT_EDITABLE'; }
  );
  const seededMultiplayerRows = await store.getLeaderboard('multiplayer', 50);
  const seededBotLeaderboard = seededMultiplayerRows.find(function (row) { return row.name === seededBot.name; });
  assert.ok(seededBotLeaderboard && seededBotLeaderboard.gamesPlayed > 0);

  await store.beginBotRotation(registered.account.accountId, 'multiplayer');
  let rotation = await store.claimBotRotation(registered.account.accountId, 'multiplayer');
  assert.strictEqual(rotation.active, true);
  assert.strictEqual(rotation.position, 1);
  assert.strictEqual(rotation.bot.profileId, botCatalog.MATCHMAKING_BOTS[0].profileId);
  const repeatedClaim = await store.claimBotRotation(registered.account.accountId, 'multiplayer');
  assert.strictEqual(repeatedClaim.bot.profileId, rotation.bot.profileId, 'unfinished bot must repeat');
  let rotationProgress = await store.completeBotRotation(registered.account.accountId, 'multiplayer', botCatalog.MATCHMAKING_BOTS[1].profileId);
  assert.strictEqual(rotationProgress.advanced, false, 'wrong bot cannot skip rotation');
  for (let botIndex = 0; botIndex < botCatalog.MATCHMAKING_BOTS.length; botIndex++) {
    rotation = await store.claimBotRotation(registered.account.accountId, 'multiplayer');
    assert.strictEqual(rotation.bot.profileId, botCatalog.MATCHMAKING_BOTS[botIndex].profileId);
    rotationProgress = await store.completeBotRotation(registered.account.accountId, 'multiplayer', rotation.bot.profileId);
    assert.strictEqual(rotationProgress.advanced, true);
  }
  rotation = await store.claimBotRotation(registered.account.accountId, 'multiplayer');
  assert.strictEqual(rotation.active, false);
  assert.strictEqual(rotation.completed, botCatalog.MATCHMAKING_BOTS.length);
  const independentSprintRotation = await store.claimBotRotation(registered.account.accountId, 'sprint');
  assert.strictEqual(independentSprintRotation.active, false, 'Sprint rotation must be separate');

  const rankedMatch = await store.recordCompletedMatch({
    matchId: 'match_profile_test_001', mode: 'multiplayer', matchType: 'quick', ranked: true,
    settings: { timer: 6, sifir: 0, difficulty: 'random' }, durationSeconds: 45,
    participants: [
      { profileId: registered.account.accountId, name: 'Hero_Test', winner: true, score: 80, correct: 8, wrong: 1, tableStats: [{ table: 7, correct: 5, wrong: 1 }], cardUsage: { shield: 1 } },
      { profileId: botCatalog.BOT_PROFILES[0].profileId, name: botCatalog.BOT_PROFILES[0].name, winner: false, isBot: true, score: 40, correct: 4, wrong: 3 }
    ]
  });
  assert.strictEqual(rankedMatch.recorded, true);
  assert.strictEqual(rankedMatch.rankResults.length, 2);
  const duplicateMatch = await store.recordCompletedMatch({
    matchId: 'match_profile_test_001', mode: 'multiplayer', matchType: 'quick', ranked: true,
    participants: [{ profileId: registered.account.accountId, name: 'Hero_Test', winner: true }]
  });
  assert.strictEqual(duplicateMatch.duplicate, true);
  profile = await store.getPlayerProfile('Hero_Test', 'another-viewer');
  assert.strictEqual(profile.isOwner, false);
  assert.strictEqual(profile.history.length, 1);
  assert.strictEqual(profile.history[0].opponentName, botCatalog.BOT_PROFILES[0].name);
  assert.strictEqual(profile.modes.multiplayer.gamesPlayed, 1);
  assert.strictEqual(profile.tables[0].table, 7);
  assert.ok(profile.progression.xp > 0);
  const ladder = await store.getRankedLadder('multiplayer', 50);
  assert.ok(ladder.entries.some(function (entry) { return entry.name === 'Hero_Test'; }));

  const playerA = { profileId: 'device_player_a', name: 'Same Name' };
  const playerB = { profileId: 'device_player_b', name: 'Same Name' };

  let result = await store.recordBest(playerA, 'solo', { score: 100, correct: 10, wrong: 2, accuracy: 83 });
  assert.strictEqual(result.improved, true);
  result = await store.recordBest(playerA, 'solo', { score: 90, correct: 9, wrong: 0, accuracy: 100 });
  assert.strictEqual(result.improved, false);
  result = await store.recordBest(playerA, 'solo', { score: 110, correct: 11, wrong: 1, accuracy: 92 });
  assert.strictEqual(result.improved, true);
  await store.recordBest(playerB, 'solo', { score: 105, correct: 10, wrong: 0, accuracy: 100 });

  let rows = await store.getLeaderboard('solo', 10);
  assert.deepStrictEqual(rows.map(function (row) { return row.score; }), [110, 105]);
  assert.strictEqual(rows[0].name, 'Same Name');
  assert.strictEqual(rows[1].name, 'Same Name');

  await store.recordBest(playerA, 'sprint', { score: 100, correct: 10, wrong: 2, accuracy: 83 });
  await store.recordBest(playerA, 'sprint', { score: 100, correct: 10, wrong: 1, accuracy: 91 });
  await store.recordBest(playerB, 'sprint', { score: 110, correct: 11, wrong: 8, accuracy: 58 });
  rows = await store.getLeaderboard('sprint', 10);
  const playerASprint = rows.find(function (row) { return row.name === playerA.name && row.accuracy === 91; });
  const playerBSprint = rows.find(function (row) { return row.name === playerB.name && row.correct === 11; });
  assert.ok(playerASprint);
  assert.ok(playerBSprint);
  const sprintRows = await store.getLeaderboard('sprint', 50);
  assert.ok(botCatalog.BOT_PROFILES.every(function (bot) { return sprintRows.some(function (row) { return row.name === bot.name; }); }));

  await store.recordMultiplayerGame([
    { profileId: playerA.profileId, name: playerA.name, winner: true },
    { profileId: playerB.profileId, name: playerB.name, winner: false }
  ]);
  await store.recordMultiplayerGame([
    { profileId: playerA.profileId, name: 'Renamed Player', winner: false },
    { profileId: playerB.profileId, name: playerB.name, winner: true }
  ]);
  rows = await store.getLeaderboard('multiplayer', 50);
  const humanRows = rows.filter(function (row) { return row.name === 'Renamed Player' || row.name === playerB.name; });
  assert.strictEqual(humanRows.length, 2);
  assert.ok(humanRows.every(function (row) { return row.wins === 1 && row.gamesPlayed === 2 && row.winRate === 50; }));

  const botProfile = botCatalog.BOT_PROFILES[0];
  await store.recordMultiplayerGame([
    { profileId: playerA.profileId, name: 'Renamed Player', winner: false },
    { profileId: botProfile.profileId, name: botProfile.name, winner: true }
  ]);
  rows = await store.getLeaderboard('multiplayer', 50);
  const botRow = rows.find(function (row) { return row.name === botProfile.name; });
  assert.ok(botRow);
  assert.strictEqual(botRow.wins, seededBotLeaderboard.wins + 1);
  assert.strictEqual(botRow.gamesPlayed, seededBotLeaderboard.gamesPlayed + 1);
  const updatedPlayerA = rows.find(function (row) { return row.name === 'Renamed Player'; });
  assert.strictEqual(updatedPlayerA.wins, 1);
  assert.strictEqual(updatedPlayerA.gamesPlayed, 3);
  assert.ok(botCatalog.BOT_PROFILES.every(function (bot) { return rows.some(function (row) { return row.name === bot.name; }); }));

  await store.recordBest({ profileId: playerA.profileId, name: 'Renamed Player' }, 'solo', { score: 100, correct: 10, wrong: 0, accuracy: 100 });
  rows = await store.getLeaderboard('solo', 10);
  assert.strictEqual(rows[0].name, 'Renamed Player');
  assert.strictEqual(rows[0].score, 110);
  assert.ok(rows.every(function (row) { return !botCatalog.isReservedBotName(row.name); }));

  delete require.cache[storePath];
  store = require('./leaderboard-store');
  await store.initialize();
  const botRowsAfterRestart = await store.getLeaderboard('multiplayer', 50);
  const botAfterRestart = botRowsAfterRestart.find(function (row) { return row.name === seededBot.name; });
  assert.strictEqual(botAfterRestart.wins, botRow.wins, 'bot seed must only be applied once');
  assert.strictEqual(botAfterRestart.gamesPlayed, botRow.gamesPlayed, 'bot games must persist without duplicate seeding');
  rows = await store.getLeaderboard('solo', 10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].score, 110);

  console.log('leaderboard store tests passed');
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
