export function movePromptInList(prompts, draggedId, targetId, position = 'before') {
  if (!draggedId || !targetId || draggedId === targetId) return prompts
  const ordered = [...prompts]
  const sourceIndex = ordered.findIndex((prompt) => prompt.id === draggedId)
  if (sourceIndex < 0 || !ordered.some((prompt) => prompt.id === targetId)) return prompts

  const [draggedPrompt] = ordered.splice(sourceIndex, 1)
  const targetIndex = ordered.findIndex((prompt) => prompt.id === targetId)
  ordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedPrompt)
  return ordered
}

export function findPromptInsertion(rows, draggedId, itemCenterY) {
  const targets = rows.filter((row) => row.id !== draggedId)
  if (targets.length === 0) return null
  for (const row of targets) {
    if (itemCenterY < row.top + row.height / 2) return { targetId: row.id, position: 'before' }
  }
  return { targetId: targets[targets.length - 1].id, position: 'after' }
}

export function blocksRecordingGeneration(prompt, userRecordingRemoved, hasUsableRecording) {
  return Boolean(prompt && hasUsableRecording(prompt.audio) && prompt.audioSource !== 'tts' && !userRecordingRemoved)
}

export function isRecoverableRecognitionInterruption(error) {
  return error === 'aborted'
}
