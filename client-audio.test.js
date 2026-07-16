'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function audioParam(initial) {
  return {
    value: initial || 0,
    setValueAtTime: function (value) { this.value = value; },
    linearRampToValueAtTime: function (value) { this.value = value; },
    exponentialRampToValueAtTime: function (value) { this.value = value; },
    cancelScheduledValues: function () {}
  };
}

function createAudioHarness() {
  const harness = { oscillators: 0, stopped: 0 };
  function node() { return { connect: function () {} }; }
  function FakeAudioContext() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = node();
  }
  FakeAudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
  FakeAudioContext.prototype.createGain = function () {
    return { gain: audioParam(0), connect: function () {} };
  };
  FakeAudioContext.prototype.createOscillator = function () {
    harness.oscillators++;
    return {
      type: 'sine',
      frequency: audioParam(440),
      connect: function () {},
      start: function () {},
      stop: function () { harness.stopped++; },
      onended: null
    };
  };
  FakeAudioContext.prototype.createBuffer = function (channels, length) {
    const data = new Float32Array(length);
    return { getChannelData: function () { return data; } };
  };
  FakeAudioContext.prototype.createBufferSource = function () {
    return { buffer: null, connect: function () {}, start: function () {}, stop: function () {} };
  };
  FakeAudioContext.prototype.createBiquadFilter = function () {
    return { type: '', frequency: { value: 0 }, connect: function () {} };
  };
  harness.AudioContext = FakeAudioContext;
  return harness;
}

function loadClientAudio() {
  const html = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'client script should exist');
  const storage = new Map();
  const audio = createAudioHarness();
  let intervalId = 0;
  const context = {
    window: { AudioContext: audio.AudioContext },
    document: { hidden: false, addEventListener: function () {}, getElementById: function () { return null; } },
    localStorage: {
      getItem: function (key) { return storage.has(key) ? storage.get(key) : null; },
      setItem: function (key, value) { storage.set(key, String(value)); }
    },
    setInterval: function () { intervalId++; return intervalId; },
    clearInterval: function () {},
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    console: console,
    Math: Math,
    Date: Date,
    URL: URL,
    Promise: Promise
  };
  vm.createContext(context);
  vm.runInContext(match[1], context, { filename: 'client.html' });
  return { Sound: context.Sound, rankProgressState: context.rankProgressState, rankGuide: context.RANK_GUIDE, document: context.document, storage: storage, audio: audio, html: html };
}

function run() {
  const loaded = loadClientAudio();
  const Sound = loaded.Sound;
  assert.strictEqual(Sound.init(), true);

  const beforeMutedSfx = loaded.audio.oscillators;
  assert.strictEqual(Sound.toggleSfx(), false);
  Sound.tone(440, 0.1);
  assert.strictEqual(loaded.audio.oscillators, beforeMutedSfx, 'muted SFX should not create a tone');
  assert.strictEqual(loaded.storage.get('sifirSfxEnabled'), '0');

  Sound.toggleSfx();
  const beforeEnabledSfx = loaded.audio.oscillators;
  Sound.tone(440, 0.1);
  assert.strictEqual(loaded.audio.oscillators, beforeEnabledSfx + 1);
  assert.strictEqual(loaded.storage.get('sifirSfxEnabled'), '1');
  assert.strictEqual(typeof Sound.playMusic, 'undefined', 'music engine should be removed');
  assert.strictEqual(loaded.html.includes('id="music-toggle"'), false, 'music control should not be visible');
  assert.strictEqual(loaded.html.includes('sifirMusicEnabled'), false, 'music preference should no longer be stored');
  assert.ok(loaded.html.includes('&#128266;'), 'SFX control should use a clear speaker icon');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(loaded.rankProgressState({ tier: 'Multiply Warrior', rp: 650 }))),
    { percent: 50, detail: '50 RP to next' }
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(loaded.rankProgressState({ tier: 'Math Legend', rp: 1675 }))),
    { percent: 75, detail: '25 RP to next' }
  );
  assert.ok(loaded.html.includes('id="home-rank-grid"'), 'home should include season rank cards');
  assert.ok(loaded.html.includes("fetch('/api/ranked-ladder?mode='"), 'leaderboard should load seasonal ranks directly');
  assert.strictEqual(loaded.html.includes('Global Records'), false, 'legacy records toggle should not be visible');
  assert.strictEqual(loaded.rankGuide.length, 8, 'rank guide should explain all eight season ranks');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(loaded.rankGuide.map(function (rank) { return rank.name; }))),
    ['Number Novice', 'Times Apprentice', 'Multiply Warrior', 'Number Knight', 'Times Commander', 'Math Legend', 'Arena Hero', 'Times Immortal']
  );
  assert.ok(loaded.rankGuide[7].range.includes('2100+ RP'));
  assert.ok(loaded.rankGuide[7].range.includes('Top 50'));
  assert.ok(loaded.html.includes('Demotion Shield'), 'rank guide should explain demotion protection');
  assert.strictEqual(loaded.html.includes('Placement Rank'), false, 'rank should be visible immediately without placement');
  console.log('client audio tests passed');
}

run();
