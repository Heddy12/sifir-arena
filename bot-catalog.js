'use strict';

const BOT_PROFILES = [
  { profileId: 'arena_bot_pixel_padi_47', name: 'PixelPadi47', level: 'low', accuracyMin: 0.48, accuracyMax: 0.58, responseMin: 0.55, responseMax: 0.92, cardChance: 0.08 },
  { profileId: 'arena_bot_chill_panda_81', name: 'ChillPanda81', level: 'low', accuracyMin: 0.48, accuracyMax: 0.58, responseMin: 0.55, responseMax: 0.92, cardChance: 0.08 },
  { profileId: 'arena_bot_roti_canaix_24', name: 'RotiCanaiX24', level: 'low', accuracyMin: 0.48, accuracyMax: 0.58, responseMin: 0.55, responseMax: 0.92, cardChance: 0.08 },
  { profileId: 'arena_bot_neon_rimba_63', name: 'NeonRimba63', level: 'medium', accuracyMin: 0.70, accuracyMax: 0.84, responseMin: 0.30, responseMax: 0.65, cardChance: 0.25 },
  { profileId: 'arena_bot_awan_byte_52', name: 'AwanByte52', level: 'medium', accuracyMin: 0.70, accuracyMax: 0.84, responseMin: 0.30, responseMax: 0.65, cardChance: 0.25 },
  { profileId: 'arena_bot_sifir_storm_76', name: 'SifirStorm76', level: 'medium', accuracyMin: 0.70, accuracyMax: 0.84, responseMin: 0.30, responseMax: 0.65, cardChance: 0.25 },
  { profileId: 'arena_bot_kuasa_nombor_39', name: 'KuasaNombor39', level: 'medium', accuracyMin: 0.70, accuracyMax: 0.84, responseMin: 0.30, responseMax: 0.65, cardChance: 0.25 },
  { profileId: 'arena_bot_zero_lag_zara_91', name: 'ZeroLagZara91', level: 'smart', accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.15, responseMax: 0.40, cardChance: 0.55 },
  { profileId: 'arena_bot_quantum_kid_88', name: 'QuantumKid88', level: 'smart', accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.15, responseMax: 0.40, cardChance: 0.55 },
  { profileId: 'arena_bot_titan_sifir_95', name: 'TitanSifir95', level: 'smart', accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.15, responseMax: 0.40, cardChance: 0.55 }
];

const BOT_NAME_KEYS = new Set(BOT_PROFILES.map(function (bot) { return bot.name.toLowerCase(); }));

function randomBetween(min, max, random) {
  return min + (max - min) * (random || Math.random)();
}

function chooseBot(random) {
  const rng = random || Math.random;
  const roll = rng();
  const level = roll < 0.30 ? 'low' : (roll < 0.70 ? 'medium' : 'smart');
  const candidates = BOT_PROFILES.filter(function (bot) { return bot.level === level; });
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

function createBotInstance(profile, random) {
  const rng = random || Math.random;
  return Object.assign({}, profile, {
    accuracy: randomBetween(profile.accuracyMin, profile.accuracyMax, rng)
  });
}

function isReservedBotName(name) {
  return typeof name === 'string' && BOT_NAME_KEYS.has(name.trim().toLowerCase());
}

function plausibleWrongAnswer(question, random) {
  const rng = random || Math.random;
  const a = Number(question && question.a) || 1;
  const b = Number(question && question.b) || 1;
  const answer = a * b;
  const nearby = [a * Math.max(1, b - 1), a * (b + 1), answer - 2, answer - 1, answer + 1, answer + 2, answer + 5]
    .filter(function (value, index, values) { return value >= 0 && value !== answer && values.indexOf(value) === index; });
  return nearby[Math.min(nearby.length - 1, Math.floor(rng() * nearby.length))];
}

module.exports = {
  BOT_PROFILES,
  chooseBot,
  createBotInstance,
  isReservedBotName,
  plausibleWrongAnswer,
  randomBetween
};
