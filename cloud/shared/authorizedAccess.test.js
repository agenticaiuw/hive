import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_ACCESS_INSTRUCTION } from './authorizedAccess.js';
import { brainSystemPrompt } from '../../browser/chrome/src/brain.js';

test("authorized sign-in guidance reaches the browser's agent without overriding controls", () => {
  const prompt = brainSystemPrompt();
  assert.ok(prompt.includes(AUTHORIZED_ACCESS_INSTRUCTION));
  assert.match(prompt, /never bypass a tool restriction/i);
  assert.match(prompt, /do not claim sign-in succeeded without evidence/i);
  assert.match(prompt, /diagnose the cause and try distinct supported alternatives/i);
  assert.match(prompt, /system stops it/i);
});
