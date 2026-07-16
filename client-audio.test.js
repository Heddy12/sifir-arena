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
  const harness = { oscillators: 0, stopped: 0, mediaPlayers: [] };
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
  function FakeAudio(src) {
    this.src = src;
    this.loop = false;
    this.preload = '';
    this.volume = 1;
    this.currentTime = 0;
    this.playCount = 0;
    this.pauseCount = 0;
    this.setAttribute = function () {};
    this.load = function () {};
    this.play = function () { this.playCount++; return Promise.resolve(); };
    this.pause = function () { this.pauseCount++; };
    harness.mediaPlayers.push(this);
  }
  harness.AudioContext = FakeAudioContext;
  harness.Audio = FakeAudio;
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
    window: { AudioContext: audio.AudioContext, Audio: audio.Audio },
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
  const musicPath = path.join(__dirname, 'audio', 'menu-go.mp3');
  const battleMusicPath = path.join(__dirname, 'audio', 'battle-war-drums.mp3');
  assert.ok(fs.existsSync(musicPath), 'menu music asset should exist');
  assert.ok(fs.statSync(musicPath).size > 1000000, 'menu music asset should not be empty');
  assert.ok(fs.existsSync(battleMusicPath), 'battle music asset should exist');
  assert.ok(fs.statSync(battleMusicPath).size > 1000000, 'battle music asset should not be empty');
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
  Sound.playMenuMusic();
  assert.strictEqual(loaded.audio.mediaPlayers.length, 1, 'menu music should create one reusable audio player');
  assert.strictEqual(loaded.audio.mediaPlayers[0].src, '/audio/menu-go.mp3');
  assert.strictEqual(loaded.audio.mediaPlayers[0].volume, 0.2);
  assert.strictEqual(loaded.audio.mediaPlayers[0].loop, true);
  assert.strictEqual(loaded.audio.mediaPlayers[0].playCount, 1);
  const sfxStateBeforeMusicToggle = Sound.sfxEnabled;
  assert.strictEqual(Sound.toggleMusic(), false);
  assert.strictEqual(Sound.sfxEnabled, sfxStateBeforeMusicToggle, 'music toggle must not change SFX');
  assert.strictEqual(loaded.storage.get('sifirMusicEnabled'), '0');
  assert.strictEqual(Sound.toggleMusic(), true);
  Sound.playBattleMusic();
  assert.strictEqual(loaded.audio.mediaPlayers.length, 1, 'menu and battle should reuse one unlocked audio player');
  assert.strictEqual(loaded.audio.mediaPlayers[0].src, '/audio/battle-war-drums.mp3');
  assert.strictEqual(loaded.audio.mediaPlayers[0].volume, 0.24);
  assert.strictEqual(Sound.musicMode, 'battle');
  Sound.stopMusic();
  assert.strictEqual(loaded.audio.mediaPlayers[0].pauseCount, 3, 'music should stop after battle');
  assert.strictEqual(Sound.musicWanted, false);
  assert.strictEqual(loaded.html.includes('id="music-toggle"'), true, 'music control should be visible');
  assert.strictEqual(loaded.html.includes('sifirMusicEnabled'), true, 'music preference should be stored separately');
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
  assert.ok(loaded.html.includes('edit.hidden = !p.isOwner'), 'profile editor should only be visible to its owner');
  assert.ok(loaded.html.includes('.profile-edit[hidden]{display:none!important}'), 'profile editor CSS must respect the hidden state');
  assert.ok(loaded.html.includes('!STATE.profileData.isOwner'), 'profile save should reject non-owner views');
  assert.ok(loaded.html.includes("STATE.matchType === 'quick'"), 'Quick Match result should use the next-opponent flow');
  assert.ok(loaded.html.includes("type: 'nextQuickMatch'"), 'client should request the next rotation opponent');
  assert.ok(loaded.html.includes('Opponent Rotation'), 'client should show rotation progress');
  console.log('client audio tests passed');
}

run();
