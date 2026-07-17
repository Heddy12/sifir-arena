'use strict';

const assert = require('assert');
const { newDb } = require('pg-mem');
const WebSocket = require('ws');

function waitForMessage(socket, type) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(function () { reject(new Error('Timed out waiting for ' + type)); }, 3000);
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

function waitForClose(socket) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(function () { reject(new Error('Timed out waiting for WebSocket close')); }, 3000);
    socket.once('close', function (code) {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function run() {
  process.env.DATABASE_URL = 'postgresql://server-auth-test';
  process.env.PGSSL_DISABLE = '1';
  process.env.NODE_ENV = 'test';
  process.env.GAME_MASTER_EMAIL = 'g-97558615@moe-dl.edu.my';

  const memoryDb = newDb({ noAstCoverageCheck: true });
  const memoryPg = memoryDb.adapters.createPg();
  const pgPath = require.resolve('pg');
  const originalPg = require(pgPath);
  require.cache[pgPath].exports = Object.assign({}, originalPg, { Pool: memoryPg.Pool });

  delete require.cache[require.resolve('./leaderboard-store')];
  delete require.cache[require.resolve('./server')];
  const app = require('./server');
  const emailService = require('./email-service');
  await new Promise(function (resolve) { app.server.listen(0, '127.0.0.1', resolve); });
  const address = app.server.address();
  const base = 'http://127.0.0.1:' + address.port;

  try {
    let response = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ email: 'g-97558615@moe-dl.edu.my', password: 'secure-pass-123', playerName: 'RoomHero' })
    });
    assert.strictEqual(response.status, 201);
    const accountBody = await response.json();
    assert.strictEqual(accountBody.account.playerName, 'RoomHero');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(accountBody, 'token'), false);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('sifir_session='));
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(response.headers.get('set-cookie').includes('SameSite=Strict'));

    response = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    const meBody = await response.json();
    assert.strictEqual(meBody.account.playerName, 'RoomHero');
    assert.strictEqual(meBody.isGameMaster, true);

    response = await fetch(base + '/api/profile?player=RoomHero', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    let profileBody = await response.json();
    assert.strictEqual(profileBody.profile.player.name, 'RoomHero');
    assert.strictEqual(profileBody.profile.isOwner, true);
    assert.strictEqual(JSON.stringify(profileBody).includes('g-97558615@moe-dl.edu.my'), false);
    response = await fetch(base + '/api/profile', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarKey: 'knight-red', bio: 'Training for the arena' })
    });
    assert.strictEqual(response.status, 200);
    let updatedProfileBody = await response.json();
    assert.strictEqual(updatedProfileBody.profile.avatarKey, 'knight-red');
    response = await fetch(base + '/api/profile?player=RoomHero', { headers: { Cookie: cookie } });
    profileBody = await response.json();
    assert.strictEqual(profileBody.profile.player.avatarKey, 'knight-red');
    assert.strictEqual(profileBody.profile.player.bio, 'Training for the arena');

    response = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ email: 'other.player@example.com', password: 'secure-pass-456', playerName: 'OtherViewer' })
    });
    assert.strictEqual(response.status, 201);
    const otherAccountBody = await response.json();
    let otherCookie = response.headers.get('set-cookie').split(';')[0];
    response = await fetch(base + '/api/game-master/overview', { headers: { Cookie: otherCookie } });
    assert.strictEqual(response.status, 403);
    response = await fetch(base + '/api/game-master/me', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/game-master/overview', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).overview.totalPlayers, 2);
    response = await fetch(base + '/api/game-master/players?q=OtherViewer', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    const playersBody = await response.json();
    assert.strictEqual(playersBody.total, 1);
    assert.strictEqual(playersBody.players[0].email, 'other.player@example.com');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(playersBody.players[0], 'password_hash'), false);
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/rename', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName: 'OtherRenamed' })
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/game-master/players/' + accountBody.account.accountId + '/rename', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName: 'GameMasterRename' })
    });
    assert.strictEqual(response.status, 403);
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/suspend', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Classroom review' })
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other.player@example.com', password: 'secure-pass-456' })
    });
    assert.strictEqual(response.status, 403);
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/reactivate', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other.player@example.com', password: 'secure-pass-456' })
    });
    assert.strictEqual(response.status, 200);
    otherCookie = response.headers.get('set-cookie').split(';')[0];
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/reset-password', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(response.status, 200);
    const adminResetMessage = emailService.takeLastTestMessage();
    assert.strictEqual(adminResetMessage.email, 'other.player@example.com');
    response = await fetch(base + '/api/game-master/bots', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    assert.ok((await response.json()).bots.length >= 20);
    response = await fetch(base + '/api/game-master/season', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/game-master/audit', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    assert.ok((await response.json()).entries.length >= 4);
    response = await fetch(base + '/api/profile?player=RoomHero', { headers: { Cookie: otherCookie } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).profile.isOwner, false);
    response = await fetch(base + '/api/profile', {
      method: 'PATCH', headers: { Cookie: otherCookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: accountBody.account.accountId, player: 'RoomHero', avatarKey: 'hero-fire', bio: 'Attempted overwrite' })
    });
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'You can only edit your own profile.');
    response = await fetch(base + '/api/profile?player=RoomHero', { headers: { Cookie: cookie } });
    profileBody = await response.json();
    assert.strictEqual(profileBody.profile.player.avatarKey, 'knight-red');
    assert.strictEqual(profileBody.profile.player.bio, 'Training for the arena');

    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/archive', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Graduated class archive' })
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/profile?player=OtherRenamed', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 404, 'archived profiles must be hidden from public profile search');
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId, { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200, 'Game Master can still inspect archived player records');
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/restore', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other.player@example.com', password: 'secure-pass-456' })
    });
    assert.strictEqual(response.status, 200);
    const restoredCookie = response.headers.get('set-cookie').split(';')[0];
    const onlinePlayerSocket = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: restoredCookie } });
    assert.strictEqual((await waitForMessage(onlinePlayerSocket, 'connected')).playerName, 'OtherRenamed');
    response = await fetch(base + '/api/game-master/players/' + otherAccountBody.account.accountId + '/rename', {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerName: 'RenameWhileOnline' })
    });
    assert.strictEqual(response.status, 409);
    onlinePlayerSocket.close();

    response = await fetch(base + '/api/ranked-ladder?mode=solo&limit=10', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray((await response.json()).entries));

    const socket = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
    const connectedPromise = waitForMessage(socket, 'connected');
    const connected = await connectedPromise;
    assert.strictEqual(connected.playerName, 'RoomHero');
    socket.send(JSON.stringify({ type: 'setName', name: 'Imposter', profileId: 'device_imposter' }));
    const soloSessionPromise = waitForMessage(socket, 'soloSessionStarted');
    socket.send(JSON.stringify({ type: 'startSoloSession', settings: { timer: 20, sifir: 0, difficulty: 'random' } }));
    assert.strictEqual((await soloSessionPromise).settings.timer, 3, 'Single Player must always use a 3-second answer timer');
    const createdPromise = waitForMessage(socket, 'roomCreated');
    socket.send(JSON.stringify({ type: 'createRoom', settings: { timer: 20, sifir: 0, difficulty: 'random', gameMode: 'ffa' } }));
    const created = await createdPromise;
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    assert.strictEqual(created.settings.timer, 3, 'Multiplayer Create Room must always use a 3-second answer timer');
    socket.close();

    const rejectedSocket = new WebSocket(base.replace('http:', 'ws:'));
    assert.strictEqual(await waitForClose(rejectedSocket), 4001);

    response = await fetch(base + '/api/forgot-password', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'g-97558615@moe-dl.edu.my' })
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).message, 'If that email is registered, a reset code has been sent.');
    const resetMessage = emailService.takeLastTestMessage();
    assert.strictEqual(resetMessage.email, 'g-97558615@moe-dl.edu.my');
    assert.match(resetMessage.code, /^\d{6}$/);

    response = await fetch(base + '/api/reset-password', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: resetMessage.email, code: resetMessage.code, newPassword: 'new-secure-pass-789' })
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 401);
    response = await fetch(base + '/api/login', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: resetMessage.email, password: 'new-secure-pass-789' })
    });
    assert.strictEqual(response.status, 200);
    const resetCookie = response.headers.get('set-cookie').split(';')[0];
    response = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: resetCookie, Origin: base } });
    assert.strictEqual(response.status, 200);

    console.log('server auth and room regression tests passed');
  } finally {
    app.wss.clients.forEach(function (socket) { socket.terminate(); });
    await new Promise(function (resolve) { app.wss.close(resolve); });
    await new Promise(function (resolve) { app.server.close(resolve); });
  }
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
