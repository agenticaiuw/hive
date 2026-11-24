const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = readFileSync('dashboard/index.html', 'utf8');
const helpers = html.slice(html.indexOf('function agentSessions()'), html.indexOf('function taskCard('));
const state = {tasks: [
  {id: 279, agent_id: 71, title: 'Latest'},
  {id: 278, agent_id: 71, title: 'Earlier'},
  {id: 277, agent_id: 63}, {id: 276}, {id: 275}
], agents: [{id: 71, task_id: 279}]};
vm.runInNewContext(helpers + `
  assert.equal(agentSessions().length, 5);
  assert.equal(sessionId(279), 279);
  assert.equal(sessionId(278), 278);
  assert.equal(sessionTask(278).id, 278);
  state.tasks.unshift({id: 280, agent_id: 71, title: 'Next'});
  assert.equal(sessionTask(278).id, 278);
  assert.equal(agentSessions().length, 6);
`, {state, assert});
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log('Agent session grouping, routing, stable identity and script syntax passed');
