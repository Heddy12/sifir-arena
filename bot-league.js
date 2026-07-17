'use strict';

const botCatalog = require('./bot-catalog');

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const CARD_IDS = ['shield', 'healPotion', 'doubleStrike', 'timeFreeze', 'stealHP', 'mirrorShield', 'skipQuestion'];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function randomInteger(minimum, maximum, random) {
  const rng = random || Math.random;
  return minimum + Math.floor(rng() * (maximum - minimum + 1));
}

function leaguePairs() {
  const pairs = [];
  const rotation = botCatalog.LEAGUE_BOTS.slice();
  if (rotation.length < 2 || rotation.length % 2 !== 0) return pairs;
  for (let round = 0; round < rotation.length - 1; round++) {
    for (let index = 0; index < rotation.length / 2; index++) {
      pairs.push([rotation[index], rotation[rotation.length - 1 - index]]);
    }
    rotation.splice(1, 0, rotation.pop());
  }
  return pairs;
}

const PAIRS = leaguePairs();

function pairForSlot(slot) {
  if (!PAIRS.length) return null;
  return PAIRS[Math.abs(Number(slot) || 0) % PAIRS.length];
}

function distributeTables(correct, wrong, random) {
  const totals = {};
  function add(isCorrect) {
    const table = randomInteger(1, 12, random);
    if (!totals[table]) totals[table] = { table: table, correct: 0, wrong: 0 };
    totals[table][isCorrect ? 'correct' : 'wrong']++;
  }
  for (let index = 0; index < correct; index++) add(true);
  for (let index = 0; index < wrong; index++) add(false);
  return Object.keys(totals).map(function (table) { return totals[table]; });
}

function cardUsageFor(bot, random) {
  const usage = {};
  const uses = randomInteger(1, 3, random);
  for (let index = 0; index < uses; index++) {
    if ((random || Math.random)() > bot.cardChance) continue;
    const card = CARD_IDS[randomInteger(0, CARD_IDS.length - 1, random)];
    usage[card] = (usage[card] || 0) + 1;
  }
  return usage;
}

function performanceFor(bot, mode, random) {
  const rng = random || Math.random;
  const attempts = mode === 'sprint' ? randomInteger(25, 40, rng) : randomInteger(10, 17, rng);
  const accuracy = botCatalog.randomBetween(bot.accuracyMin, bot.accuracyMax, rng);
  const correct = clamp(Math.round(attempts * accuracy), 0, attempts);
  const wrong = attempts - correct;
  const speedBonus = Math.round((1 - botCatalog.randomBetween(bot.responseMin, bot.responseMax, rng)) * 20);
  return {
    bot: bot,
    correct: correct,
    wrong: wrong,
    score: correct * 10 + speedBonus - wrong * 2,
    strength: correct * 4 - wrong * 2 + speedBonus + rng() * 12,
    tableStats: distributeTables(correct, wrong, rng),
    cardUsage: cardUsageFor(bot, rng)
  };
}

function buildLeagueMatch(slot, random) {
  const pair = pairForSlot(slot);
  if (!pair) return null;
  const rng = random || Math.random;
  const mode = Math.abs(Number(slot) || 0) % 2 === 0 ? 'multiplayer' : 'sprint';
  const performances = pair.map(function (bot) { return performanceFor(bot, mode, rng); });
  let winnerIndex = performances[0].strength >= performances[1].strength ? 0 : 1;
  if (performances[0].strength === performances[1].strength) winnerIndex = rng() < 0.5 ? 0 : 1;
  return {
    matchId: 'botleague_' + Math.abs(Math.trunc(Number(slot) || 0)),
    mode: mode,
    matchType: 'quick',
    ranked: true,
    durationSeconds: mode === 'sprint' ? 60 : randomInteger(42, 78, rng),
    settings: { timer: 6, sifir: 0, difficulty: 'random', sprintTime: 60, automatedLeague: true },
    participants: performances.map(function (performance, index) {
      return {
        profileId: performance.bot.profileId,
        name: performance.bot.name,
        winner: index === winnerIndex,
        isBot: true,
        score: Math.max(0, performance.score),
        correct: performance.correct,
        wrong: performance.wrong,
        tableStats: performance.tableStats,
        cardUsage: performance.cardUsage
      };
    })
  };
}

async function runLeagueSlot(store, slot, random) {
  const match = buildLeagueMatch(slot, random);
  if (!match) return null;
  return store.recordCompletedMatch(match);
}

function start(store, options) {
  if (!store || process.env.NODE_ENV === 'test' || process.env.BOT_LEAGUE_ENABLED === 'false') return null;
  const configured = Number(process.env.BOT_LEAGUE_INTERVAL_MS);
  const intervalMs = Math.max(30000, configured || DEFAULT_INTERVAL_MS);
  let stopped = false;
  async function tick() {
    if (stopped) return;
    const slot = Math.floor(Date.now() / intervalMs);
    try {
      const result = await runLeagueSlot(store, slot);
      if (result && result.recorded && options && typeof options.onRecorded === 'function') options.onRecorded(result, slot);
    } catch (error) {
      if (options && typeof options.onError === 'function') options.onError(error);
    }
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return {
    intervalMs: intervalMs,
    stop: function () { stopped = true; clearInterval(timer); }
  };
}

module.exports = {
  buildLeagueMatch,
  leaguePairs,
  pairForSlot,
  runLeagueSlot,
  start
};
