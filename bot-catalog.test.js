'use strict';

const assert = require('assert');
const bots = require('./bot-catalog');

assert.strictEqual(bots.MATCHMAKING_BOTS.length, 8);
assert.strictEqual(bots.LEAGUE_BOTS.length, 20);
assert.strictEqual(bots.RETIRED_BOTS.length, 2);
assert.strictEqual(bots.BOT_PROFILES.length, 28);
assert.strictEqual(new Set(bots.BOT_PROFILES.map(function (bot) { return bot.profileId; })).size, 28);
assert.strictEqual(new Set(bots.BOT_PROFILES.map(function (bot) { return bot.name.toLowerCase(); })).size, 28);
assert.ok(bots.BOT_PROFILES.every(function (bot) { return bot.name !== 'SifirStorm76' && bot.name !== 'KuasaNombor39'; }));
assert.strictEqual(bots.isReservedBotName('SifirStorm76'), true);
assert.strictEqual(bots.isReservedBotName('KuasaNombor39'), true);
assert.strictEqual(bots.chooseBot(function () { return 0.1; }).level, 'low');
assert.strictEqual(bots.chooseBot(function () { return 0.5; }).level, 'medium');
assert.strictEqual(bots.chooseBot(function () { return 0.9; }).level, 'smart');

bots.BOT_PROFILES.forEach(function (profile) {
  const instance = bots.createBotInstance(profile, function () { return 0.5; });
  assert.ok(instance.accuracy >= profile.accuracyMin && instance.accuracy <= profile.accuracyMax);
  assert.strictEqual(bots.isReservedBotName(profile.name.toUpperCase()), true);
});
assert.ok(bots.LEAGUE_BOTS.every(function (profile) {
  return profile.level === 'smart' && profile.initialRank === 0 && profile.accuracyMin >= 0.89;
}));

const wrong = bots.plausibleWrongAnswer({ a: 7, b: 8 }, function () { return 0; });
assert.notStrictEqual(wrong, 56);
assert.ok(wrong >= 0);

console.log('bot catalog tests passed');
