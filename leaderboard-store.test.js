'use strict';

const assert = require('assert');
const { newDb } = require('pg-mem');

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
  assert.strictEqual(rows[0].correct, 11);
  assert.strictEqual(rows[1].accuracy, 91);

  await store.recordMultiplayerGame([
    { profileId: playerA.profileId, name: playerA.name, winner: true },
    { profileId: playerB.profileId, name: playerB.name, winner: false }
  ]);
  await store.recordMultiplayerGame([
    { profileId: playerA.profileId, name: 'Renamed Player', winner: false },
    { profileId: playerB.profileId, name: playerB.name, winner: true }
  ]);
  rows = await store.getLeaderboard('multiplayer', 10);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(function (row) { return row.wins === 1 && row.gamesPlayed === 2 && row.winRate === 50; }));

  await store.recordBest({ profileId: playerA.profileId, name: 'Renamed Player' }, 'solo', { score: 100, correct: 10, wrong: 0, accuracy: 100 });
  rows = await store.getLeaderboard('solo', 10);
  assert.strictEqual(rows[0].name, 'Renamed Player');
  assert.strictEqual(rows[0].score, 110);

  delete require.cache[storePath];
  store = require('./leaderboard-store');
  await store.initialize();
  rows = await store.getLeaderboard('solo', 10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].score, 110);

  console.log('leaderboard store tests passed');
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
