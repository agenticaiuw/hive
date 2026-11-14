import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_ACCESS_INSTRUCTION } from './authorizedAccess.js';
import { buildPlannerSystemPrompt } from '../../desktop/local-agent/llmPlanner.js';
import { buildSystemPrompt } from '../../desktop/local-agent/computerUseLoop.js';
import { VOICE_AGENT_STATIC_INSTRUCTIONS } from '../server/fleetContext.js';
import { brainSystemPrompt } from '../../browser/chrome/src/brain.js';

test('authorized sign-in guidance reaches planner, vision, voice, and browser without overriding controls', () => {
  for (const prompt of [buildPlannerSystemPrompt(), buildPlannerSystemPrompt({ tier: 'background' }), buildSystemPrompt({ displays: [], goal: 'fixture', allowPixelFallback: false }), VOICE_AGENT_STATIC_INSTRUCTIONS, brainSystemPrompt()]) {
    assert.ok(prompt.includes(AUTHORIZED_ACCESS_INSTRUCTION));
    assert.match(prompt, /never bypass a tool restriction/i);
    assert.match(prompt, /do not claim sign-in succeeded without evidence/i);
    assert.match(prompt, /diagnose the cause and try distinct supported alternatives/i);
  }
  assert.match(buildSystemPrompt({ displays: [], goal: 'fixture', allowPixelFallback: false }), /password-manager or system autofill/);
  assert.match(brainSystemPrompt(), /system stops it/i);
});
