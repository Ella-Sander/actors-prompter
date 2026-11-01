import assert from 'node:assert/strict'
import test from 'node:test'
import { detectBrowserCapabilities, getAudioContextConstructor, getPreferredRecordingMimeType, getSpeechRecognitionConstructor } from './browserCapabilities.js'

test('detects prefixed Safari APIs without relying on user-agent strings', () => {
  function WebkitAudioContext() {}
  function WebkitSpeechRecognition() {}
  class MediaRecorder {
    static isTypeSupported(type) { return type === 'audio/mp4' }
  }

  const target = {
    isSecureContext: true,
    webkitAudioContext: WebkitAudioContext,
    webkitSpeechRecognition: WebkitSpeechRecognition,
    MediaRecorder,
    indexedDB: { open() {} },
    navigator: { mediaDevices: { getUserMedia() {} } },
  }
  const capabilities = detectBrowserCapabilities(target)

  assert.equal(getAudioContextConstructor(target), WebkitAudioContext)
  assert.equal(getSpeechRecognitionConstructor(target), WebkitSpeechRecognition)
  assert.equal(capabilities.secureContext, true)
  assert.equal(capabilities.getUserMedia, true)
  assert.equal(capabilities.speechRecognition, true)
  assert.equal(capabilities.mediaRecorderMimeType, 'audio/mp4')
  assert.equal(capabilities.indexedDb, true)
})

test('reports unsupported features and falls back to browser-default recording format', () => {
  const capabilities = detectBrowserCapabilities({ navigator: {} })

  assert.equal(capabilities.mediaRecorder, false)
  assert.equal(capabilities.speechRecognition, false)
  assert.equal(capabilities.audioContext, false)
  assert.equal(capabilities.getUserMedia, false)
  assert.equal(capabilities.indexedDb, false)
  assert.equal(getPreferredRecordingMimeType(undefined), '')
})
