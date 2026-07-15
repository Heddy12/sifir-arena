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

const PORT = process.env.PORT || 3000;

/* ==================== CONSTANTS ==================== */
const SPRINT_DURATION = 60;
const TURN_DELAY = 1500;
const FIRST_TURN_DELAY = 2000;
const BASE_HP = 100;
const BASE_DAMAGE = 10;
const WRONG_DAMAGE = 5;
const TIMEOUT_DAMAGE = 8;
const FAST_BONUS = 5;
const SCORE_PER_CORRECT = 10;

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
  if (!isRankedSettings(room.settings, room.gameMode)) {
    broadcast(room, { type: 'leaderboardResult', mode: mode, eligible: false, recorded: false, reason: 'custom-settings' });
    return;
  }

  let operation;
  if (mode === 'sprint') {
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
    operation = Promise.all(writes);
  } else {
    const participants = room.players.map(function (playerId, index) {
      const profile = leaderboardProfile(playerId);
      if (!profile) return null;
      profile.winner = index === winnerIdx;
      return profile;
    }).filter(Boolean);
    operation = leaderboard.recordMultiplayerGame(participants);
  }

  operation.then(function () {
    broadcast(room, { type: 'leaderboardResult', mode: mode, eligible: true, recorded: true });
  }).catch(function (error) {
    console.error('Leaderboard result was not saved:', error.message);
    broadcast(room, { type: 'leaderboardResult', mode: mode, eligible: true, recorded: false, reason: 'database-unavailable' });
  });
}

function submitSoloLeaderboardResult(playerId, message) {
  const profile = leaderboardProfile(playerId);
  const settings = message && message.settings;
  const stats = normalizeResultStats(message && message.stats);
  if (!profile) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: true, recorded: false, reason: 'profile-required' });
    return;
  }
  if (!message.won) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: false, recorded: false, reason: 'win-required' });
    return;
  }
  if (!isRankedSettings(settings, 'solo')) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: false, recorded: false, reason: 'custom-settings' });
    return;
  }
  if (!stats) {
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: true, recorded: false, reason: 'invalid-result' });
    return;
  }
  leaderboard.recordBest(profile, 'solo', stats).then(function (result) {
    sendToPlayer(playerId, {
      type: 'leaderboardResult',
      mode: 'solo',
      eligible: true,
      recorded: true,
      improved: result.improved
    });
  }).catch(function (error) {
    console.error('Solo leaderboard result was not saved:', error.message);
    sendToPlayer(playerId, { type: 'leaderboardResult', mode: 'solo', eligible: true, recorded: false, reason: 'database-unavailable' });
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
    leaderboardRecorded: false
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

function startBattle(room) {
  if (room.gameMode === 'sprint') { startSprint(room); return; }
  room.leaderboardRecorded = false;
  room.timerFrozen = false;
  const p1Id = room.players[0];
  const p2Id = room.players[1];
  const settings = room.settings;

  const p1Cards = dealCards();
  const p2Cards = dealCards();

  room.gameState = {
    players: [
      { name: players[p1Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: p1Cards, activeEffects: {}, tableStats: {} },
      { name: players[p2Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: p2Cards, activeEffects: {}, tableStats: {} }
    ]
  };

  room.currentPlayer = 0;
  room.round = 0;
  room.weakQuestions = [];
  room.battleActive = true;

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

  // Start first round after a delay
  setTimeout(function () { nextTurn(room); }, FIRST_TURN_DELAY);
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
}

function startTimer(room) {
  clearInterval(room.timerInterval);
  room.timeLeft = room.settings.timer;
  const startTime = Date.now();
  room.questionStartTime = startTime;

  room.timerInterval = setInterval(function () {
    room.timeLeft = room.settings.timer - (Date.now() - startTime) / 1000;
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

  room.currentQuestion = null;

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
  broadcast(room, cardResult);
  broadcast(room, { type: 'stateSync', players: room.gameState.players });

  // If skip question, generate new question
  if (card.id === 'skipQuestion') {
    setTimeout(function () {
      if (!room.battleActive) return;
      let question;
      if (room.weakQuestions.length > 0 && Math.random() < 0.3) {
        var wq = room.weakQuestions[Math.floor(Math.random() * room.weakQuestions.length)];
        question = { a: wq.a, b: wq.b, answer: wq.a * wq.b, isWeak: true };
      } else {
        question = generateQuestion(room.settings.sifir, room.settings.difficulty);
      }
      room.currentQuestion = question;
      room.questionStartTime = Date.now();
      room.timerFrozen = false;
      startTimer(room);
      broadcast(room, {
        type: 'newQuestion',
        question: { a: question.a, b: question.b, isWeak: question.isWeak },
        timer: room.settings.timer
      });
    }, 500);
  }
}

/* ==================== SPRINT MODE ==================== */
function startSprint(room) {
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  room.leaderboardRecorded = false;
  room.timerFrozen = false;
  const sprintDuration = room.settings.sprintTime || SPRINT_DURATION;
  const p1Id = room.players[0];
  const p2Id = room.players[1];

  room.gameState = {
    players: [
      { name: players[p1Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: [], activeEffects: {}, tableStats: {} },
      { name: players[p2Id].name, hp: BASE_HP, maxHP: BASE_HP, score: 0, streak: 0, correct: 0, wrong: 0, cards: [], activeEffects: {}, tableStats: {} }
    ]
  };

  room.round = 0;
  room.battleActive = true;
  room.sprintTimeLeft = sprintDuration;

  sendToPlayer(p1Id, { type: 'gameStart', you: 0, gameMode: room.gameMode, settings: room.settings, players: room.gameState.players, yourCards: [], sprint: true });
  sendToPlayer(p2Id, { type: 'gameStart', you: 1, gameMode: room.gameMode, settings: room.settings, players: room.gameState.players, yourCards: [], sprint: true });

  // Generate first question for each player
  room.sprintQuestions[0] = generateQuestion(room.settings.sifir, room.settings.difficulty);
  room.sprintQuestions[1] = generateQuestion(room.settings.sifir, room.settings.difficulty);

  // Start sprint match timer (60s)
  const sprintStart = Date.now();
  room.sprintInterval = setInterval(function () {
    room.sprintTimeLeft = sprintDuration - Math.floor((Date.now() - sprintStart) / 1000);
    if (room.sprintTimeLeft <= 0) {
      room.sprintTimeLeft = 0;
      clearInterval(room.sprintInterval);
      endSprint(room);
      return;
    }
    broadcast(room, { type: 'sprintTick', timeLeft: room.sprintTimeLeft });
  }, 1000);

  // Send first questions after a short delay
  setTimeout(function () {
    if (!room.battleActive) return;
    sendSprintQuestion(room, 0);
    sendSprintQuestion(room, 1);
  }, 1000);
}

function sendSprintQuestion(room, playerIdx) {
  if (!room.battleActive) return;
  const q = generateQuestion(room.settings.sifir, room.settings.difficulty);
  room.sprintQuestions[playerIdx] = q;
  const playerId = room.players[playerIdx];
  sendToPlayer(playerId, {
    type: 'newTurn',
    round: 0,
    currentPlayer: playerIdx,
    question: { a: q.a, b: q.b, isWeak: q.isWeak },
    timer: room.settings.timer,
    sprint: true
  });
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

  setTimeout(function () {
    if (room.battleActive) sendSprintQuestion(room, playerIdx);
  }, 300);
}

function endSprint(room) {
  room.battleActive = false;
  clearInterval(room.sprintInterval);

  const p0 = room.gameState.players[0];
  const p1 = room.gameState.players[1];
  let winnerIdx;
  if (p0.correct > p1.correct) winnerIdx = 0;
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
    ranked: isRankedSettings(room.settings, 'sprint'),
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
      const winnerIdx = 1 - i;
      const winner = room.gameState.players[winnerIdx];
      broadcast(room, {
        type: 'gameOver',
        winnerIdx: winnerIdx,
        winnerName: winner.name,
        ranked: isRankedSettings(room.settings, 'ffa'),
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

function handleDisconnect(playerId) {
  const player = players[playerId];
  if (!player) return;
  const roomCode = player.roomCode;
  const room = roomCode ? rooms[roomCode] : null;
  delete players[playerId];
  if (!room) return;

  // Remove this player from the room's player list
  const idx = room.players.indexOf(playerId);
  if (idx !== -1) room.players.splice(idx, 1);

  // No opponents left (e.g. creator left while waiting) -> delete room immediately
  if (room.players.length === 0) {
    if (room.sprintInterval) clearInterval(room.sprintInterval);
    stopTimer(room);
    delete rooms[roomCode];
    return;
  }

  broadcast(room, { type: 'opponentLeft' });
  stopTimer(room);
  if (room.sprintInterval) clearInterval(room.sprintInterval);
  room.battleActive = false;
  // Remove room after delay
  setTimeout(function () {
    delete rooms[roomCode];
  }, 5000);
}

/* ==================== MESSAGING ==================== */
function sendToPlayer(playerId, message) {
  const player = players[playerId];
  if (player && player.ws.readyState === WebSocket.OPEN) {
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
  const resolved = path.resolve(__dirname, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
  if (!resolved.startsWith(__dirname + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  serveFile(resolved, res, true);
});

/* ==================== WEBSOCKET SERVER ==================== */
const wss = new WebSocket.Server({ server: server });

wss.on('connection', function connection(ws) {
  const playerId = generatePlayerId();
  players[playerId] = { ws: ws, name: '', profileId: null, roomCode: null, playerIdx: 0 };

  sendToPlayer(playerId, { type: 'connected', playerId: playerId });

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
        let nm = (typeof message.name === 'string') ? message.name.trim() : '';
        if (nm.length > 20) nm = nm.slice(0, 20);
        players[playerId].name = nm || 'Player';
        players[playerId].profileId = leaderboard.normalizeProfileId(message.profileId);
        break;
      }

      case 'submitSoloResult':
        submitSoloLeaderboardResult(playerId, message);
        break;

      case 'createRoom': {
        const settings = normalizeSettings(message.settings);
        const code = createRoom(playerId, settings);
        sendToPlayer(playerId, { type: 'roomCreated', code: code, gameMode: settings.gameMode, settings: settings });
        break;
      }

      case 'joinRoom': {
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
        if (room && room.players.length === 2) {
          startBattle(room);
        }
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
        if (room && room.players.length === 2) {
          startBattle(room);
        }
        break;
      }

      case 'leaveRoom':
        handleDisconnect(playerId);
        break;
    }
  });

  ws.on('close', function () {
    handleDisconnect(playerId);
  });

  ws.on('error', function () {
    handleDisconnect(playerId);
  });
});

wss.on('error', function (error) {
  console.error('WebSocket server error:', error.message);
});

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

server.listen(PORT, function () {
  console.log('ASMD Times Table Hero Arena server running on port ' + PORT);
});
