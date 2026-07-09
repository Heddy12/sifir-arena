'use strict';

/**
 * ASMD Sifir Hero Arena - Fighter Edition
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

const PORT = process.env.PORT || 3000;

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
  return { a: a, b: b, answer: a * b, isWeak: false };
}

function createRoom(playerId, playerName, settings) {
  const code = generateRoomCode();
  rooms[code] = {
    code: code,
    players: [playerId],
    settings: settings,
    gameState: null,
    weakQuestions: [],
    currentQuestion: null,
    currentPlayer: 0,
    round: 0,
    timerInterval: null,
    timeLeft: 0,
    questionStartTime: 0,
    battleActive: false
  };
  players[playerId].roomCode = code;
  players[playerId].playerIdx = 0;
  return code;
}

function joinRoom(playerId, playerName, code) {
  const room = rooms[code];
  if (!room) return { error: 'Room not found' };
  if (room.players.length >= 2) return { error: 'Room is full' };
  room.players.push(playerId);
  players[playerId].roomCode = code;
  players[playerId].playerIdx = 1;
  return { success: true, room: room };
}

function startBattle(room) {
  const p1Id = room.players[0];
  const p2Id = room.players[1];
  const settings = room.settings;

  const p1Cards = dealCards();
  const p2Cards = dealCards();

  room.gameState = {
    players: [
      { name: players[p1Id].name, hp: 100, maxHP: 100, score: 0, streak: 0, correct: 0, wrong: 0, cards: p1Cards, activeEffects: {} },
      { name: players[p2Id].name, hp: 100, maxHP: 100, score: 0, streak: 0, correct: 0, wrong: 0, cards: p2Cards, activeEffects: {} }
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
    players: room.gameState.players,
    yourCards: p1Cards
  });

  sendToPlayer(p2Id, {
    type: 'gameStart',
    you: 1,
    players: room.gameState.players,
    yourCards: p2Cards
  });

  // Start first round after a delay
  setTimeout(function () { nextTurn(room); }, 2000);
}

function nextTurn(room) {
  if (!room.battleActive) return;

  room.round++;
  room.currentPlayer = (room.round - 1) % 2;

  // Generate question
  let question;
  if (room.weakQuestions.length > 0 && Math.random() < 0.3) {
    const wq = room.weakQuestions[Math.floor(Math.random() * room.weakQuestions.length)];
    question = { a: wq.a, b: wq.b, answer: wq.a * wq.b, isWeak: true };
  } else {
    question = generateQuestion(room.settings.sifir, room.settings.difficulty);
  }
  room.currentQuestion = question;
  room.questionStartTime = Date.now();

  // Start timer
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
  if (!room.battleActive || !room.currentQuestion) return;
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

  setTimeout(function () {
    if (checkWin(room)) return;
    nextTurn(room);
  }, 1500);
}

function handleCorrect(room, player, opponent, playerIdx, timeTaken) {
  player.correct++;
  player.streak++;

  const sifirKey = Math.max(room.currentQuestion.a, room.currentQuestion.b);
  player.score += 10;

  let damage = 10;
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
  if (player.activeEffects.secondChance) {
    player.activeEffects.secondChance = false;
    room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b });
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
  player.hp = Math.max(0, player.hp - 5);
  room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b });

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

  if (player.activeEffects.secondChance) {
    player.activeEffects.secondChance = false;
    room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b });
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
    }, 1500);
    return;
  }

  player.wrong++;
  player.streak = 0;
  player.hp = Math.max(0, player.hp - 8);
  room.weakQuestions.push({ a: room.currentQuestion.a, b: room.currentQuestion.b });

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
  }, 1500);
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
      startTimer(room);
      broadcast(room, {
        type: 'newQuestion',
        question: { a: question.a, b: question.b, isWeak: question.isWeak },
        timer: room.settings.timer
      });
    }, 500);
  }
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
        stats: {
          score: winner.score,
          correct: winner.correct,
          wrong: winner.wrong,
          accuracy: winner.correct + winner.wrong > 0 ? Math.round((winner.correct / (winner.correct + winner.wrong)) * 100) : 0
        }
      });
      return true;
    }
  }
  return false;
}

function handleDisconnect(playerId) {
  const player = players[playerId];
  if (!player) return;
  const room = rooms[player.roomCode];
  if (room) {
    broadcast(room, { type: 'opponentLeft' });
    stopTimer(room);
    room.battleActive = false;
    // Remove room after delay
    setTimeout(function () {
      delete rooms[player.roomCode];
    }, 5000);
  }
  delete players[playerId];
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
const server = http.createServer(function (req, res) {
  if (req.url === '/' || req.url === '/client.html' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'client.html');
    fs.readFile(filePath, function (err, data) {
      if (err) {
        res.writeHead(500);
        res.end('Error loading client.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: Object.keys(rooms).length, players: Object.keys(players).length }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

/* ==================== WEBSOCKET SERVER ==================== */
const wss = new WebSocket.Server({ server: server });

wss.on('connection', function connection(ws) {
  const playerId = generatePlayerId();
  players[playerId] = { ws: ws, name: '', roomCode: null, playerIdx: 0 };

  sendToPlayer(playerId, { type: 'connected', playerId: playerId });

  ws.on('message', function incoming(rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (e) {
      return;
    }

    switch (message.type) {
      case 'setName':
        players[playerId].name = message.name;
        break;

      case 'createRoom':
        var settings = message.settings || { timer: 6, sifir: 0, difficulty: 'random' };
        var code = createRoom(playerId, players[playerId].name, settings);
        sendToPlayer(playerId, { type: 'roomCreated', code: code });
        break;

      case 'joinRoom':
        var joinResult = joinRoom(playerId, players[playerId].name, message.code);
        if (joinResult.error) {
          sendToPlayer(playerId, { type: 'joinError', error: joinResult.error });
        } else {
          sendToPlayer(playerId, { type: 'roomJoined', code: message.code });
          // Notify player 1 that opponent joined
          var room = rooms[message.code];
          if (room && room.players.length === 2) {
            var p1Id = room.players[0];
            var p2Id = room.players[1];
            sendToPlayer(p1Id, {
              type: 'opponentJoined',
              opponentName: players[p2Id].name,
              settings: room.settings
            });
            sendToPlayer(p2Id, {
              type: 'opponentJoined',
              opponentName: players[p1Id].name,
              settings: room.settings
            });
          }
        }
        break;

      case 'startBattle':
        var room = rooms[players[playerId].roomCode];
        if (room && room.players.length === 2) {
          startBattle(room);
        }
        break;

      case 'answer':
        var room = rooms[players[playerId].roomCode];
        if (room) handleAnswer(room, playerId, message.answer);
        break;

      case 'activateCard':
        var room = rooms[players[playerId].roomCode];
        if (room) handleCardActivate(room, playerId, message.cardIdx);
        break;

      case 'rematch':
        var room = rooms[players[playerId].roomCode];
        if (room && room.players.length === 2) {
          startBattle(room);
        }
        break;

      case 'leaveRoom':
        handleDisconnect(playerId);
        break;
    }
  });

  ws.on('close', function () {
    handleDisconnect(playerId);
  });
});

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

server.listen(PORT, function () {
  console.log('ASMD Sifir Hero Arena server running on port ' + PORT);
});
