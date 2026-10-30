import assert from 'node:assert/strict'
import test from 'node:test'
import { findPdfDialogueMatch, inspectPdfDialogueMatch, normalizePdfMatchText, readBlobAsArrayBuffer, readPdfPageTextItems } from './pdfFollow.js'

test('reads text stream chunks in original order without async iteration', async () => {
  const first = { str: 'First', transform: [1, 0, 0, 1, 0, 10] }
  const second = { str: 'second', transform: [1, 0, 0, 1, 0, 8] }
  const page = { streamTextContent: () => new ReadableStream({
    start(controller) {
      controller.enqueue({ items: [first] })
      controller.enqueue({ items: [second] })
      controller.close()
    },
  }) }
  assert.deepEqual(await readPdfPageTextItems(page), [first, second])
})

test('returns no items for an empty PDF text stream', async () => {
  const page = { streamTextContent: () => new ReadableStream({ start(controller) { controller.close() } }) }
  assert.deepEqual(await readPdfPageTextItems(page), [])
})

test('reports malformed text stream chunks instead of silently dropping content', async () => {
  const page = { streamTextContent: () => new ReadableStream({ start(controller) { controller.enqueue({ text: 'not items' }) } }) }
  await assert.rejects(readPdfPageTextItems(page), /without an items array/)
})

function makeIndex(lines) {
  const words = []
  lines.forEach(({ page = 1, y, text }, lineIndex) => {
    for (const word of normalizePdfMatchText(text)) words.push({ word, page, y: y + lineIndex * 20, rowId: lineIndex, pageHeight: 800 })
  })
  return { words }
}

test('normalizes punctuation, case, quotes, and whitespace for dialogue matching', () => {
  assert.deepEqual(normalizePdfMatchText('“Hello,  THERE—my friend!”\nDon’t go.'), ['hello', 'there', 'my', 'friend', 'don', 't', 'go'])
})

test('reads PDF bytes from a Blob for PDF.js', async () => {
  const source = new Blob(['pdf bytes'], { type: 'application/pdf' })
  const result = await readBlobAsArrayBuffer(source)
  assert.equal(new TextDecoder().decode(result), 'pdf bytes')
})

test('finds dialogue spanning PDF text rows', () => {
  const index = makeIndex([
    { y: 80, text: 'I thought you said that we were leaving' },
    { y: 110, text: 'before the morning light arrived.' },
  ])
  const match = findPdfDialogueMatch('I thought you said that we were leaving before the morning light arrived.', index)
  assert.equal(match?.page, 1)
  assert.ok(match?.similarity >= 0.95)
  assert.ok(match?.endY > match?.y)
})

test('uses the sequential anchor to choose the later repeated line', () => {
  const repeated = 'You know I never meant to hurt you'
  const index = makeIndex([
    { y: 80, text: repeated },
    { y: 500, text: repeated },
  ])
  const match = findPdfDialogueMatch(repeated, index, { page: 1, y: 430, pageHeight: 800 }, 1)
  assert.ok(match)
  assert.ok(match.y > 400)
})

test('prefers the prior occurrence when navigating backward', () => {
  const repeated = 'I cannot believe you said those words today'
  const index = makeIndex([
    { y: 100, text: repeated },
    { y: 500, text: repeated },
  ])
  const match = findPdfDialogueMatch(repeated, index, { page: 1, y: 400, pageHeight: 800 }, -1)
  assert.ok(match)
  assert.ok(match.y < 250)
})

test('accepts a unique exact short line but keeps ambiguous short lines unresolved', () => {
  const index = makeIndex([{ y: 200, text: 'Yes, I am.' }])
  assert.equal(inspectPdfDialogueMatch('Yes, I am.', index).diagnostics.reason, 'short-unique-exact-match')
  const repeated = makeIndex([{ y: 100, text: 'Yes, I am.' }, { y: 500, text: 'Yes, I am.' }])
  assert.equal(inspectPdfDialogueMatch('Yes, I am.', repeated).diagnostics.reason, 'short-ambiguous-in-document')
  const longerIndex = makeIndex([{ y: 200, text: 'I know exactly what you mean by that.' }])
  const match = findPdfDialogueMatch('I know exactly what you mean by that.', longerIndex, { page: 1, y: 190, pageHeight: 800 })
  assert.ok(match)
})

test('explains when PDF text is unavailable or the prompt is too short', () => {
  assert.equal(inspectPdfDialogueMatch('A long enough line to search for', { words: [] }).diagnostics.reason, 'no-selectable-text')
})

test('matches an exact short line one or two rows forward from the current prompt', () => {
  const index = makeIndex([
    { y: 100, text: 'Current confirmed prompt here' },
    { y: 120, text: 'stage direction intervenes' },
    { y: 140, text: 'No, never.' },
  ])
  const result = inspectPdfDialogueMatch('No, never.', index, { page: 1, rowId: 0, startRowId: 0, endRowId: 0 }, 1)
  assert.equal(result.diagnostics.reason, 'short-nearby-exact-match')
  assert.equal(result.match.rowId, 2)
  assert.equal(result.diagnostics.rowDistance, 2)
})

test('matches an exact short line one or two rows backward', () => {
  const index = makeIndex([
    { y: 100, text: 'Wait, what?' },
    { y: 120, text: 'stage direction intervenes' },
    { y: 140, text: 'Current confirmed prompt here' },
  ])
  const result = inspectPdfDialogueMatch('Wait, what?', index, { page: 1, rowId: 2, startRowId: 2, endRowId: 2 }, -1)
  assert.equal(result.diagnostics.reason, 'short-nearby-exact-match')
  assert.equal(result.match.rowId, 0)
})

test('does not guess a short phrase found far from the current anchor', () => {
  const index = makeIndex([
    { y: 100, text: 'Current confirmed prompt here' },
    { y: 120, text: 'one line' },
    { y: 140, text: 'two line' },
    { y: 160, text: 'three line' },
    { y: 180, text: 'Yes, fine.' },
  ])
  const result = inspectPdfDialogueMatch('Yes, fine.', index, { page: 1, rowId: 0, startRowId: 0, endRowId: 0 }, 1)
  assert.equal(result.match, null)
  assert.equal(result.diagnostics.reason, 'short-match-not-near-anchor')
})

test('reports the best candidate and confidence when no match meets threshold', () => {
  const index = makeIndex([{ y: 100, text: 'We should wait until tomorrow morning and see what happens' }])
  const result = inspectPdfDialogueMatch('We should leave before the sun begins to rise', index)
  assert.equal(result.match, null)
  assert.equal(result.diagnostics.reason, 'below-confidence-threshold')
  assert.ok(result.diagnostics.bestConfidence < result.diagnostics.threshold)
  assert.ok(result.diagnostics.candidatePreview)
})
