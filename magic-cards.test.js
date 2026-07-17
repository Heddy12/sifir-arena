'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const game = require('./server').__test;

function makeCard(cardId) {
  const definition = game.CARD_POOL.find(function (card) { return card.id === cardId; });
  assert.ok(definition, 'Unknown card: ' + cardId);
  return Object.assign({}, definition, { used: false });
}

function makeRoom(cardId, hp, opponentHp) {
  const events = [[], []];
  game.players.magic_p0 = {
    playerIdx: 0,
    ws: { readyState: 1, send: function (payload) { events[0].push(JSON.parse(payload)); } }
  };
  game.players.magic_p1 = {
    playerIdx: 1,
    ws: { readyState: 1, send: function (payload) { events[1].push(JSON.parse(payload)); } }
  };
  return {
    code: 'MAGIC',
    players: ['magic_p0', 'magic_p1'],
    settings: { timer: 6, sifir: 0, difficulty: 'random', gameMode: 'ffa' },
    gameMode: 'ffa',
    battleActive: true,
    currentPlayer: 0,
    currentQuestion: { a: 6, b: 7, answer: 42, table: 6 },
    questionVersion: 1,
    questionStartTime: Date.now(),
    timeLeft: 4,
    timerInterval: null,
    timeFreezeTimeout: null,
    timerFrozen: false,
    botActionTimers: [],
    weakQuestions: [],
    gameState: {
      players: [
        { hp: hp === undefined ? 80 : hp, maxHP: 100, score: 0, streak: 0, correct: 0, wrong: 0, cards: [makeCard(cardId)], activeEffects: {}, tableStats: {}, cardUsage: {} },
        { hp: opponentHp === undefined ? 100 : opponentHp, maxHP: 100, score: 0, streak: 0, correct: 0, wrong: 0, cards: [], activeEffects: {}, tableStats: {}, cardUsage: {} }
      ]
    },
    events: events
  };
}

function activate(room) {
  game.handleCardActivate(room, 'magic_p0', 0);
  return room.gameState.players[0];
}

function cleanup(room) {
  room.battleActive = false;
  clearInterval(room.timerInterval);
  clearTimeout(room.timeFreezeTimeout);
  delete game.players.magic_p0;
  delete game.players.magic_p1;
}

function run() {
  assert.strictEqual(game.CARD_POOL.length, 10, 'all 10 Magic Cards must be defined');
  assert.strictEqual(new Set(game.CARD_POOL.map(function (card) { return card.id; })).size, 10, 'Magic Card IDs must be unique');

  let room = makeRoom('doubleStrike');
  let player = activate(room);
  assert.strictEqual(player.activeEffects.doubleStrike, true);
  game.handleCorrect(room, player, room.gameState.players[1], 0, 2);
  assert.strictEqual(room.gameState.players[1].hp, 70, 'Double Strike doubles base + fast damage');
  assert.strictEqual(player.activeEffects.doubleStrike, false, 'Double Strike is consumed by the next correct answer');
  cleanup(room);

  room = makeRoom('shield');
  player = activate(room);
  game.handleCorrect(room, room.gameState.players[1], player, 1, 4);
  assert.strictEqual(player.hp, 80, 'Shield blocks the full next attack');
  assert.strictEqual(player.activeEffects.shield, false, 'Shield is consumed after blocking');
  cleanup(room);

  room = makeRoom('timeFreeze');
  player = activate(room);
  assert.strictEqual(room.timerFrozen, true);
  assert.strictEqual(player.cards[0].used, true);
  assert.ok(room.timeFreezeTimeout, 'Time Freeze must have a finite resume timer');
  assert.ok(room.events[0].some(function (event) { return event.type === 'cardActivated' && event.freezeSeconds === 3; }));
  cleanup(room);

  room = makeRoom('healPotion', 85);
  player = activate(room);
  assert.strictEqual(player.hp, 100, 'Heal Potion is capped at maximum HP');
  cleanup(room);

  room = makeRoom('healPotion', 100);
  player = activate(room);
  assert.strictEqual(player.cards[0].used, false, 'Heal Potion is not consumed at full HP');
  assert.ok(room.events[0].some(function (event) { return event.type === 'cardRejected'; }));
  cleanup(room);

  room = makeRoom('revealHint');
  activate(room);
  assert.ok(room.events[0].some(function (event) { return event.type === 'cardActivated' && event.hint === 'EVEN'; }));
  cleanup(room);

  room = makeRoom('skipQuestion');
  player = activate(room);
  assert.strictEqual(room.currentQuestion, null, 'Skip Question invalidates the old question immediately');
  assert.strictEqual(player.streak, 0, 'Skip Question has no streak penalty');
  assert.strictEqual(player.wrong, 0, 'Skip Question does not count as wrong');
  cleanup(room);

  room = makeRoom('stealHP', 95, 20);
  player = activate(room);
  assert.strictEqual(room.gameState.players[1].hp, 5, 'Steal HP drains exactly 15 HP when available');
  assert.strictEqual(player.hp, 100, 'Steal HP healing respects maximum HP');
  assert.ok(room.events[0].some(function (event) { return event.type === 'cardActivated' && event.steal === 15 && event.healed === 5; }));
  cleanup(room);

  room = makeRoom('secondChance');
  player = activate(room);
  player.streak = 4;
  game.handleWrong(room, player, 0);
  assert.strictEqual(player.hp, 80, 'Second Chance cancels wrong-answer damage');
  assert.strictEqual(player.wrong, 0, 'Second Chance cancels the wrong-answer stat penalty');
  assert.strictEqual(player.streak, 4, 'Second Chance preserves the streak');
  assert.strictEqual(player.activeEffects.secondChance, false, 'Second Chance is consumed once');
  cleanup(room);

  room = makeRoom('secondChance');
  player = activate(room);
  player.streak = 2;
  game.handleTimeout(room);
  assert.strictEqual(player.hp, 80, 'Second Chance cancels timeout damage');
  assert.strictEqual(player.wrong, 0, 'Second Chance cancels the timeout stat penalty');
  assert.strictEqual(player.streak, 2, 'Second Chance preserves the streak after a timeout');
  cleanup(room);

  room = makeRoom('streakBoost');
  player = activate(room);
  assert.strictEqual(player.streak, 3, 'Streak Boost adds exactly 3');
  cleanup(room);

  room = makeRoom('mirrorShield');
  player = activate(room);
  game.handleCorrect(room, room.gameState.players[1], player, 1, 4);
  assert.strictEqual(player.hp, 80, 'Mirror Shield prevents incoming damage');
  assert.strictEqual(room.gameState.players[1].hp, 90, 'Mirror Shield reflects the calculated damage');
  assert.strictEqual(player.activeEffects.mirrorShield, false, 'Mirror Shield is consumed after reflecting');
  cleanup(room);

  const clientHtml = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  game.CARD_POOL.forEach(function (card) {
    assert.ok(clientHtml.includes(card.desc), card.name + ' rules must match between the server and player UI');
  });
  assert.ok(clientHtml.includes("dealCards('solo')"), 'Solo must use its mode-safe card deck');
  assert.ok(clientHtml.includes("card.id !== 'shield' && card.id !== 'mirrorShield'"), 'Solo must not deal defensive cards that cannot trigger there');
  assert.ok(clientHtml.includes('STATE.yourCards = STATE.players[STATE.you].cards'), 'used-card state must sync from the server');

  console.log('magic card behavior tests passed');
}

run();
