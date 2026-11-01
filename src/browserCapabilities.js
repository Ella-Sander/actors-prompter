export function getAudioContextConstructor(target = globalThis) {
  return target.AudioContext ?? target.webkitAudioContext ?? null
}

export function getOfflineAudioContextConstructor(target = globalThis) {
  return target.OfflineAudioContext ?? target.webkitOfflineAudioContext ?? null
}

export function getMediaRecorderConstructor(target = globalThis) {
  return typeof target.MediaRecorder === 'function' ? target.MediaRecorder : null
}

export function getSpeechRecognitionConstructor(target = globalThis) {
  const constructor = target.SpeechRecognition ?? target.webkitSpeechRecognition
  return typeof constructor === 'function' ? constructor : null
}

export function getPreferredRecordingMimeType(MediaRecorderConstructor) {
  if (typeof MediaRecorderConstructor?.isTypeSupported !== 'function') return ''
  return [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
  ].find((type) => MediaRecorderConstructor.isTypeSupported(type)) ?? ''
}

export function detectBrowserCapabilities(target = globalThis) {
  const navigator = target.navigator ?? {}
  const AudioContextConstructor = getAudioContextConstructor(target)
  const OfflineAudioContextConstructor = getOfflineAudioContextConstructor(target)
  const MediaRecorderConstructor = getMediaRecorderConstructor(target)
  const SpeechRecognitionConstructor = getSpeechRecognitionConstructor(target)

  return {
    secureContext: Boolean(target.isSecureContext),
    mediaDevices: Boolean(navigator.mediaDevices),
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    mediaRecorder: Boolean(MediaRecorderConstructor),
    mediaRecorderMimeType: getPreferredRecordingMimeType(MediaRecorderConstructor),
    speechRecognition: Boolean(SpeechRecognitionConstructor),
    speechSynthesis: Boolean(target.speechSynthesis && typeof target.speechSynthesis.speak === 'function'),
    audioContext: Boolean(AudioContextConstructor),
    offlineAudioContext: Boolean(OfflineAudioContextConstructor),
    audioWorkletNode: typeof target.AudioWorkletNode === 'function',
    audioWorklet: Boolean(AudioContextConstructor?.prototype && 'audioWorklet' in AudioContextConstructor.prototype),
    indexedDb: typeof target.indexedDB?.open === 'function',
    fileReader: typeof target.FileReader === 'function',
    fileArrayBuffer: typeof target.File?.prototype?.arrayBuffer === 'function',
    blobArrayBuffer: typeof target.Blob?.prototype?.arrayBuffer === 'function',
    intersectionObserver: typeof target.IntersectionObserver === 'function',
    resizeObserver: typeof target.ResizeObserver === 'function',
    crossOriginIsolated: Boolean(target.crossOriginIsolated),
    sharedArrayBuffer: typeof target.SharedArrayBuffer === 'function',
    wasm: typeof target.WebAssembly !== 'undefined',
    deviceMemory: navigator.deviceMemory ?? null,
  }
}
