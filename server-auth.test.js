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

  const memoryDb = newDb({ noAstCoverageCheck: true });
  const memoryPg = memoryDb.adapters.createPg();
  const pgPath = require.resolve('pg');
  const originalPg = require(pgPath);
  require.cache[pgPath].exports = Object.assign({}, originalPg, { Pool: memoryPg.Pool });

  delete require.cache[require.resolve('./leaderboard-store')];
  delete require.cache[require.resolve('./server')];
  const app = require('./server');
  await new Promise(function (resolve) { app.server.listen(0, '127.0.0.1', resolve); });
  const address = app.server.address();
  const base = 'http://127.0.0.1:' + address.port;

  try {
    let response = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ email: 'integration.hero@gmail.com', password: 'secure-pass-123', playerName: 'RoomHero' })
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
    assert.strictEqual((await response.json()).account.playerName, 'RoomHero');

    const socket = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
    const connectedPromise = waitForMessage(socket, 'connected');
    const connected = await connectedPromise;
    assert.strictEqual(connected.playerName, 'RoomHero');
    socket.send(JSON.stringify({ type: 'setName', name: 'Imposter', profileId: 'device_imposter' }));
    const createdPromise = waitForMessage(socket, 'roomCreated');
    socket.send(JSON.stringify({ type: 'createRoom', settings: { timer: 20, sifir: 0, difficulty: 'random', gameMode: 'ffa' } }));
    const created = await createdPromise;
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    socket.close();

    const rejectedSocket = new WebSocket(base.replace('http:', 'ws:'));
    assert.strictEqual(await waitForClose(rejectedSocket), 4001);

    response = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    assert.strictEqual(response.status, 200);
    response = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
    assert.strictEqual(response.status, 401);

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
