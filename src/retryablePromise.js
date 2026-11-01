export function createRetryablePromiseFactory(factory) {
  let currentPromise = null

  const run = (...args) => {
    if (!currentPromise) {
      const attempt = Promise.resolve().then(() => factory(...args))
      currentPromise = attempt
      attempt.catch(() => {
        if (currentPromise === attempt) currentPromise = null
      })
    }
    return currentPromise
  }

  run.reset = () => {
    currentPromise = null
  }

  return run
}
