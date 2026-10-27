import test from 'node:test'
import assert from 'node:assert/strict'
import { blocksRecordingGeneration, findPromptInsertion, isRecoverableRecognitionInterruption, movePromptInList } from './promptBehavior.js'

const prompts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

test('reorders a prompt before or after the visible drop target', () => {
  assert.deepEqual(movePromptInList(prompts, 'd', 'b', 'before').map(({ id }) => id), ['a', 'd', 'b', 'c'])
  assert.deepEqual(movePromptInList(prompts, 'a', 'c', 'after').map(({ id }) => id), ['b', 'c', 'a', 'd'])
})

test('chooses a drop slot from the dragged item center and ignores its source row', () => {
  const rows = [
    { id: 'a', top: 0, height: 80 },
    { id: 'b', top: 100, height: 80 },
    { id: 'c', top: 200, height: 80 },
  ]
  assert.deepEqual(findPromptInsertion(rows, 'a', 130), { targetId: 'b', position: 'before' })
  assert.deepEqual(findPromptInsertion(rows, 'a', 170), { targetId: 'c', position: 'before' })
  assert.deepEqual(findPromptInsertion(rows, 'a', 250), { targetId: 'c', position: 'after' })
})

test('keeps a stored user recording protected until removal is explicit', () => {
  const prompt = { audio: { size: 12 }, audioSource: 'user' }
  const hasAudio = (audio) => Boolean(audio?.size)
  assert.equal(blocksRecordingGeneration(prompt, false, hasAudio), true)
  assert.equal(blocksRecordingGeneration(prompt, true, hasAudio), false)
  assert.equal(blocksRecordingGeneration({ audio: { size: 12 }, audioSource: 'tts' }, false, hasAudio), false)
})

test('treats aborted recognition as recoverable, without masking permission failures', () => {
  assert.equal(isRecoverableRecognitionInterruption('aborted'), true)
  assert.equal(isRecoverableRecognitionInterruption('not-allowed'), false)
  assert.equal(isRecoverableRecognitionInterruption('audio-capture'), false)
})
