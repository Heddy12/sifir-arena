'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');

assert.match(client, /id="inferno-arena"/, 'Inferno arena layer should exist');
assert.match(client, /function setInfernoArena\(active\)/, 'Arena state helper should exist');
assert.match(client, /function startSoloGame\(\)[\s\S]*?setInfernoArena\(true\)/, 'Solo should activate Inferno');
assert.match(client, /function showVSOverlay\(\)[\s\S]*?setInfernoArena\(true\)/, 'Multiplayer and Sprint VS should activate Inferno');
assert.match(client, /function goHome\(\)[\s\S]*?setInfernoArena\(false\)/, 'Returning home should restore the menu background');
assert.match(client, /prefers-reduced-motion:reduce/, 'Inferno effects should respect reduced motion');
assert.match(client, /id="reset-form"/, 'Password reset form should be available from account access');
assert.match(client, /\/api\/forgot-password/, 'Client should request password reset codes securely');
assert.match(client, /Object\.keys\(BADGE_NAMES\)/, 'Profile should show the complete badge collection');
assert.match(client, /earned\?'Earned':'Locked'/, 'Unearned badges should remain visible as locked');

console.log('client arena tests passed');
