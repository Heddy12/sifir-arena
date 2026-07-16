'use strict';

/**
 * ASMD Times Table Hero Arena - Fighter Edition
 * Multiplayer WebSocket Server
 *
 * Features:
 * - Room-based matchmaking (6-char room code)
 * - Server-authoritative game logic
 * - Question generation, timer, damage calculation
 * - Magic Cards system (deal, activate, effects)
 * - Real-time state sync between 2 players
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const leaderboard = require('./leaderboard-store');
const botCatalog = require('./bot-catalog');

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'sifir_session';
const SECURE_SESSION_COOKIE = '__Host-sifir_session';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_IP_MAX_ATTEMPTS = 100;
const authAttempts = new Map();
const disconnectedPlayers = new Map();
const soloSessions = new Map();

/* ==================== CONSTANTS ==================== */
const SPRINT_DURATION = 60;
const TURN_DELAY = 1500;
const COUNTDOWN_READY_FALLBACK_MS = 15000;
const BASE_HP = 100;
const BASE_DAMAGE = 10;
const WRONG_DAMAGE = 5;
const TIMEOUT_DAMAGE = 8;
const FAST_BONUS = 5;
const SCORE_PER_CORRECT = 10;
const QUICK_MATCH_WAIT_MS = Math.max(10, Number(process.env.QUICK_MATCH_WAIT_MS) || 8000);
const QUICK_MATCH_START_DELAY_MS = Math.max(10, Number(process.env.QUICK_MATCH_START_DELAY_MS) || 700);
const RANKED_RECONNECT_GRACE_MS = Math.max(100, Number(process.env.RANKED_RECONNECT_GRACE_MS) || 30000);
const QUICK_MATCH_SETTINGS = Object.freeze({ timer: 6, sifir: 0, difficulty: 'random', gameMode: 'ffa', sprintTime: SPRINT_DURATION });

leaderboard.initialize().then(function (ready) {
  if (ready) console.log('Leaderboard database ready');
  else console.log('Leaderboard disabled: DATABASE_URL is not configured');
}).catch(function (error) {
  console.error('Leaderboard database unavailable:', error.message);
});

/* ==================== CARD POOL ==================== */
const CARD_POOL = [
  { id: 'doubleStrike', name: 'Double Strike', icon: 'X2', category: 'offensive', desc: '2x damage on next correct answer' },
  { id: 'shield', name: 'Shield', icon: 'SH', category: 'defensive', desc: 'Block next incoming attack' },
  { id: 'timeFreeze', name: 'Time Freeze', icon: 'TF', category: 'support', desc: 'Stop timer for current question' },
  { id: 'healPotion', name: 'Heal Potion', icon: 'HP', category: 'recovery', desc: 'Restore +20 HP' },
  { id: 'revealHint', name: 'Reveal Hint', icon: 'RH', category: 'support', desc: 'Show if answer is even or odd' },
  { id: 'skipQuestion', name: 'Skip Question', icon: 'SQ', category: 'utility', desc: 'New question, no penalty' },
  { id: 'stealHP', name: 'Steal HP', icon: 'ST', category: 'offensive', desc: 'Steal 15 HP from opponent' },
  { id: 'secondChance', name: 'Second Chance', icon: 'SC', category: 'defensive', desc: 'No penalty on next wrong answer' },
  { id: 'streakBoost', name: 'Streak Boost', icon: 'SB', category: 'offensive', desc: '+3 streak instantly' },
  { id: 'mirrorShield', name: 'Mirror Shield', icon: 'MS', category: 'defensive', desc: 'Reflect damage to opponent (1 turn)' }
];

/* ==================== ROOM MANAGEMENT ==================== */
const rooms = {};
const players = {};
const quickMatchQueue = [];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]);
  return code;
}

function dealCards() {
  const pool = CARD_POOL.slice();
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    cards.push({
      id: pool[idx].id,
      name: pool[idx].name,
      icon: pool[idx].icon,
      category: pool[idx].category,
      desc: pool[idx].desc,
      used: false
    });
    pool.splice(idx, 1);
  }
  return cards;
}

function generateQuestion(sifir, difficulty) {
  let sifirNum, multiplier;
  if (sifir > 0) {
    sifirNum = sifir;
  } else {
    sifirNum = Math.floor(Math.random() * 12) + 1;
  }
  let min, max;
  switch (difficulty) {
    case 'easy': min = 1; max = 5; break;
    case 'medium': min = 6; max = 9; break;
    case 'hard': min = 10; max = 12; break;
    default: min = 1; max = 12;
  }
  multiplier = Math.floor(Math.random() * (max - min + 1)) + min;
  let a, b;
  if (Math.random() < 0.5) { a = sifirNum; b = multiplier; }
  else { a = multiplier; b = sifirNum; }
  return { a: a, b: b, answer: a * b, isWeak: false, table: sifirNum };
}

function recordTableAttempt(player, question, isCorrect) {
  if (!player || !question) return;
  const table = Number(question.table || Math.min(question.a, question.b));
  if (!player.tableStats) player.tableStats = {};
  if (!player.tableStats[table]) {
    player.tableStats[table] = { table: table, correct: 0, wrong: 0, attempts: 0 };
  }
  const stats = player.tableStats[table];
  stats.attempts++;
  if (isCorrect) stats.correct++; else stats.wrong++;
}

function buildLearningReport(player) {
  const tableStats = player && player.tableStats ? player.tableStats : {};
  return Object.keys(tableStats).map(function (key) {
    const item = tableStats[key];
    return {
      table: item.table,
      correct: item.correct,
      wrong: item.wrong,
      attempts: item.attempts,
      accuracy: item.attempts > 0 ? Math.round((item.correct / item.attempts) * 100) : 0
    };
  }).sort(function (a, b) {
    if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
    if (a.wrong !== b.wrong) return b.wrong - a.wrong;
    return a.table - b.table;
  });
}

function getLearningReports(room) {
  return room.gameState.players.map(buildLearningReport);
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const timer = Number(source.timer);
  const sifir = Number(source.sifir);
  const sprintTime = Number(source.sprintTime);
  const allowedTimers = [4, 6, 8, 10, 20];
  const allowedDifficulties = ['random', 'easy', 'medium', 'hard'];
  const allowedModes = ['ffa', 'sprint'];
  const gameMode = allowedModes.includes(source.gameMode) ? source.gameMode : 'ffa';
  const normalizedSprintTime = [30, 45, 60].includes(sprintTime) ? sprintTime : SPRINT_DURATION;

  return {
    timer: gameMode === 'sprint' ? normalizedSprintTime : (allowedTimers.includes(timer) ? timer : 20),
    sifir: Number.isInteger(sifir) && sifir >= 0 && sifir <= 12 ? sifir : 0,
    difficulty: allowedDifficulties.includes(source.difficulty) ? source.difficulty : 'random',
    gameMode: gameMode,
    sprintTime: normalizedSprintTime
  };
}

function isRankedSettings(settings, mode) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (Number(source.sifir) !== 0 || source.difficulty !== 'random') return false;
  if (mode === 'sprint') {
    return Number(source.timer) === SPRINT_DURATION && Number(source.sprintTime) === SPRINT_DURATION;
  }
  return Number(source.timer) === 20;
}

function isRankedRoom(room) {
  if (!room) return false;
  if (room.matchType === 'quick' && room.gameMode === 'ffa') {
    return Number(room.settings.timer) === 6 && Number(room.settings.sifir) === 0 && room.settings.difficulty === 'random';
  }
  return isRankedSettings(room.settings, room.gameMode);
}

function normalizeResultStats(stats) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const score = Number(source.score);
  const correct = Number(source.correct);
  const wrong = Number(source.wrong);
  if (!Number.isInteger(score) || score < 0 || score > 100000) return null;
  if (!Number.isInteger(correct) || correct < 0 || correct > 10000) return null;
  if (!Number.isInteger(wrong) || wrong < 0 || wrong > 10000) return null;
  if (score !== correct * SCORE_PER_CORRECT) return null;
  const attempts = correct + wrong;
  return {
    score: score,
    correct: correct,
    wrong: wrong,
    accuracy: attempts > 0 ? Math.round((correct / attempts) * 100) : 0
  };
}

function leaderboardProfile(playerId) {
  const player = players[playerId];
  if (!player || !leaderboard.normalizeProfileId(player.profileId)) return null;
  return { profileId: player.profileId, name: player.name || 'Player' };
}

function recordRoomLeaderboard(room, winnerIdx) {
  if (!room || room.leaderboardRecorded) return;
  room.leaderboardRecorded = true;
  const mode = room.gameMode === 'sprint' ? 'sprint' : 'multiplayer';
  const ranked = isRankedRoom(room);
  const completedParticipants = room.players.map(function (playerId, index) {
    const profile = leaderboardProfile(playerId);
    const stats = room.gameState.players[index];
    if (!profile || !stats) return null;
    return {
      playerId: playerId,
      profileId: profile.profileId,
      name: profile.name,
      winner: index === winnerIdx,
      isBot: !!players[playerId].isBot,
      score: stats.score,
      correct: stats.correct,
      wrong: stats.wrong,
      tableStats: buildLearningReport(stats),
      cardUsage: stats.cardUsage || {}
    };
  }).filter(Boolean);

  let leaderboardOperation = Promise.resolve(null);
  if (ranked && mode === 'sprint') {
    const writes = room.players.map(function (playerId, index) {
      const profile = leaderboardProfile(playerId);
      const stats = room.gameState.players[index];
      if (!profile || !stats) return Promise.resolve(null);
      const attempts = stats.correct + stats.wrong;
      return leaderboard.recordBest(profile, 'sprint', {
        score: stats.score,
        correct: stats.correct,
        wrong: stats.wrong,
        accuracy: attempts > 0 ? Math.round((stats.correct / attempts) * 100) : 0
      });
    });
    leaderboardOperation = Promise.all(writes);
  } else if (ranked) {
    const participants = room.players.map(function (playerId, index) {
      const profile = leaderboardProfile(playerId);
      if (!profile) return null;
      profile.winner = index === winnerIdx;
      return profile;
    }).filter(Boolean);
    leaderboardOperation = leaderboard.recordMultiplayerGame(participants);
  }

  const profileOperation = leaderboard.recordCompletedMatch({
    matchId: room.matchId || ('match_' + cryptoRandomId()),
    mode: mode,
    matchType: room.matchType === 'quick' ? 'quick' : 'room',
    ranked: ranked,
    settings: room.settings,
    durationSeconds: room.startedAt ? (Date.now() - room.startedAt) / 1000 : 0,
    participants: completedParticipants
  });

  Promise.all([leaderboardOperation, profileOperation]).then(function (results) {
    broadcast(room, { type: 'leaderboardResult', mode: mode, eligible: ranked, recorded: true, reason: ranked ? null : 'custom-settings' });
    const progress = results[1];
    (progress.rankResults || []).forEach(function (rankResult) {
      const participant = completedParticipants.find(function (item) { return item.profileId === rankResult.profileId; });
      if (participant) sendToPlayer(participant.playerId, Object.assign({ type: 'rankResult', mode: mode, ranked: ranked }, rankResult));
    });
  }).catch(function (error) {
    console.error('Battle profile result was not saved:', error.message);
    broadcast(room, { type: 'leaderboardResult', mode: mode, eligible: ranked, recorded: false, reason: 'database-unavailable' });
  });
}

function startSoloSession(playerId, message) {
  const player = players[playerId];
  if (!player) return;
  const source = message && message.settings ? message.settings : {};
  const settings = normalizeSettings({ timer: source.timer, sifir: source.sifir, difficulty: source.difficulty, gameMode: 'ffa' });
  settings.gameMode = 'solo';
  const sessionId = 'ss_' + cryptoRandomId();
  soloSessions.set(player.accountId, { sessionId: sessionId, settings: settings, startedAt: Date.now(), used: false });
  sendToPlayer(playerId, { type: 'soloSessionStarted', sessionId: sessionId, settings: settings });
}

function submitSoloLeaderboardResult(playerId, message) {
  const player = players[playerId];
  const profile = leaderboardProfile(playerId);
  const session = player && soloSessions.get(player.accountId);
  const settings = session && session.settings;
  const stats = normalizeResultStats(message && message.stats);
  if (!profile || !session || session.used || message.sessionId !== session.sessionId) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: true, recorded: false, reason: 'profile-required' });
    return;
  }
  if (!stats) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: true, recorded: false, reason: 'invalid-result' });
    return;
  }
  session.used = true;
  const ranked = isRankedSettings(settings, 'solo');
  const won = !!message.won;
  const profileOperation = leaderboard.recordCompletedMatch({
    matchId: 'solo_' + session.sessionId,
    mode: 'solo', matchType: 'solo', ranked: ranked, settings: settings,
    durationSeconds: (Date.now() - session.startedAt) / 1000,
    participants: [{
      profileId: profile.profileId, name: profile.name, winner: won, isBot: false,
      score: stats.score, correct: stats.correct, wrong: stats.wrong,
      tableStats: message.tableStats, cardUsage: message.cardUsage
    }]
  });
  const recordOperation = won && ranked ? leaderboard.recordBest(profile, 'solo', stats) : Promise.resolve({ improved: false });
  Promise.all([recordOperation, profileOperation]).then(function (results) {
    const result = results[0];
    sendToPlayer(playerId, {
      type: 'leaderboardResult',
      mode: 'solo',
      eligible: ranked && won,
      recorded: true,
      improved: result.improved,
      reason: ranked ? (won ? null : 'win-required') : 'custom-settings'
    });
    const rankResult = results[1].rankResults && results[1].rankResults[0];
    if (rankResult) sendToPlayer(playerId, Object.assign({ type: 'rankResult', mode: 'solo', ranked: ranked }, rankResult));
  }).catch(function (error) {
    console.error('Solo profile result was not saved:', error.message);
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: ranked && won, recorded: false, reason: 'database-unavailable' });
  });
}

function createRoom(playerId, settings) {
  settings = normalizeSettings(settings);
  const code = generateRoomCode();
  rooms[code] = {
    code: code,
    players: [playerId],
    settings: settings,
    gameMode: settings.gameMode || 'ffa',
    gameState: null,
    weakQuestions: [],
    currentQuestion: null,
    currentPlayer: 0,
    round: 0,
    timerInterval: null,
    timeLeft: 0,
    questionStartTime: 0,
    battleActive: false,
    timerFrozen: false,
    sprintInterval: null,
    sprintTimeLeft: settings.sprintTime || SPRINT_DURATION,
    sprintQuestions: [null, null],
    sprintQuestionVersions: [0, 0],
    botSprintTimers: [null, null],
    leaderboardRecorded: false,
    questionVersion: 0,
    botActionTimers: [],
    countdownPending: false,
    countdownFallback: null,
    readyPlayers: {},
    matchType: 'room',
    botProfileId: null
  };
  players[playerId].roomCode = code;
  players[playerId].playerIdx = 0;
  return code;
}

function joinRoom(playerId, code) {
  code = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const room = rooms[code];
  if (!room) return { error: 'Room not found' };
  if (room.players.length >= 2) return { error: 'Room is full' };
  room.players.push(playerId);
  players[playerId].roomCode = code;
  players[playerId].playerIdx = 1;
  return { success: true, room: room };
}

function removeQuickMatchEntry(playerId) {
  const index = quickMatchQueue.findIndex(function (entry) { return entry.playerId === playerId; });
  if (index === -1) return null;
  const entry = quickMatchQueue.splice(index, 1)[0];
  clearTimeout(entry.timeout);
  return entry;
}

function cancelQuickMatch(playerId, notify) {
  const removed = removeQuickMatchEntry(playerId);
  if (removed && notify) sendToPlayer(playerId, { type: 'quickMatchCancelled' });
  return !!removed;
}

function rankedQuickMatchSettings(gameMode) {
  if (gameMode === 'sprint') {
    return normalizeSettings({ timer: SPRINT_DURATION, sprintTime: SPRINT_DURATION, sifir: 0, difficulty: 'random', gameMode: 'sprint' });
  }
  return normalizeSettings(QUICK_MATCH_SETTINGS);
}

function sendQuickMatchFound(playerId, opponentId, you, room) {
  sendToPlayer(playerId, {
    type: 'quickMatchFound',
    opponentName: players[opponentId].name,
    you: you,
    gameMode: room.gameMode,
    settings: room.settings
  });
}

function startQuickMatchRoom(firstPlayerId, secondPlayerId, botProfileId, gameMode) {
  const settings = rankedQuickMatchSettings(gameMode);
  const code = createRoom(firstPlayerId, settings);
  const joined = joinRoom(secondPlayerId, code);
  if (joined.error) return null;
  const room = rooms[code];
  room.matchType = 'quick';
  room.botProfileId = botProfileId || null;
  sendQuickMatchFound(firstPlayerId, secondPlayerId, 0, room);
  sendQuickMatchFound(secondPlayerId, firstPlayerId, 1, room);
  setTimeout(function () {
    if (rooms[code] === room && room.players.length === 2 && !room.battleActive) startBattle(room);
  }, QUICK_MATCH_START_DELAY_MS);
  return room;
}

function createBotOpponent(profile) {
  const botId = 'bot_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
  const instance = botCatalog.createBotInstance(profile);
  players[botId] = {
    ws: null,
    name: profile.name,
    profileId: profile.profileId,
    accountId: null,
    roomCode: null,
    playerIdx: 1,
    isBot: true,
    bot: instance
  };
  return botId;
}

async function fallbackQuickMatchToBot(playerId) {
  const entry = removeQuickMatchEntry(playerId);
  const player = players[playerId];
  if (!entry || !player || player.roomCode) return;
  let profile = botCatalog.chooseBot();
  try {
    const rankedMode = entry.gameMode === 'sprint' ? 'sprint' : 'multiplayer';
    const snapshots = await Promise.all(botCatalog.BOT_PROFILES.map(function (bot) { return leaderboard.getRankSnapshot(bot.profileId, rankedMode); }));
    let closestDistance = Infinity;
    snapshots.forEach(function (snapshot, index) {
      const distance = Math.abs(Number(snapshot && snapshot.rp || 600) - Number(entry.rp || 600));
      if (distance < closestDistance) { closestDistance = distance; profile = botCatalog.BOT_PROFILES[index]; }
    });
  } catch (error) {}
  if (!players[playerId] || players[playerId].roomCode) return;
  const botId = createBotOpponent(profile);
  const room = startQuickMatchRoom(playerId, botId, profile.profileId, entry.gameMode);
  if (!room) {
    delete players[botId];
    sendToPlayer(playerId, { type: 'quickMatchError', error: 'Unable to start Quick Match.' });
  }
}

async function requestQuickMatch(playerId, requestedMode) {
  const player = players[playerId];
  if (!player) return;
  const gameMode = requestedMode === 'sprint' ? 'sprint' : 'ffa';
  let playerRp = 600;
  try {
    const snapshot = await leaderboard.getRankSnapshot(player.profileId, gameMode === 'sprint' ? 'sprint' : 'multiplayer');
    playerRp = Number(snapshot && snapshot.rp) || 600;
  } catch (error) {}
  if (!players[playerId] || players[playerId].roomCode) return;
  if (player.roomCode) {
    sendToPlayer(playerId, { type: 'quickMatchError', error: 'Leave your current room before starting Quick Match.' });
    return;
  }
  const existingEntry = quickMatchQueue.find(function (entry) { return entry.playerId === playerId; });
  if (existingEntry) {
    if (existingEntry.gameMode !== gameMode) {
      cancelQuickMatch(playerId, false);
      return requestQuickMatch(playerId, gameMode);
    }
    sendToPlayer(playerId, { type: 'quickMatchSearching', waitMs: QUICK_MATCH_WAIT_MS, gameMode: gameMode, settings: rankedQuickMatchSettings(gameMode) });
    return;
  }

  for (let index = quickMatchQueue.length - 1; index >= 0; index--) {
    const queuedPlayer = players[quickMatchQueue[index].playerId];
    if (!queuedPlayer || queuedPlayer.roomCode) {
      clearTimeout(quickMatchQueue[index].timeout);
      quickMatchQueue.splice(index, 1);
    }
  }
  const opponentIndex = quickMatchQueue.findIndex(function (entry) {
    if (entry.playerId === playerId || entry.gameMode !== gameMode) return false;
    const elapsed = Date.now() - entry.queuedAt;
    const range = elapsed < 4000 ? 150 : 300;
    return Math.abs(Number(entry.rp || 600) - playerRp) <= range;
  });
  const opponentEntry = opponentIndex === -1 ? null : quickMatchQueue.splice(opponentIndex, 1)[0];

  if (opponentEntry) {
    clearTimeout(opponentEntry.timeout);
    startQuickMatchRoom(opponentEntry.playerId, playerId, null, gameMode);
    return;
  }

  const entry = { playerId: playerId, gameMode: gameMode, rp: playerRp, queuedAt: Date.now(), timeout: null };
  entry.timeout = setTimeout(function () { fallbackQuickMatchToBot(playerId); }, QUICK_MATCH_WAIT_MS);
  quickMatchQueue.push(entry);
  sendToPlayer(playerId, { type: 'quickMatchSearching', waitMs: QUICK_MATCH_WAIT_MS, gameMode: gameMode, settings: rankedQuickMatchSettings(gameMode) });
}

function prepareBattleCountdown(room) {
  clearTimeout(room.countdownFallback);
  room.countdownPending = true;
  room.readyPlayers = {};
  room.players.forEach(function (playerId) {
    if (players[playerId] && players[playerId].isBot) room.readyPlayers[playerId] = true;
  });
  room.countdownFallback = setTimeout(function () { beginBattleAfterCountdown(room); }, COUNTDOWN_READY_FALLBACK_MS);
}

function beginBattleAfterCountdown(room) {
  if (!room || !room.countdownPending || rooms[room.code] !== room) return;
  clearTimeout(room.countdownFallback);
  room.countdownFallback = null;
  room.countdownPending = false;
  room.battleActive = true;
  room.startedAt = Date.now();
  if (room.gameMode === 'sprint') {
    const duration = room.settings.sprintTime || SPRINT_DURATION;
    room.sprintTimeLeft = duration;
    startSprintClock(room, duration);
    sendSprintQuestion(room, 0);
    sendSprintQuestion(room, 1);
  } else {
    nextTurn(room);
  }
}

function handleBattleReady(room, playerId) {
  if (!room || !room.countdownPending || !room.players.includes(playerId)) return;
  room.readyPlayers[playerId] = true;
  const everyoneReady = room.players.every(function (id) {
    return room.readyPlayers[id] || (players[id] && players[id].isBot);
  });
  if (everyoneReady) beginBattleAfterCountdown(room);
}

function startBattle(room) {
  if (!room.players.every(function (playerId) { return !!players[playerId]; })) return;
  if (room.gameMode === 'sprint') { startSprint(room); return; }
  clearBotActionTimers(room);
  room.matchId = 'match_' + cryptoRandomId();
  room.startedAt = null;
  room.leaderboardRecorded = false;
  room.forcedWinnerIdx = null;
  room.paused = false;
  room.timerFrozen = false;
  room.questionVersion++;
  const p1Id = room.players[0];
  const p2Id = room.players[1];
  const settings = room.settings;

  const p1Cards = dealCards();
  const p2Cards = dealCards();

  room.gameState = {
    players: [
      { name: players[p1Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: p1Cards, activeEffects: {}, tableStats: {}, cardUsage: {} },
      { name: players[p2Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: p2Cards, activeEffects: {}, tableStats: {}, cardUsage: {} }
    ]
  };

  room.currentPlayer = 0;
  room.round = 0;
  room.weakQuestions = [];
  room.battleActive = false;
  prepareBattleCountdown(room);

  // Send initial game state to both players
  sendToPlayer(p1Id, {
    type: 'gameStart',
    you: 0,
    gameMode: room.gameMode,
    settings: room.settings,
    players: room.gameState.players,
    yourCards: p1Cards
  });

  sendToPlayer(p2Id, {
    type: 'gameStart',
    you: 1,
    gameMode: room.gameMode,
    settings: room.settings,
    players: room.gameState.players,
    yourCards: p2Cards
  });

}

function nextTurn(room) {
  if (!room.battleActive) return;

  room.round++;
  room.currentPlayer = (room.round - 1) % 2;

  // Generate question
  let question;
  if (room.weakQuestions.length > 0 && Math.random() < 0.3) {
    const wq = room.weakQuestions[Math.floor(Math.random() * room.weakQuestions.length)];
    question = { a: wq.a, b: wq.b, answer: wq.a * wq.b, isWeak: true, table: wq.table };
  } else {
    question = generateQuestion(room.settings.sifir, room.settings.difficulty);
  }
  room.currentQuestion = question;
  room.questionVersion++;
  room.questionStartTime = Date.now();

  // Start timer
  room.timerFrozen = false;
  startTimer(room);

  // Notify both players
  broadcast(room, {
    type: 'newTurn',
    round: room.round,
    currentPlayer: room.currentPlayer,
    question: { a: question.a, b: question.b, isWeak: question.isWeak },
    timer: room.settings.timer
  });
  scheduleBotTurn(room);
}

function clearBotActionTimers(room) {
  if (!room || !Array.isArray(room.botActionTimers)) return;
  room.botActionTimers.forEach(clearTimeout);
  room.botActionTimers = [];
  if (Array.isArray(room.botSprintTimers)) {
    room.botSprintTimers.forEach(clearTimeout);
    room.botSprintTimers = [null, null];
  }
}

function finishQuestion(room) {
  clearBotActionTimers(room);
  room.currentQuestion = null;
  room.questionVersion++;
}

function availableCardIndex(player, cardId) {
  return player.cards.findIndex(function (card) { return card.id === cardId && !card.used; });
}

function chooseBotCardIndex(room, playerIdx, bot) {
  if (Math.random() > bot.cardChance) return -1;
  const player = room.gameState.players[playerIdx];
  const opponent = room.gameState.players[1 - playerIdx];
  let priorities = [];
  if (bot.level === 'smart') {
    if (player.hp <= 45) priorities.push('healPotion');
    if (opponent.hp <= 20 || player.hp <= 35) priorities.push('stealHP');
    if (player.streak >= 2) priorities.push('doubleStrike', 'streakBoost');
    if (player.hp <= 55) priorities.push('mirrorShield', 'shield', 'secondChance');
    priorities.push('doubleStrike', 'streakBoost', 'timeFreeze', 'revealHint', 'skipQuestion');
  } else if (bot.level === 'medium') {
    if (player.hp <= 35) priorities.push('healPotion', 'shield');
    priorities.push('doubleStrike', 'streakBoost', 'secondChance', 'stealHP', 'revealHint');
  } else {
    priorities = ['revealHint', 'shield', 'healPotion', 'streakBoost', 'skipQuestion'];
  }
  for (const cardId of priorities) {
    const index = availableCardIndex(player, cardId);
    if (index !== -1) return index;
  }
  return -1;
}

function scheduleBotTurn(room) {
  if (!room.battleActive || !room.currentQuestion) return;
  const botId = room.players[room.currentPlayer];
  const botPlayer = players[botId];
  if (!botPlayer || !botPlayer.isBot || !botPlayer.bot) return;

  clearBotActionTimers(room);
  const version = room.questionVersion;
  const bot = botPlayer.bot;
  const responseRatio = botCatalog.randomBetween(bot.responseMin, bot.responseMax);
  const responseDelay = Math.max(350, Math.round(room.settings.timer * responseRatio * 1000));
  const cardIdx = chooseBotCardIndex(room, room.currentPlayer, bot);

  if (cardIdx !== -1 && responseDelay > 700) {
    room.botActionTimers.push(setTimeout(function () {
      if (!room.battleActive || room.questionVersion !== version || room.currentPlayer !== botPlayer.playerIdx) return;
      handleCardActivate(room, botId, cardIdx);
    }, Math.min(500, Math.floor(responseDelay / 3))));
  }

  room.botActionTimers.push(setTimeout(function () {
    if (!room.battleActive || room.questionVersion !== version || room.currentPlayer !== botPlayer.playerIdx || !room.currentQuestion) return;
    const correct = Math.random() < bot.accuracy;
    const answer = correct ? room.currentQuestion.answer : botCatalog.plausibleWrongAnswer(room.currentQuestion);
    handleAnswer(room, botId, answer);
  }, responseDelay));
}

function startTimer(room, duration) {
  clearInterval(room.timerInterval);
  const timerDuration = Number(duration) > 0 ? Number(duration) : room.settings.timer;
  room.timeLeft = timerDuration;
  const startTime = Date.now();
  room.questionStartTime = startTime;

  room.timerInterval = setInterval(function () {
    room.timeLeft = timerDuration - (Date.now() - startTime) / 1000;
    if (room.timeLeft <= 0) {
      room.timeLeft = 0;
      clearInterval(room.timerInterval);
      handleTimeout(room);
    }
  }, 100);
}

function stopTimer(room) {
  clearInterval(room.timerInterval);
}

function handleAnswer(room, playerId, answer) {
  if (!room.battleActive) return;
  if (room.gameMode === 'sprint') { handleSprintAnswer(room, playerId, answer); return; }
  if (!room.currentQuestion) return;
  const playerIdx = players[playerId].playerIdx;
  if (playerIdx !== room.currentPlayer) return;

  stopTimer(room);
  const timeTaken = (Date.now() - room.questionStartTime) / 1000;
  const player = room.gameState.players[playerIdx];
  const opponent = room.gameState.players[1 - playerIdx];
  const userAnswer = parseInt(answer);

  if (isNaN(userAnswer) || userAnswer !== room.currentQuestion.answer) {
    handleWrong(room, player, playerIdx);
  } else {
    handleCorrect(room, player, opponent, playerIdx, timeTaken);
  }

  broadcast(room, { type: 'stateSync', players: room.gameState.players });

  finishQuestion(room);

  setTimeout(function () {
    if (checkWin(room)) return;
    nextTurn(room);
  }, TURN_DELAY);
}

function handleCorrect(room, player, opponent, playerIdx, timeTaken) {
  player.correct++;
  player.streak++;
  recordTableAttempt(player, room.currentQuestion, true);
  player.score += SCORE_PER_CORRECT;

  let damage = BASE_DAMAGE;
  let bonusMsg = '';

  if (timeTaken < room.settings.timer / 2) { damage += 5; bonusMsg += ' +5 (Fast!)'; }
  if (player.streak >= 5) { damage += 10; bonusMsg += ' +10 (Streak 5!)'; }
  else if (player.streak >= 3) { damage += 5; bonusMsg += ' +5 (Streak 3!)'; }

  if (player.activeEffects.doubleStrike) {
    damage *= 2;
    bonusMsg += ' x2 (Double Strike!)';
    player.activeEffects.doubleStrike = false;
  }

  let actualDamage = damage;

  if (opponent.activeEffects.shield) {
    opponent.activeEffects.shield = false;
    actualDamage = 0;
    bonusMsg += ' (Blocked by Shield!)';
    broadcast(room, { type: 'cardEffect', effect: 'shieldBlock', target: 1 - playerIdx });
  } else if (opponent.activeEffects.mirrorShield) {
    opponent.activeEffects.mirrorShield = false;
    actualDamage = 0;
    player.hp = Math.max(0, player.hp - damage);
    bonusMsg += ' (Reflected by Mirror!)';
    broadcast(room, { type: 'cardEffect', effect: 'mirrorReflect', target: playerIdx, damage: damage });
  } else {
    opponent.hp = Math.max(0, opponent.hp - actualDamage);
  }

  broadcast(room, {
    type: 'answerResult',
    correct: true,
    playerIdx: playerIdx,
    answer: room.currentQuestion.answer,
    damage: actualDamage,
    bonusMsg: bonusMsg
  });
}

function handleWrong(room, player, playerIdx) {
  recordTableAttempt(player, room.currentQuestion, false);
  if (player.activeEffects.secondChance) {
    player.activeEffects.secondChance = false;
    room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b, table: room.currentQuestion.table });
    broadcast(room, {
      type: 'answerResult',
      correct: false,
      playerIdx: playerIdx,
      answer: room.currentQuestion.answer,
      secondChance: true
    });
    return;
  }

  player.wrong++;
  player.streak = 0;
  player.hp = Math.max(0, player.hp - WRONG_DAMAGE);
  room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b, table: room.currentQuestion.table });

  broadcast(room, {
    type: 'answerResult',
    correct: false,
    playerIdx: playerIdx,
    answer: room.currentQuestion.answer,
    damage: 5
  });
}

function handleTimeout(room) {
  if (!room.battleActive || !room.currentQuestion) return;
  const player = room.gameState.players[room.currentPlayer];
  recordTableAttempt(player, room.currentQuestion, false);

  if (player.activeEffects.secondChance) {
    player.activeEffects.secondChance = false;
    room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b, table: room.currentQuestion.table });
    broadcast(room, {
      type: 'timeout',
      playerIdx: room.currentPlayer,
      answer: room.currentQuestion.answer,
      secondChance: true
    });
    broadcast(room, { type: 'stateSync', players: room.gameState.players });
    finishQuestion(room);
    setTimeout(function () {
      if (checkWin(room)) return;
      nextTurn(room);
    }, TURN_DELAY);
    return;
  }

  player.wrong++;
  player.streak = 0;
  player.hp = Math.max(0, player.hp - TIMEOUT_DAMAGE);
  room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b, table: room.currentQuestion.table });

  broadcast(room, {
    type: 'timeout',
    playerIdx: room.currentPlayer,
    answer: room.currentQuestion.answer,
    damage: 8
  });
  broadcast(room, { type: 'stateSync', players: room.gameState.players });
  finishQuestion(room);

  setTimeout(function () {
    if (checkWin(room)) return;
    nextTurn(room);
  }, TURN_DELAY);
}

function handleCardActivate(room, playerId, cardIdx) {
  if (!room.battleActive) return;
  const playerIdx = players[playerId].playerIdx;
  if (playerIdx !== room.currentPlayer) return;

  const player = room.gameState.players[playerIdx];
  const card = player.cards[cardIdx];
  if (!card || card.used) return;

  let cardResult = { type: 'cardActivated', playerIdx: playerIdx, cardIdx: cardIdx, cardId: card.id, cardName: card.name };

  switch (card.id) {
    case 'doubleStrike':
      player.activeEffects.doubleStrike = true;
      break;
    case 'shield':
      player.activeEffects.shield = true;
      break;
    case 'timeFreeze':
      stopTimer(room);
      room.timerFrozen = true;
      cardResult.timerFrozen = true;
      break;
    case 'healPotion':
      var healAmt = Math.min(20, player.maxHP - player.hp);
      player.hp += healAmt;
      cardResult.healAmt = healAmt;
      break;
    case 'revealHint':
      var hint = room.currentQuestion.answer % 2 === 0 ? 'EVEN' : 'ODD';
      cardResult.hint = hint;
      break;
    case 'skipQuestion':
      cardResult.skipQuestion = true;
      break;
    case 'stealHP':
      var opp = room.gameState.players[1 - playerIdx];
      var steal = Math.min(15, opp.hp);
      opp.hp -= steal;
      player.hp = Math.min(player.maxHP, player.hp + steal);
      cardResult.steal = steal;
      break;
    case 'secondChance':
      player.activeEffects.secondChance = true;
      break;
    case 'streakBoost':
      player.streak += 3;
      cardResult.newStreak = player.streak;
      break;
    case 'mirrorShield':
      player.activeEffects.mirrorShield = true;
      break;
  }

  card.used = true;
  player.cardUsage[card.id] = (player.cardUsage[card.id] || 0) + 1;
  broadcast(room, cardResult);
  broadcast(room, { type: 'stateSync', players: room.gameState.players });
  if (checkWin(room)) return;

  // If skip question, generate new question
  if (card.id === 'skipQuestion') {
    stopTimer(room);
    finishQuestion(room);
    setTimeout(function () {
      if (!room.battleActive) return;
      let question;
      if (room.weakQuestions.length > 0 && Math.random() < 0.3) {
        var wq = room.weakQuestions[Math.floor(Math.random() * room.weakQuestions.length)];
        question = { a: wq.a, b: wq.b, answer: wq.a * wq.b, isWeak: true, table: wq.table };
      } else {
        question = generateQuestion(room.settings.sifir, room.settings.difficulty);
      }
      room.currentQuestion = question;
      room.questionVersion++;
      room.questionStartTime = Date.now();
      room.timerFrozen = false;
      startTimer(room);
      broadcast(room, {
        type: 'newQuestion',
        question: { a: question.a, b: question.b, isWeak: question.isWeak },
        timer: room.settings.timer
      });
      scheduleBotTurn(room);
    }, 500);
  }
}

/* ==================== SPRINT MODE ==================== */
function startSprint(room) {
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  clearBotActionTimers(room);
  room.matchId = 'match_' + cryptoRandomId();
  room.startedAt = null;
  room.leaderboardRecorded = false;
  room.forcedWinnerIdx = null;
  room.paused = false;
  room.timerFrozen = false;
  const sprintDuration = room.settings.sprintTime || SPRINT_DURATION;
  const p1Id = room.players[0];
  const p2Id = room.players[1];

  room.gameState = {
    players: [
      { name: players[p1Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: [], activeEffects: {}, tableStats: {}, cardUsage: {} },
      { name: players[p2Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: [], activeEffects: {}, tableStats: {}, cardUsage: {} }
    ]
  };

  room.round = 0;
  room.battleActive = false;
  prepareBattleCountdown(room);
  room.sprintTimeLeft = sprintDuration;
  room.sprintQuestionVersions = [0, 0];
  room.botSprintTimers = [null, null];

  sendToPlayer(p1Id, { type: 'gameStart', you: 0, gameMode: room.gameMode, settings: room.settings, players: room.gameState.players, yourCards: [], sprint: true });
  sendToPlayer(p2Id, { type: 'gameStart', you: 1, gameMode: room.gameMode, settings: room.settings, players: room.gameState.players, yourCards: [], sprint: true });
}

function sendSprintQuestion(room, playerIdx) {
  if (!room.battleActive) return;
  const q = generateQuestion(room.settings.sifir, room.settings.difficulty);
  room.sprintQuestions[playerIdx] = q;
  room.sprintQuestionVersions[playerIdx]++;
  const playerId = room.players[playerIdx];
  sendToPlayer(playerId, {
    type: 'newTurn',
    round: 0,
    currentPlayer: playerIdx,
    question: { a: q.a, b: q.b, isWeak: q.isWeak },
    timer: room.settings.timer,
    sprint: true
  });
  scheduleBotSprintAnswer(room, playerIdx);
}

function scheduleBotSprintAnswer(room, playerIdx) {
  const botId = room.players[playerIdx];
  const botPlayer = players[botId];
  if (!botPlayer || !botPlayer.isBot || !botPlayer.bot) return;
  clearTimeout(room.botSprintTimers[playerIdx]);
  const version = room.sprintQuestionVersions[playerIdx];
  const bot = botPlayer.bot;
  let delayRange;
  if (bot.level === 'smart') delayRange = [800, 1700];
  else if (bot.level === 'medium') delayRange = [1800, 3200];
  else delayRange = [3200, 5500];
  const responseDelay = Math.round(botCatalog.randomBetween(delayRange[0], delayRange[1]));
  room.botSprintTimers[playerIdx] = setTimeout(function () {
    if (!room.battleActive || room.sprintQuestionVersions[playerIdx] !== version || !room.sprintQuestions[playerIdx]) return;
    const question = room.sprintQuestions[playerIdx];
    const correct = Math.random() < bot.accuracy;
    const answer = correct ? question.answer : botCatalog.plausibleWrongAnswer(question);
    handleSprintAnswer(room, botId, answer);
  }, responseDelay);
}

function finishSprintQuestion(room, playerIdx) {
  clearTimeout(room.botSprintTimers[playerIdx]);
  room.botSprintTimers[playerIdx] = null;
  room.sprintQuestions[playerIdx] = null;
  room.sprintQuestionVersions[playerIdx]++;
}

function handleSprintAnswer(room, playerId, answer) {
  if (!room.battleActive) return;
  const playerIdx = players[playerId].playerIdx;
  const player = room.gameState.players[playerIdx];
  const question = room.sprintQuestions[playerIdx];
  if (!question) return;

  const userAnswer = parseInt(answer);
  const isCorrect = !isNaN(userAnswer) && userAnswer === question.answer;
  recordTableAttempt(player, question, isCorrect);

  if (isCorrect) {
    player.correct++;
    player.streak++;
    player.score += SCORE_PER_CORRECT;
  } else {
    player.wrong++;
    player.streak = 0;
  }

  sendToPlayer(playerId, {
    type: 'answerResult',
    correct: isCorrect,
    playerIdx: playerIdx,
    answer: question.answer,
    sprint: true
  });

  broadcast(room, { type: 'stateSync', players: room.gameState.players, sprint: true });
  finishSprintQuestion(room, playerIdx);

  // Immediately send next question
  setTimeout(function () {
    if (room.battleActive) sendSprintQuestion(room, playerIdx);
  }, 300);
}

function handleSprintTimeout(room, playerIdx) {
  if (!room.battleActive) return;
  const player = room.gameState.players[playerIdx];
  const question = room.sprintQuestions[playerIdx];
  if (!question) return;
  recordTableAttempt(player, question, false);

  player.wrong++;
  player.streak = 0;

  const playerId = room.players[playerIdx];
  sendToPlayer(playerId, {
    type: 'timeout',
    playerIdx: playerIdx,
    answer: question.answer,
    sprint: true
  });

  broadcast(room, { type: 'stateSync', players: room.gameState.players, sprint: true });
  finishSprintQuestion(room, playerIdx);

  setTimeout(function () {
    if (room.battleActive) sendSprintQuestion(room, playerIdx);
  }, 300);
}

function endSprint(room) {
  room.battleActive = false;
  clearInterval(room.sprintInterval);
  clearBotActionTimers(room);

  const p0 = room.gameState.players[0];
  const p1 = room.gameState.players[1];
  let winnerIdx;
  if (room.forcedWinnerIdx === 0 || room.forcedWinnerIdx === 1) winnerIdx = room.forcedWinnerIdx;
  else if (p0.correct > p1.correct) winnerIdx = 0;
  else if (p1.correct > p0.correct) winnerIdx = 1;
  else {
    // Tie on correct — use accuracy
    const acc0 = p0.correct + p0.wrong > 0 ? p0.correct / (p0.correct + p0.wrong) : 0;
    const acc1 = p1.correct + p1.wrong > 0 ? p1.correct / (p1.correct + p1.wrong) : 0;
    winnerIdx = acc0 >= acc1 ? 0 : 1;
  }
  const winner = room.gameState.players[winnerIdx];

  broadcast(room, {
    type: 'gameOver',
    winnerIdx: winnerIdx,
    winnerName: winner.name,
    sprint: true,
    ranked: isRankedRoom(room),
    learningReports: getLearningReports(room),
    stats: {
      score: winner.score,
      correct: winner.correct,
      wrong: winner.wrong,
      accuracy: winner.correct + winner.wrong > 0 ? Math.round((winner.correct / (winner.correct + winner.wrong)) * 100) : 0
    }
  });
  recordRoomLeaderboard(room, winnerIdx);
}

function checkWin(room) {
  for (let i = 0; i < room.gameState.players.length; i++) {
    if (room.gameState.players[i].hp <= 0) {
      room.battleActive = false;
      stopTimer(room);
      clearBotActionTimers(room);
      room.currentQuestion = null;
      room.questionVersion++;
      const winnerIdx = 1 - i;
      const winner = room.gameState.players[winnerIdx];
      broadcast(room, {
        type: 'gameOver',
        winnerIdx: winnerIdx,
        winnerName: winner.name,
        ranked: isRankedRoom(room),
        learningReports: getLearningReports(room),
        stats: {
          score: winner.score,
          correct: winner.correct,
          wrong: winner.wrong,
          accuracy: winner.correct + winner.wrong > 0 ? Math.round((winner.correct / (winner.correct + winner.wrong)) * 100) : 0
        }
      });
      recordRoomLeaderboard(room, winnerIdx);
      return true;
    }
  }
  return false;
}

function destroyRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.battleActive = false;
  clearTimeout(room.countdownFallback);
  stopTimer(room);
  clearBotActionTimers(room);
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  room.players.forEach(function (playerId) {
    if (players[playerId] && players[playerId].isBot) delete players[playerId];
  });
  delete rooms[roomCode];
}

function handleDisconnect(playerId) {
  const player = players[playerId];
  if (!player) return;
  cancelQuickMatch(playerId, false);
  const roomCode = player.roomCode;
  const room = roomCode ? rooms[roomCode] : null;
  delete players[playerId];
  if (!room) return;

  // Remove this player from the room's player list
  const idx = room.players.indexOf(playerId);
  if (idx !== -1) room.players.splice(idx, 1);

  // No opponents left (e.g. creator left while waiting) -> delete room immediately
  if (room.players.length === 0 || room.players.every(function (remainingId) { return players[remainingId] && players[remainingId].isBot; })) {
    destroyRoom(roomCode);
    return;
  }

  broadcast(room, { type: 'opponentLeft' });
  stopTimer(room);
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  room.battleActive = false;
  // Remove room after delay
  setTimeout(function () {
    destroyRoom(roomCode);
  }, 5000);
}

function pauseRoomForReconnect(room, playerId) {
  if (!room || room.paused || !room.battleActive) return;
  room.paused = true;
  room.disconnectedPlayerId = playerId;
  room.battleActive = false;
  room.pausedTimeLeft = Math.max(0.1, Number(room.timeLeft) || Number(room.settings.timer) || 20);
  room.pausedSprintTimeLeft = Math.max(1, Number(room.sprintTimeLeft) || Number(room.settings.sprintTime) || SPRINT_DURATION);
  stopTimer(room);
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  clearBotActionTimers(room);
  broadcast(room, { type: 'opponentReconnecting', graceSeconds: Math.ceil(RANKED_RECONNECT_GRACE_MS / 1000) });
}

function startSprintClock(room, duration) {
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  const sprintDuration = Math.max(1, Math.ceil(Number(duration) || SPRINT_DURATION));
  const sprintStart = Date.now();
  room.sprintTimeLeft = sprintDuration;
  room.sprintInterval = setInterval(function () {
    if (!room.battleActive) return;
    room.sprintTimeLeft = sprintDuration - Math.floor((Date.now() - sprintStart) / 1000);
    if (room.sprintTimeLeft <= 0) {
      room.sprintTimeLeft = 0;
      clearInterval(room.sprintInterval);
      endSprint(room);
      return;
    }
    broadcast(room, { type: 'sprintTick', timeLeft: room.sprintTimeLeft });
  }, 1000);
}

function resumeRoomAfterReconnect(room, playerId) {
  if (!room || !room.paused || room.disconnectedPlayerId !== playerId) return;
  room.paused = false;
  room.disconnectedPlayerId = null;
  room.battleActive = true;
  const idx = players[playerId].playerIdx;
  sendToPlayer(playerId, {
    type: 'matchResume',
    you: idx,
    gameMode: room.gameMode,
    settings: room.settings,
    players: room.gameState.players,
    yourCards: room.gameState.players[idx].cards || [],
    round: room.round,
    currentPlayer: room.currentPlayer,
    question: room.currentQuestion ? { a: room.currentQuestion.a, b: room.currentQuestion.b, isWeak: room.currentQuestion.isWeak } : null,
    timer: room.pausedTimeLeft,
    sprint: room.gameMode === 'sprint',
    sprintTimeLeft: room.pausedSprintTimeLeft
  });
  broadcast(room, { type: 'opponentReconnected' });
  if (room.gameMode === 'sprint') {
    startSprintClock(room, room.pausedSprintTimeLeft);
    for (let i = 0; i < 2; i++) {
      if (room.sprintQuestions[i]) {
        sendToPlayer(room.players[i], { type: 'newTurn', round: 0, currentPlayer: i, question: { a: room.sprintQuestions[i].a, b: room.sprintQuestions[i].b }, timer: room.settings.timer, sprint: true });
        scheduleBotSprintAnswer(room, i);
      } else sendSprintQuestion(room, i);
    }
  } else if (room.currentQuestion) {
    startTimer(room, room.pausedTimeLeft);
    broadcast(room, { type: 'newTurn', round: room.round, currentPlayer: room.currentPlayer, question: { a: room.currentQuestion.a, b: room.currentQuestion.b, isWeak: room.currentQuestion.isWeak }, timer: room.pausedTimeLeft, resumed: true });
    scheduleBotTurn(room);
  } else {
    nextTurn(room);
  }
}

function forfeitRankedMatch(playerId, preserveConnection) {
  const player = players[playerId];
  const room = player && rooms[player.roomCode];
  if (!room || !room.gameState || room.leaderboardRecorded) return handleDisconnect(playerId);
  const loserIdx = player.playerIdx;
  room.paused = false;
  room.disconnectedPlayerId = null;
  room.battleActive = true;
  if (room.gameMode === 'sprint') {
    room.forcedWinnerIdx = 1 - loserIdx;
    endSprint(room);
  } else {
    room.gameState.players[loserIdx].hp = 0;
    checkWin(room);
  }
  if (preserveConnection && players[playerId]) players[playerId].roomCode = null;
  setTimeout(function () {
    room.players.forEach(function (pid) { if (players[pid]) { players[pid].roomCode = null; players[pid].playerIdx = 0; } });
    destroyRoom(room.code);
    if (!preserveConnection) delete players[playerId];
  }, 5000);
}

function handleSocketDisconnect(playerId, immediateForfeit) {
  const player = players[playerId];
  if (!player) return;
  if (!immediateForfeit && player.accountId && disconnectedPlayers.has(player.accountId) && !player.ws) return;
  cancelQuickMatch(playerId, false);
  const room = player.roomCode ? rooms[player.roomCode] : null;
  if (room && room.battleActive && isRankedRoom(room) && !player.isBot) {
    player.ws = null;
    if (immediateForfeit) return forfeitRankedMatch(playerId, false);
    pauseRoomForReconnect(room, playerId);
    const existing = disconnectedPlayers.get(player.accountId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(function () {
      disconnectedPlayers.delete(player.accountId);
      forfeitRankedMatch(playerId, false);
    }, RANKED_RECONNECT_GRACE_MS);
    disconnectedPlayers.set(player.accountId, { playerId: playerId, timer: timer });
    return;
  }
  handleDisconnect(playerId);
}

function leavePlayerRoom(playerId) {
  const player = players[playerId];
  if (!player) return;
  cancelQuickMatch(playerId, false);
  const room = player.roomCode ? rooms[player.roomCode] : null;
  if (!room) { player.roomCode = null; return; }
  if (room.battleActive && isRankedRoom(room)) {
    forfeitRankedMatch(playerId, true);
    return;
  }
  room.battleActive = false;
  stopTimer(room); clearBotActionTimers(room);
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  broadcast(room, { type: 'opponentLeft' });
  room.players.forEach(function (pid) { if (players[pid]) { players[pid].roomCode = null; players[pid].playerIdx = 0; } });
  player.roomCode = null;
  destroyRoom(room.code);
}

/* ==================== MESSAGING ==================== */
function sendToPlayer(playerId, message) {
  const player = players[playerId];
  if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message) {
  room.players.forEach(function (pid) {
    sendToPlayer(pid, message);
  });
}

/* ==================== HTTP SERVER ==================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveFile(filePath, res, allow404) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      if (allow404) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(500); res.end('Error loading file'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach(function (part) {
    const separator = part.indexOf('=');
    if (separator < 1) return;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch (error) {}
  });
  return cookies;
}

function sessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SECURE_SESSION_COOKIE] || cookies[SESSION_COOKIE] || '';
}

function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const secure = isSecureRequest(req);
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  return name + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

function clearSessionCookies(req) {
  const expires = '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
  return [SESSION_COOKIE + expires, SECURE_SESSION_COOKIE + expires + '; Secure'];
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function consumeAttemptKey(key, limit, now) {
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  if (current.count >= limit) return false;
  current.count++;
  return true;
}

function consumeAuthAttempt(req, identity) {
  const now = Date.now();
  if (authAttempts.size > 5000) {
    authAttempts.forEach(function (entry, key) {
      if (entry.resetAt <= now) authAttempts.delete(key);
    });
  }
  const ip = clientIp(req);
  const normalizedIdentity = typeof identity === 'string' ? identity.trim().toLowerCase().slice(0, 254) : '';
  if (!consumeAttemptKey('ip:' + ip, AUTH_IP_MAX_ATTEMPTS, now)) return false;
  return consumeAttemptKey('login:' + ip + ':' + normalizedIdentity, AUTH_MAX_ATTEMPTS, now);
}

function requestHasValidOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch (error) {
    return false;
  }
}

function readJsonBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let body = '';
    let finished = false;
    req.setEncoding('utf8');
    req.on('data', function (chunk) {
      if (finished) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > limit) {
        finished = true;
        reject(Object.assign(new Error('Request body is too large'), { code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', function () {
      if (finished) return;
      try {
        const value = body ? JSON.parse(body) : {};
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function authErrorStatus(error) {
  if (error.code === 'INVALID_CREDENTIALS') return 401;
  if (error.code === 'EMAIL_TAKEN' || error.code === 'PLAYER_NAME_TAKEN') return 409;
  if (error.code === 'LEADERBOARD_UNAVAILABLE') return 503;
  if (error.code === 'PROFILE_NOT_FOUND') return 404;
  if (error.code === 'PROFILE_NOT_EDITABLE') return 403;
  if (String(error.code || '').startsWith('INVALID_') || error.code === 'BODY_TOO_LARGE') return 400;
  return 500;
}

async function handleProfileRequest(req, res) {
  try {
    const account = await leaderboard.getAccountBySession(sessionToken(req));
    if (!account) { sendJson(res, 401, { error: 'Login diperlukan.' }); return; }
    if (req.method === 'GET') {
      const requestUrl = new URL(req.url, 'http://localhost');
      const playerName = requestUrl.searchParams.get('player') || account.playerName;
      const profile = await leaderboard.getPlayerProfile(playerName, account.accountId);
      if (!profile) { sendJson(res, 404, { error: 'Profile tidak ditemui.' }); return; }
      sendJson(res, 200, { profile: profile });
      return;
    }
    if (req.method === 'PATCH') {
      if (!requestHasValidOrigin(req)) { sendJson(res, 403, { error: 'Permintaan tidak dibenarkan.' }); return; }
      const body = await readJsonBody(req, 4 * 1024);
      const updated = await leaderboard.updateProfile(account.accountId, body);
      sendJson(res, 200, { profile: updated });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const status = authErrorStatus(error);
    sendJson(res, status, { error: status >= 500 ? 'Profile tidak tersedia buat sementara.' : error.message });
  }
}

async function handleRankedLadderRequest(req, res) {
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  try {
    const account = await leaderboard.getAccountBySession(sessionToken(req));
    if (!account) { sendJson(res, 401, { error: 'Login diperlukan.' }); return; }
    const requestUrl = new URL(req.url, 'http://localhost');
    const mode = requestUrl.searchParams.get('mode') || 'multiplayer';
    const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit')) || 10, 50));
    const ladder = await leaderboard.getRankedLadder(mode, limit);
    sendJson(res, 200, Object.assign({ mode: mode }, ladder));
  } catch (error) {
    sendJson(res, error.code === 'LEADERBOARD_UNAVAILABLE' ? 503 : 400, { error: error.message || 'Ranked ladder tidak tersedia.' });
  }
}

async function handleAuthRequest(req, res, urlPath) {
  if (urlPath === '/api/me') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    try {
      const account = await leaderboard.getAccountBySession(sessionToken(req));
      if (!account) { sendJson(res, 401, { error: 'Login diperlukan.' }); return; }
      sendJson(res, 200, { account: account });
    } catch (error) {
      sendJson(res, error.code === 'LEADERBOARD_UNAVAILABLE' ? 503 : 500, { error: 'Sistem akaun tidak tersedia buat sementara.' });
    }
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  if (!requestHasValidOrigin(req)) { sendJson(res, 403, { error: 'Permintaan tidak dibenarkan.' }); return; }

  if (urlPath === '/api/logout') {
    try { await leaderboard.logoutSession(sessionToken(req)); } catch (error) {}
    res.setHeader('Set-Cookie', clearSessionCookies(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    const body = await readJsonBody(req, 10 * 1024);
    if (!consumeAuthAttempt(req, body.email)) {
      res.setHeader('Retry-After', String(Math.ceil(AUTH_WINDOW_MS / 1000)));
      sendJson(res, 429, { error: 'Terlalu banyak cubaan. Cuba lagi dalam 15 minit.' });
      return;
    }
    const result = urlPath === '/api/register'
      ? await leaderboard.registerAccount(body)
      : await leaderboard.loginAccount(body);
    res.setHeader('Set-Cookie', sessionCookie(req, result.token));
    sendJson(res, urlPath === '/api/register' ? 201 : 200, { account: result.account });
  } catch (error) {
    const status = authErrorStatus(error);
    sendJson(res, status, { error: status === 500 ? 'Tidak dapat memproses permintaan.' : error.message });
  }
}

async function handleLeaderboardRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid request URL' });
    return;
  }
  const mode = requestUrl.searchParams.get('mode') || 'solo';
  if (!['solo', 'multiplayer', 'sprint'].includes(mode)) {
    sendJson(res, 400, { error: 'Invalid leaderboard mode' });
    return;
  }
  const requestedLimit = Number(requestUrl.searchParams.get('limit'));
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 10;
  try {
    const entries = await leaderboard.getLeaderboard(mode, limit);
    sendJson(res, 200, { mode: mode, entries: entries });
  } catch (error) {
    const unavailable = error.code === 'LEADERBOARD_UNAVAILABLE';
    sendJson(res, unavailable ? 503 : 500, {
      error: unavailable ? 'Leaderboard is temporarily unavailable' : 'Unable to load leaderboard'
    });
  }
}

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (urlPath === '/' || urlPath === '/client.html') {
    serveFile(path.join(__dirname, 'client.html'), res);
    return;
  }
  if (urlPath === '/health') {
    const leaderboardStatus = leaderboard.status();
    sendJson(res, 200, {
      status: 'ok',
      rooms: Object.keys(rooms).length,
      players: Object.keys(players).length,
      leaderboard: { configured: leaderboardStatus.configured, ready: leaderboardStatus.ready }
    });
    return;
  }
  if (urlPath === '/api/leaderboard') {
    handleLeaderboardRequest(req, res);
    return;
  }
  if (urlPath === '/api/profile') {
    handleProfileRequest(req, res);
    return;
  }
  if (urlPath === '/api/ranked-ladder') {
    handleRankedLadderRequest(req, res);
    return;
  }
  if (['/api/register', '/api/login', '/api/logout', '/api/me'].includes(urlPath)) {
    handleAuthRequest(req, res, urlPath);
    return;
  }
  const resolved = path.resolve(__dirname, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
  if (!resolved.startsWith(__dirname + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  serveFile(resolved, res, true);
});

/* ==================== WEBSOCKET SERVER ==================== */
const wss = new WebSocket.Server({ server: server });

wss.on('connection', async function connection(ws, req) {
  let account;
  try {
    account = await leaderboard.getAccountBySession(sessionToken(req));
  } catch (error) {
    ws.close(1013, 'Account service unavailable');
    return;
  }
  if (!account) {
    ws.close(4001, 'Login required');
    return;
  }
  let playerId;
  const reconnect = disconnectedPlayers.get(account.accountId);
  if (reconnect && players[reconnect.playerId]) {
    playerId = reconnect.playerId;
    clearTimeout(reconnect.timer);
    disconnectedPlayers.delete(account.accountId);
    players[playerId].ws = ws;
  } else {
    playerId = generatePlayerId();
    players[playerId] = {
      ws: ws,
      name: account.playerName,
      profileId: account.accountId,
      accountId: account.accountId,
      roomCode: null,
      playerIdx: 0
    };
  }

  sendToPlayer(playerId, { type: 'connected', playerId: playerId, playerName: account.playerName });
  if (reconnect && players[playerId] && players[playerId].roomCode) {
    resumeRoomAfterReconnect(rooms[players[playerId].roomCode], playerId);
  }

  ws.on('message', function incoming(rawMessage) {
    if (!players[playerId]) return;
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (e) {
      return;
    }

    switch (message.type) {
      case 'setName': {
        players[playerId].name = account.playerName;
        players[playerId].profileId = account.accountId;
        break;
      }

      case 'submitSoloResult':
        submitSoloLeaderboardResult(playerId, message);
        break;

      case 'startSoloSession':
        startSoloSession(playerId, message);
        break;

      case 'quickMatch':
        requestQuickMatch(playerId, message.gameMode);
        break;

      case 'cancelQuickMatch':
        cancelQuickMatch(playerId, true);
        break;

      case 'createRoom': {
        cancelQuickMatch(playerId, false);
        const settings = normalizeSettings(message.settings);
        const code = createRoom(playerId, settings);
        sendToPlayer(playerId, { type: 'roomCreated', code: code, gameMode: settings.gameMode, settings: settings });
        break;
      }

      case 'joinRoom': {
        cancelQuickMatch(playerId, false);
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        const joinResult = joinRoom(playerId, code);
        if (joinResult.error) {
          sendToPlayer(playerId, { type: 'joinError', error: joinResult.error });
        } else {
          const room = rooms[code];
          sendToPlayer(playerId, {
            type: 'roomJoined',
            code: code,
            gameMode: room.gameMode,
            settings: room.settings
          });
          if (room && room.players.length === 2) {
            const p1Id = room.players[0];
            const p2Id = room.players[1];
            sendToPlayer(p1Id, {
              type: 'opponentJoined',
              opponentName: players[p2Id].name,
              gameMode: room.gameMode,
              settings: room.settings
            });
            sendToPlayer(p2Id, {
              type: 'opponentJoined',
              opponentName: players[p1Id].name,
              gameMode: room.gameMode,
              settings: room.settings
            });
          }
        }
        break;
      }

      case 'startBattle': {
        const room = rooms[players[playerId].roomCode];
        if (room && room.players.length === 2 && !room.battleActive && !room.countdownPending) {
          startBattle(room);
        }
        break;
      }

      case 'battleReady': {
        const room = rooms[players[playerId].roomCode];
        if (room) handleBattleReady(room, playerId);
        break;
      }

      case 'answer': {
        const room = rooms[players[playerId].roomCode];
        if (room) handleAnswer(room, playerId, message.answer);
        break;
      }

      case 'sprintTimeout': {
        const room = rooms[players[playerId].roomCode];
        if (room && room.gameMode === 'sprint') {
          const idx = players[playerId].playerIdx;
          handleSprintTimeout(room, idx);
        }
        break;
      }

      case 'activateCard': {
        const room = rooms[players[playerId].roomCode];
        if (room) handleCardActivate(room, playerId, message.cardIdx);
        break;
      }

      case 'rematch': {
        const room = rooms[players[playerId].roomCode];
        if (room && room.players.length === 2 && !room.battleActive && !room.countdownPending) {
          startBattle(room);
        }
        break;
      }

      case 'leaveRoom':
        leavePlayerRoom(playerId);
        break;
    }
  });

  ws.on('close', function () {
    if (players[playerId] && players[playerId].ws && players[playerId].ws !== ws) return;
    handleSocketDisconnect(playerId, false);
  });

  ws.on('error', function () {
    if (players[playerId] && players[playerId].ws && players[playerId].ws !== ws) return;
    handleSocketDisconnect(playerId, false);
  });
});

wss.on('error', function (error) {
  console.error('WebSocket server error:', error.message);
});

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('ASMD Times Table Hero Arena server running on port ' + PORT);
  });
}

module.exports = { server: server, wss: wss };
