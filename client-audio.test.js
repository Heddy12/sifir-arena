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
  return { Sound: context.Sound, document: context.document, storage: storage, audio: audio };
}

function run() {
  const loaded = loadClientAudio();
  const Sound = loaded.Sound;
  assert.strictEqual(Sound.init(), true);

  Sound.playMusic('menu');
  assert.strictEqual(Sound.currentTrack, 'menu');
  assert.ok(Sound.musicTimer, 'menu scheduler should be active');
  assert.ok(loaded.audio.oscillators > 0, 'menu should schedule synth voices');

  const beforeMutedSfx = loaded.audio.oscillators;
  assert.strictEqual(Sound.toggleSfx(), false);
  Sound.tone(440, 0.1);
  assert.strictEqual(loaded.audio.oscillators, beforeMutedSfx, 'muted SFX should not create a tone');
  assert.strictEqual(Sound.musicEnabled, true, 'muting SFX must not mute music');

  assert.strictEqual(Sound.toggleMusic(), false);
  assert.strictEqual(Sound.currentTrack, null);
  assert.strictEqual(Sound.sfxEnabled, false, 'muting music must not alter SFX preference');
  assert.strictEqual(loaded.storage.get('sifirMusicEnabled'), '0');
  assert.strictEqual(loaded.storage.get('sifirSfxEnabled'), '0');

  Sound.toggleSfx();
  const beforeEnabledSfx = loaded.audio.oscillators;
  Sound.tone(440, 0.1);
  assert.strictEqual(loaded.audio.oscillators, beforeEnabledSfx + 1);
  Sound.toggleMusic();
  assert.strictEqual(Sound.currentTrack, 'menu');

  Sound.playMusic('battle', true);
  assert.strictEqual(Sound.currentTrack, 'battle');
  assert.strictEqual(Sound.musicTempoScale, 1);
  Sound.finishBattle();
  assert.strictEqual(Sound.resultMode, true);
  assert.strictEqual(Sound.musicTempoScale, 0.68);

  loaded.document.hidden = true;
  Sound.pauseMusic();
  assert.strictEqual(Sound.currentTrack, null);
  loaded.document.hidden = false;
  Sound.resumeMusic();
  assert.strictEqual(Sound.currentTrack, 'battle');
  assert.strictEqual(Sound.resultMode, true, 'result music state should survive tab visibility changes');

  Sound.haltMusic();
  console.log('client audio tests passed');
}

run();
