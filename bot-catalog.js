'use strict';

const MATCHMAKING_BOTS = [
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

const LEAGUE_BOTS = [
  { profileId: 'arena_bot_adam_07', name: 'Adam07', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.91, accuracyMax: 0.98, responseMin: 0.12, responseMax: 0.31, cardChance: 0.68 },
  { profileId: 'arena_bot_aiman_12', name: 'Aiman12', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.14, responseMax: 0.34, cardChance: 0.66 },
  { profileId: 'arena_bot_alya_14', name: 'Alya14', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.92, accuracyMax: 0.99, responseMin: 0.11, responseMax: 0.29, cardChance: 0.72 },
  { profileId: 'arena_bot_rayyan_08', name: 'Rayyan08', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.90, accuracyMax: 0.98, responseMin: 0.13, responseMax: 0.32, cardChance: 0.67 },
  { profileId: 'arena_bot_zara_17', name: 'Zara17', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.93, accuracyMax: 0.99, responseMin: 0.10, responseMax: 0.27, cardChance: 0.75 },
  { profileId: 'arena_bot_daniel_21', name: 'Daniel21', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.89, accuracyMax: 0.97, responseMin: 0.15, responseMax: 0.35, cardChance: 0.64 },
  { profileId: 'arena_bot_nurin_09', name: 'Nurin09', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.92, accuracyMax: 0.98, responseMin: 0.12, responseMax: 0.30, cardChance: 0.71 },
  { profileId: 'arena_bot_amir_19', name: 'Amir19', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.14, responseMax: 0.33, cardChance: 0.65 },
  { profileId: 'arena_bot_aqil_05', name: 'Aqil05', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.91, accuracyMax: 0.98, responseMin: 0.13, responseMax: 0.30, cardChance: 0.69 },
  { profileId: 'arena_bot_humaira_23', name: 'Humaira23', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.93, accuracyMax: 0.99, responseMin: 0.10, responseMax: 0.28, cardChance: 0.76 },
  { profileId: 'arena_bot_jalong_09', name: 'Jalong09', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.89, accuracyMax: 0.96, responseMin: 0.16, responseMax: 0.36, cardChance: 0.63 },
  { profileId: 'arena_bot_belin_15', name: 'Belin15', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.91, accuracyMax: 0.98, responseMin: 0.12, responseMax: 0.31, cardChance: 0.70 },
  { profileId: 'arena_bot_lian_22', name: 'Lian22', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.92, accuracyMax: 0.99, responseMin: 0.11, responseMax: 0.29, cardChance: 0.73 },
  { profileId: 'arena_bot_balan_05', name: 'Balan05', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.90, accuracyMax: 0.97, responseMin: 0.15, responseMax: 0.34, cardChance: 0.65 },
  { profileId: 'arena_bot_nyipa_18', name: 'Nyipa18', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.91, accuracyMax: 0.98, responseMin: 0.13, responseMax: 0.32, cardChance: 0.69 },
  { profileId: 'arena_bot_engkam_11', name: 'Engkam11', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.90, accuracyMax: 0.98, responseMin: 0.14, responseMax: 0.33, cardChance: 0.67 },
  { profileId: 'arena_bot_uding_07', name: 'Uding07', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.89, accuracyMax: 0.97, responseMin: 0.16, responseMax: 0.36, cardChance: 0.62 },
  { profileId: 'arena_bot_mering_16', name: 'Mering16', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.92, accuracyMax: 0.98, responseMin: 0.12, responseMax: 0.30, cardChance: 0.71 },
  { profileId: 'arena_bot_jawai_13', name: 'Jawai13', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.91, accuracyMax: 0.98, responseMin: 0.13, responseMax: 0.31, cardChance: 0.68 },
  { profileId: 'arena_bot_senah_20', name: 'Senah20', level: 'smart', league: true, initialRank: 0, accuracyMin: 0.93, accuracyMax: 0.99, responseMin: 0.10, responseMax: 0.27, cardChance: 0.77 }
];

const BOT_PROFILES = MATCHMAKING_BOTS.concat(LEAGUE_BOTS);
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
  MATCHMAKING_BOTS,
  LEAGUE_BOTS,
  chooseBot,
  createBotInstance,
  isReservedBotName,
  plausibleWrongAnswer,
  randomBetween
};
