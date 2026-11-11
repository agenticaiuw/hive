import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPresentation } from '../scripts/presentation-evidence.mjs';
const sample = (more = {}) => ({ submittedWork: 3, gpuCompletions: 3, gpuFailures: 0,
  presentationCallbacks: 0, nonzeroPresentationTimestamps: [], ...more });
test('missing callbacks do not become zero FPS or dropped frames', () => {
  const report = classifyPresentation(sample());
  assert.equal(report.presentationVerification, 'unverified');
  assert.equal(report.displayFPS, null);
  assert.equal(report.droppedFrames, null);
  assert.equal(report.presentationTimestampFPS, null);
});
test('zero-valued callbacks remain unverified', () => {
  assert.equal(classifyPresentation(sample({ presentationCallbacks: 3 })).presentationVerification, 'unverified');
});
test('complete timestamps expose callback cadence without claiming scanout', () => {
  const report = classifyPresentation(sample({ presentationCallbacks: 3, nonzeroPresentationTimestamps: [1, 1.5, 2] }));
  assert.equal(report.presentationTimestampFPS, 2);
  assert.equal(report.displayFPS, null);
});
test('partial completion, duplicate timestamps and invalid counts fail closed', () => {
  assert.equal(classifyPresentation(sample({ gpuCompletions: 2 })).presentationVerification, 'unverified');
  assert.equal(classifyPresentation(sample({ presentationCallbacks: 3, nonzeroPresentationTimestamps: [1, 1, 2] })).presentationVerification, 'unverified');
  assert.throws(() => classifyPresentation(sample({ gpuCompletions: 4 })));
  assert.throws(() => classifyPresentation(sample({ presentationCallbacks: 1, nonzeroPresentationTimestamps: [Infinity] })));
});
