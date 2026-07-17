'use strict';

const assert = require('assert');
const botCatalog = require('./bot-catalog');
const league = require('./bot-league');

async function run() {
  const pairs = league.leaguePairs();
  assert.strictEqual(pairs.length, 190);
  assert.ok(botCatalog.LEAGUE_BOTS.every(function (bot) {
    return pairs.some(function (pair) { return pair.includes(bot); });
  }));
  const firstRoundNames = new Set(pairs.slice(0, 10).flat().map(function (bot) { return bot.name; }));
  assert.strictEqual(firstRoundNames.size, 20, 'every league bot should play once before the next round begins');

  const first = league.buildLeagueMatch(0, function () { return 0.5; });
  const second = league.buildLeagueMatch(1, function () { return 0.5; });
  assert.strictEqual(first.mode, 'multiplayer');
  assert.strictEqual(second.mode, 'sprint');
  assert.strictEqual(first.ranked, true);
  assert.strictEqual(first.participants.length, 2);
  assert.strictEqual(first.participants.filter(function (participant) { return participant.winner; }).length, 1);
  first.participants.forEach(function (participant) {
    assert.strictEqual(participant.isBot, true);
    assert.ok(participant.correct >= 9, 'strong bots should answer accurately');
    assert.ok(participant.tableStats.length > 0);
  });

  let recordedMatch = null;
  const result = await league.runLeagueSlot({
    recordCompletedMatch: async function (match) {
      recordedMatch = match;
      return { recorded: true, rankResults: match.participants.map(function (participant) { return { profileId: participant.profileId }; }) };
    }
  }, 42, function () { return 0.5; });
  assert.strictEqual(result.recorded, true);
  assert.strictEqual(recordedMatch.matchId, 'botleague_42');
  assert.strictEqual(result.rankResults.length, 2);
  console.log('bot league tests passed');
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
