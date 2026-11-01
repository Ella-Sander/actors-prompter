# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: reliability.spec.js >> imports script lines beside the original PDF under the production CSP
- Location: tests\browser\reliability.spec.js:60:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.script-import-meta')
Expected substring: "2 DIALOGUE LINES"
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" locator('.script-import-meta') with timeout 20000ms
  - waiting for locator('.script-import-meta')
    5 × locator resolved to <p class="script-import-meta">test-script.pdf  /  PROCESSING</p>
      - unexpected value "test-script.pdf  /  PROCESSING"

```

```yaml
- alert:
  - 'heading "Application error #1" [level=1]'
  - paragraph: The browser blocked a resource or JavaScript operation under the site’s Content Security Policy.
  - text: "Directive: style-src-attr Blocked: inline Source: http://127.0.0.1:5182/assets/index-Di4UJOqQ.js:8 Recent TTS trace: 2026-11-01T17:31:39.088Z csp-violation {\"directive\":\"style-src-attr\",\"blockedURI\":\"inline\",\"sourceFile\":\"http://127.0.0.1:5182/assets/index-Di4UJOqQ.js\",\"lineNumber\":8,\"ttsStatus\":null} Global error context: { \"time\": \"2026-11-01T17:31:39.089Z\", \"kind\": \"csp-violation\", \"directive\": \"style-src-attr\", \"blockedURI\": \"inline\", \"sourceFile\": \"http://127.0.0.1:5182/assets/index-Di4UJOqQ.js\", \"lineNumber\": 8, \"sample\": null, \"active\": { \"rehearsal\": null, \"playback\": null, \"recording\": null, \"tts\": null, \"browserCapabilities\": { \"secureContext\": true, \"mediaDevices\": false, \"getUserMedia\": false, \"mediaRecorder\": false, \"mediaRecorderMimeType\": \"\", \"speechRecognition\": false, \"speechSynthesis\": false, \"audioContext\": false, \"offlineAudioContext\": false, \"audioWorkletNode\": false, \"audioWorklet\": false, \"indexedDb\": true, \"fileReader\": true, \"fileArrayBuffer\": true, \"blobArrayBuffer\": true, \"intersectionObserver\": true, \"resizeObserver\": true, \"crossOriginIsolated\": true, \"sharedArrayBuffer\": false, \"wasm\": true, \"deviceMemory\": null } } }"
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test'
  2  | 
  3  | const productionCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://huggingface.co https://hf.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  4  | 
  5  | function createScriptPdf() {
  6  |   const content = 'BT /F1 14 Tf 72 720 Td (ALICE) Tj 0 -30 Td (Hello there.) Tj 0 -50 Td (BOB) Tj 0 -30 Td (Hi, Alice.) Tj ET'
  7  |   const objects = [
  8  |     '<< /Type /Catalog /Pages 2 0 R >>',
  9  |     '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  10 |     '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  11 |     '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  12 |     `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
  13 |   ]
  14 |   let source = '%PDF-1.4\n'
  15 |   const offsets = [0]
  16 |   objects.forEach((object, index) => {
  17 |     offsets.push(Buffer.byteLength(source, 'ascii'))
  18 |     source += `${index + 1} 0 obj\n${object}\nendobj\n`
  19 |   })
  20 |   const xrefOffset = Buffer.byteLength(source, 'ascii')
  21 |   source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  22 |   source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  23 |   source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  24 |   return Buffer.from(source, 'ascii')
  25 | }
  26 | 
  27 | async function openAppWithProductionCsp(page) {
  28 |   await page.route('http://127.0.0.1:5182/', async (route) => {
  29 |     const response = await route.fetch()
  30 |     await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': productionCsp } })
  31 |   })
  32 |   await page.goto('/')
  33 | }
  34 | 
  35 | async function createFolder(page, name) {
  36 |   await page.getByRole('button', { name: 'Create your first folder' }).click()
  37 |   await page.getByLabel('Folder name').fill(name)
  38 |   await page.getByRole('button', { name: 'Create folder' }).click()
  39 |   await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  40 | }
  41 | 
  42 | test('starts with detected browser capabilities and persists folders', async ({ page }) => {
  43 |   await openAppWithProductionCsp(page)
  44 |   await expect(page.getByRole('heading', { name: 'Prompt library' })).toBeVisible()
  45 | 
  46 |   const capabilities = await page.evaluate(() => window.__promptBrowserCapabilities)
  47 |   expect(capabilities).toMatchObject({
  48 |     secureContext: true,
  49 |     indexedDb: true,
  50 |   })
  51 |   expect(typeof capabilities.audioContext).toBe('boolean')
  52 |   expect(typeof capabilities.mediaRecorder).toBe('boolean')
  53 |   expect(typeof capabilities.speechRecognition).toBe('boolean')
  54 | 
  55 |   await createFolder(page, 'Cross platform test')
  56 |   await page.reload()
  57 |   await expect(page.getByRole('button', { name: /Cross platform test/ })).toBeVisible()
  58 | })
  59 | 
  60 | test('imports script lines beside the original PDF under the production CSP', async ({ page }) => {
  61 |   const cspMessages = []
  62 |   page.on('console', (message) => {
  63 |     if (message.text().includes('Content Security Policy')) cspMessages.push(message.text())
  64 |   })
  65 |   await openAppWithProductionCsp(page)
  66 |   await createFolder(page, 'PDF preview test')
  67 |   await page.getByRole('button', { name: /PDF preview test/ }).click()
  68 |   await page.getByRole('button', { name: 'Import Script' }).click()
  69 |   await page.locator('#script-pdf').setInputFiles({
  70 |     name: 'test-script.pdf',
  71 |     mimeType: 'application/pdf',
  72 |     buffer: createScriptPdf(),
  73 |   })
  74 | 
  75 |   await expect(page.getByRole('region', { name: 'Recognized prompts' })).toBeVisible({ timeout: 20_000 })
> 76 |   await expect(page.locator('.script-import-meta')).toContainText('2 DIALOGUE LINES', { timeout: 20_000 })
     |                                                     ^ Error: expect(locator).toContainText(expected) failed
  77 |   await expect(page.getByRole('textbox', { name: 'ALICE dialogue 1' })).toHaveValue('Hello there.')
  78 |   await expect(page.getByRole('checkbox', { name: 'Show original PDF' })).toBeChecked()
  79 |   await expect(page.getByTitle('Original PDF: test-script.pdf')).toBeVisible()
  80 | 
  81 |   const promptsBox = await page.getByRole('region', { name: 'Recognized prompts' }).boundingBox()
  82 |   const pdfBox = await page.getByRole('region', { name: 'Original PDF' }).boundingBox()
  83 |   expect(promptsBox.x).toBeLessThan(pdfBox.x)
  84 |   expect(cspMessages).toEqual([])
  85 | 
  86 |   await page.getByRole('checkbox', { name: 'Show original PDF' }).uncheck()
  87 |   await expect(page.getByTitle('Original PDF: test-script.pdf')).toHaveCount(0)
  88 |   await expect(page.getByRole('textbox', { name: 'ALICE dialogue 1' })).toBeVisible()
  89 | })
  90 | 
```