'use strict';

const assert = require('assert');
const { newDb } = require('pg-mem');
const WebSocket = require('ws');
const botCatalog = require('./bot-catalog');

function waitForMessage(socket, type, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(function () { reject(new Error('Timed out waiting for ' + type)); }, timeoutMs || 3000);
    socket.on('message', function handler(raw) {
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', handler);
      resolve(message);
    });
  });
}

async function register(base, suffix) {
  const response = await fetch(base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      email: 'quick-' + suffix + '@example.com',
      password: 'secure-pass-123',
      playerName: 'Quick_' + suffix
    })
  });
  assert.strictEqual(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function openSocket(base, cookie) {
  const socket = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
  await waitForMessage(socket, 'connected');
  return socket;
}

async function run() {
  process.env.DATABASE_URL = 'postgresql://quick-match-test';
  process.env.PGSSL_DISABLE = '1';
  process.env.NODE_ENV = 'test';
  process.env.QUICK_MATCH_WAIT_MS = '250';
  process.env.QUICK_MATCH_START_DELAY_MS = '30';
  process.env.RANKED_RECONNECT_GRACE_MS = '1000';

  const memoryDb = newDb({ noAstCoverageCheck: true });
  const memoryPg = memoryDb.adapters.createPg();
  const pgPath = require.resolve('pg');
  const originalPg = require(pgPath);
  require.cache[pgPath].exports = Object.assign({}, originalPg, { Pool: memoryPg.Pool });

  delete require.cache[require.resolve('./leaderboard-store')];
  delete require.cache[require.resolve('./server')];
  const app = require('./server');
  await new Promise(function (resolve) { app.server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const sockets = [];

  try {
    const cookieA = await register(base, 'Alpha');
    const cookieB = await register(base, 'Bravo');
    const playerA = await openSocket(base, cookieA);
    const playerB = await openSocket(base, cookieB);
    sockets.push(playerA, playerB);

    const searchingA = waitForMessage(playerA, 'quickMatchSearching');
    playerA.send(JSON.stringify({ type: 'quickMatch' }));
    const searchState = await searchingA;
    assert.strictEqual(searchState.settings.timer, 3);
    assert.strictEqual(searchState.settings.sifir, 0);
    assert.strictEqual(searchState.settings.difficulty, 'random');

    const foundA = waitForMessage(playerA, 'quickMatchFound');
    const foundB = waitForMessage(playerB, 'quickMatchFound');
    const startA = waitForMessage(playerA, 'gameStart');
    const startB = waitForMessage(playerB, 'gameStart');
    let matchedBeforeSearchWindow = false;
    function detectPrematureMatch(raw) { try { if (JSON.parse(raw).type === 'quickMatchFound') matchedBeforeSearchWindow = true; } catch (error) {} }
    playerA.on('message', detectPrematureMatch);
    playerB.send(JSON.stringify({ type: 'quickMatch' }));
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
    assert.strictEqual(matchedBeforeSearchWindow, false, 'real players must remain in search before matchmaking resolves');
    playerA.off('message', detectPrematureMatch);
    const paired = await Promise.all([foundA, foundB]);
    assert.strictEqual(paired[0].opponentName, 'Quick_Bravo');
    assert.strictEqual(paired[1].opponentName, 'Quick_Alpha');
    const starts = await Promise.all([startA, startB]);
    assert.strictEqual(starts[0].settings.timer, 3);
    assert.strictEqual(starts[1].players.length, 2);
    let earlyTurn = false;
    function detectEarlyTurn(raw) { try { if (JSON.parse(raw).type === 'newTurn') earlyTurn = true; } catch (error) {} }
    playerA.on('message', detectEarlyTurn);
    playerB.on('message', detectEarlyTurn);
    await new Promise(function (resolve) { setTimeout(resolve, 80); });
    assert.strictEqual(earlyTurn, false, 'question timer must not start before countdown readiness');
    playerA.send(JSON.stringify({ type: 'battleReady' }));
    await new Promise(function (resolve) { setTimeout(resolve, 40); });
    assert.strictEqual(earlyTurn, false, 'server must wait for both human players');
    const firstTurn = waitForMessage(playerA, 'newTurn');
    playerB.send(JSON.stringify({ type: 'battleReady' }));
    const turn = await firstTurn;
    assert.strictEqual(turn.timer, 3);
    playerA.off('message', detectEarlyTurn);
    playerB.off('message', detectEarlyTurn);
    const reconnectNotice = waitForMessage(playerB, 'opponentReconnecting');
    playerA.terminate();
    assert.strictEqual((await reconnectNotice).graceSeconds, 1);
    const reconnectedA = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookieA } });
    const reconnectConnected = waitForMessage(reconnectedA, 'connected');
    const resumed = waitForMessage(reconnectedA, 'matchResume');
    await reconnectConnected;
    const resumeState = await resumed;
    assert.strictEqual(resumeState.players.length, 2);
    assert.strictEqual(resumeState.settings.timer, 3);
    assert.strictEqual(resumeState.matchType, 'quick');
    sockets.push(reconnectedA);
    reconnectedA.send(JSON.stringify({ type: 'leaveRoom' }));
    await new Promise(function (resolve) { setTimeout(resolve, 80); });
    playerB.close();

    const rotationSearching = waitForMessage(reconnectedA, 'quickMatchSearching');
    const rotationFound = waitForMessage(reconnectedA, 'quickMatchFound');
    const rotationStart = waitForMessage(reconnectedA, 'gameStart');
    reconnectedA.send(JSON.stringify({ type: 'quickMatch', gameMode: 'ffa' }));
    const forcedSearch = await rotationSearching;
    assert.strictEqual(Object.prototype.hasOwnProperty.call(forcedSearch, 'rotation'), false);
    const forcedMatch = await rotationFound;
    assert.strictEqual(forcedMatch.opponentName, botCatalog.ROTATION_BOTS[0].name);
    const forcedGame = await rotationStart;
    assert.strictEqual(forcedGame.matchType, 'quick');
    assert.strictEqual(forcedGame.opponentIsBot, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(forcedGame, 'rotation'), false);
    reconnectedA.close();

    const cookieC = await register(base, 'Charlie');
    const playerC = await openSocket(base, cookieC);
    sockets.push(playerC);
    const searchingC = waitForMessage(playerC, 'quickMatchSearching');
    const botFound = waitForMessage(playerC, 'quickMatchFound');
    const botStart = waitForMessage(playerC, 'gameStart');
    playerC.send(JSON.stringify({ type: 'quickMatch' }));
    await searchingC;
    const botMatch = await botFound;
    assert.ok(botCatalog.isReservedBotName(botMatch.opponentName));
    assert.strictEqual(botMatch.you, 0);
    const botGame = await botStart;
    assert.strictEqual(botGame.players[1].name, botMatch.opponentName);
    assert.strictEqual(botGame.gameMode, 'ffa');
    assert.strictEqual(botGame.matchType, 'quick');
    assert.strictEqual(botGame.opponentIsBot, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(botGame, 'rotation'), false, 'rotation details must remain server-side');
    const botTurn = waitForMessage(playerC, 'newTurn');
    playerC.send(JSON.stringify({ type: 'battleReady' }));
    assert.strictEqual((await botTurn).timer, 3);
    playerC.close();

    const cookieD = await register(base, 'Delta');
    const playerD = await openSocket(base, cookieD);
    sockets.push(playerD);
    let unexpectedMatch = false;
    playerD.on('message', function (raw) {
      try { if (JSON.parse(raw).type === 'quickMatchFound') unexpectedMatch = true; } catch (error) {}
    });
    const searchingD = waitForMessage(playerD, 'quickMatchSearching');
    playerD.send(JSON.stringify({ type: 'quickMatch' }));
    await searchingD;
    const cancelled = waitForMessage(playerD, 'quickMatchCancelled');
    playerD.send(JSON.stringify({ type: 'cancelQuickMatch' }));
    await cancelled;
    await new Promise(function (resolve) { setTimeout(resolve, 120); });
    assert.strictEqual(unexpectedMatch, false);
    const sprintSearching = waitForMessage(playerD, 'quickMatchSearching');
    const sprintFound = waitForMessage(playerD, 'quickMatchFound');
    const sprintStart = waitForMessage(playerD, 'gameStart');
    playerD.send(JSON.stringify({ type: 'quickMatch', gameMode: 'sprint' }));
    const sprintSearchState = await sprintSearching;
    assert.strictEqual(sprintSearchState.gameMode, 'sprint');
    assert.strictEqual(sprintSearchState.settings.sprintTime, 60);
    const sprintOpponent = await sprintFound;
    assert.ok(botCatalog.isReservedBotName(sprintOpponent.opponentName));
    assert.strictEqual(sprintOpponent.gameMode, 'sprint');
    const sprintGame = await sprintStart;
    assert.strictEqual(sprintGame.gameMode, 'sprint');
    assert.strictEqual(sprintGame.sprint, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sprintGame, 'rotation'), false, 'Sprint must not expose rotation details');
    const sprintFirstQuestion = waitForMessage(playerD, 'newTurn');
    playerD.send(JSON.stringify({ type: 'battleReady' }));
    assert.strictEqual((await sprintFirstQuestion).sprint, true);

    const cookieE = await register(base, 'Echo');
    const cookieF = await register(base, 'Foxtrot');
    const playerE = await openSocket(base, cookieE);
    const playerF = await openSocket(base, cookieF);
    sockets.push(playerE, playerF);
    const isolatedFfa = waitForMessage(playerE, 'quickMatchFound');
    const isolatedSprint = waitForMessage(playerF, 'quickMatchFound');
    playerE.send(JSON.stringify({ type: 'quickMatch', gameMode: 'ffa' }));
    playerF.send(JSON.stringify({ type: 'quickMatch', gameMode: 'sprint' }));
    const isolatedMatches = await Promise.all([isolatedFfa, isolatedSprint]);
    assert.strictEqual(isolatedMatches[0].gameMode, 'ffa');
    assert.strictEqual(isolatedMatches[1].gameMode, 'sprint');
    assert.ok(botCatalog.isReservedBotName(isolatedMatches[0].opponentName));
    assert.ok(botCatalog.isReservedBotName(isolatedMatches[1].opponentName));

    console.log('server Quick Match tests passed');
  } finally {
    sockets.forEach(function (socket) { try { socket.terminate(); } catch (error) {} });
    app.wss.clients.forEach(function (socket) { socket.terminate(); });
    await new Promise(function (resolve) { app.wss.close(resolve); });
    await new Promise(function (resolve) { app.server.close(resolve); });
  }
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
