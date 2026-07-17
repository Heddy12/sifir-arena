'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const game = require('./server').__test;

function fakeSocket(events) {
  return {
    readyState: 1,
    send: function (payload) { events.push(JSON.parse(payload)); }
  };
}

function makeRoom() {
  const events = [[], []];
  game.players.sticker_p0 = { playerIdx: 0, ws: fakeSocket(events[0]), lastStickerAt: 0 };
  game.players.sticker_p1 = {
    playerIdx: 1,
    ws: fakeSocket(events[1]),
    lastStickerAt: 0,
    isBot: true,
    bot: { level: 'smart' }
  };
  return {
    room: {
      players: ['sticker_p0', 'sticker_p1'],
      gameMode: 'ffa',
      battleActive: true
    },
    events: events
  };
}

function cleanup() {
  delete game.players.sticker_p0;
  delete game.players.sticker_p1;
}

function run() {
  const setup = makeRoom();
  const room = setup.room;
  const events = setup.events;

  assert.deepStrictEqual(
    Array.from(game.STICKER_IDS),
    ['happy', 'angry', 'funny', 'wow', 'nice', 'goodGame', 'oops', 'fire'],
    'server should allow exactly the eight designed stickers'
  );
  assert.strictEqual(game.STICKER_COOLDOWN_MS, 5000);

  assert.strictEqual(game.handleSticker(room, 'sticker_p0', 'happy', 100000), true);
  assert.ok(events[0].some(function (event) { return event.type === 'sticker' && event.playerIdx === 0 && event.stickerId === 'happy'; }));
  assert.ok(events[1].some(function (event) { return event.type === 'sticker' && event.playerIdx === 0 && event.stickerId === 'happy'; }));

  events[0].length = 0;
  events[1].length = 0;
  assert.strictEqual(game.handleSticker(room, 'sticker_p0', 'fire', 102000), false, 'cooldown should reject sticker spam');
  assert.ok(events[0].some(function (event) { return event.type === 'stickerCooldown' && event.remainingMs === 3000; }));
  assert.strictEqual(events[1].length, 0, 'rejected stickers must not reach the opponent');

  events[0].length = 0;
  assert.strictEqual(game.handleSticker(room, 'sticker_p0', 'not-real', 110000), false);
  assert.strictEqual(events[0].length, 0, 'unknown sticker IDs should be ignored');

  assert.deepStrictEqual(game.botStickerChoices('correct'), ['happy', 'nice', 'fire']);
  assert.deepStrictEqual(game.botStickerChoices('wrong'), ['oops', 'funny', 'angry']);
  assert.deepStrictEqual(game.botStickerChoices('timeout'), ['oops', 'angry']);
  assert.deepStrictEqual(game.botStickerChoices('bigHit'), ['wow', 'angry']);

  events[0].length = 0;
  events[1].length = 0;
  assert.strictEqual(game.maybeSendBotSticker(room, 1, 'correct', 0, 120000), true);
  assert.ok(events[0].some(function (event) { return event.type === 'sticker' && event.playerIdx === 1 && event.stickerId === 'happy'; }));
  assert.strictEqual(game.maybeSendBotSticker(room, 1, 'wrong', 0, 125000), false, 'bot sticker cooldown should be longer than player spam protection');
  assert.strictEqual(game.maybeSendBotSticker(room, 1, 'wrong', 0.9, 140000), false, 'bots should not react after every answer');

  room.gameMode = 'solo';
  assert.strictEqual(game.handleSticker(room, 'sticker_p0', 'happy', 140000), false, 'stickers should not be available in Solo');

  Array.from(game.STICKER_IDS).forEach(function (stickerId) {
    const asset = path.join(__dirname, 'images', 'stickers', stickerId + '.png');
    assert.ok(fs.existsSync(asset), stickerId + ' sticker artwork should be bundled separately');
    assert.ok(fs.statSync(asset).size > 50000, stickerId + ' sticker artwork should not be empty');
  });

  cleanup();
  console.log('sticker system tests passed');
}

try {
  run();
} finally {
  cleanup();
}
