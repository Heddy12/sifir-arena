'use strict';

const assert = require('assert');
const bots = require('./bot-catalog');

assert.strictEqual(bots.MATCHMAKING_BOTS.length, 6);
assert.strictEqual(bots.LEAGUE_BOTS.length, 20);
assert.strictEqual(bots.RETIRED_BOTS.length, 4);
assert.strictEqual(bots.BOT_PROFILES.length, 26);
assert.strictEqual(bots.ROTATION_BOTS.length, 5);
assert.strictEqual(new Set(bots.BOT_PROFILES.map(function (bot) { return bot.profileId; })).size, 26);
assert.strictEqual(new Set(bots.ROTATION_BOTS.map(function (bot) { return bot.profileId; })).size, bots.ROTATION_BOTS.length);
assert.ok(bots.ROTATION_BOTS.every(function (bot) { return bot.level === 'smart'; }), 'the five-match circuit should use strong bots');
assert.strictEqual(new Set(bots.BOT_PROFILES.map(function (bot) { return bot.name.toLowerCase(); })).size, 26);
assert.ok(bots.BOT_PROFILES.every(function (bot) {
  return !['SifirStorm76', 'KuasaNombor39', 'PixelPadi47', 'RotiCanaiX24'].includes(bot.name);
}));
assert.strictEqual(bots.isReservedBotName('SifirStorm76'), true);
assert.strictEqual(bots.isReservedBotName('KuasaNombor39'), true);
assert.strictEqual(bots.isReservedBotName('PixelPadi47'), true);
assert.strictEqual(bots.isReservedBotName('RotiCanaiX24'), true);
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
