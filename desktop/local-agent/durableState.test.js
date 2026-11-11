import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testWorkspace = fs.mkdtempSync(
  path.join(os.tmpdir(), 'pendant-durable-state-test-'),
)
process.env.PENDANT_WORKSPACE_PATH = testWorkspace

const testId = Date.now()
const [{ appendLog }, jobs, pipeline, thinking] = await Promise.all([
  import(`./logger.js?durable=${testId}`),
  import(`./jobTracker.js?durable=${testId}`),
  import(`./pipelineTrace.js?durable=${testId}`),
  import(`./thinkingTrace.js?durable=${testId}`),
])

test.after(() => {
  fs.rmSync(testWorkspace, { recursive: true, force: true })
})

test('all local state writers produce owner-only primary and backup files', () => {
  appendLog({ type: 'test', message: 'durable log' })
  jobs.recordJobStart({ type: 'test', command: 'durable job' })
  pipeline.recordPipelineEvent({
    pipelineId: 'durable_pipeline',
    stage: 'local_command',
  })
  thinking.startThinkingTrace({ command: 'durable thinking' })

  for (const name of [
    'mac-agent-activity-log.json',
    'pendant-jobs.json',
    'pendant-pipeline.json',
    'pendant-thinking.json',
  ]) {
    const filePath = path.join(testWorkspace, name)
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(filePath, 'utf8'))))
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8'))))
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(`${filePath}.bak`).mode & 0o777, 0o600)
  }
})
