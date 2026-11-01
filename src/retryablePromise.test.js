import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetryablePromiseFactory } from './retryablePromise.js'

test('reuses an in-flight operation and its resolved result', async () => {
  let calls = 0
  const run = createRetryablePromiseFactory(async () => {
    calls += 1
    return 'ready'
  })

  const first = run()
  const second = run()
  assert.equal(first, second)
  assert.equal(await first, 'ready')
  assert.equal(await run(), 'ready')
  assert.equal(calls, 1)
})

test('clears a rejected attempt so the next call can recover', async () => {
  let calls = 0
  const run = createRetryablePromiseFactory(async () => {
    calls += 1
    if (calls === 1) throw new Error('storage unavailable')
    return 'recovered'
  })

  await assert.rejects(run(), /storage unavailable/)
  assert.equal(await run(), 'recovered')
  assert.equal(calls, 2)
})

test('can invalidate a cached result after a database version change', async () => {
  let calls = 0
  const run = createRetryablePromiseFactory(async () => ++calls)

  assert.equal(await run(), 1)
  run.reset()
  assert.equal(await run(), 2)
})
