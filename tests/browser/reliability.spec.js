/* global Buffer */
import { expect, test } from '@playwright/test'

const productionCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://huggingface.co https://hf.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

function createScriptPdf() {
  const content = 'BT /F1 14 Tf 72 720 Td (ALICE) Tj 0 -30 Td (Hello there.) Tj 0 -50 Td (BOB) Tj 0 -30 Td (Hi, Alice.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'ascii'))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(source, 'ascii')
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(source, 'ascii')
}

async function openAppWithProductionCsp(page) {
  await page.route('http://127.0.0.1:5182/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': productionCsp } })
  })
  await page.goto('/')
}

async function createFolder(page, name) {
  await page.getByRole('button', { name: 'Create your first folder' }).click()
  await page.getByLabel('Folder name').fill(name)
  await page.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
}

test('starts with detected browser capabilities and persists folders', async ({ page }) => {
  await openAppWithProductionCsp(page)
  await expect(page.getByRole('heading', { name: 'Prompt library' })).toBeVisible()

  const capabilities = await page.evaluate(() => window.__promptBrowserCapabilities)
  expect(capabilities).toMatchObject({
    secureContext: true,
    indexedDb: true,
  })
  expect(typeof capabilities.audioContext).toBe('boolean')
  expect(typeof capabilities.mediaRecorder).toBe('boolean')
  expect(typeof capabilities.speechRecognition).toBe('boolean')

  await createFolder(page, 'Cross platform test')
  await page.reload()
  await expect(page.getByRole('button', { name: /Cross platform test/ })).toBeVisible()
})

test('imports script lines beside the original PDF under the production CSP', async ({ page }) => {
  const cspMessages = []
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) cspMessages.push(message.text())
  })
  await openAppWithProductionCsp(page)
  await createFolder(page, 'PDF preview test')
  await page.getByRole('button', { name: /PDF preview test/ }).click()
  await page.getByRole('button', { name: 'Import Script' }).click()
  await page.locator('#script-pdf').setInputFiles({
    name: 'test-script.pdf',
    mimeType: 'application/pdf',
    buffer: createScriptPdf(),
  })

  await expect(page.getByRole('region', { name: 'Recognized prompts' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.script-import-meta')).toContainText('2 DIALOGUE LINES', { timeout: 20_000 })
  await expect(page.getByRole('textbox', { name: 'ALICE dialogue 1' })).toHaveValue('Hello there.')
  await expect(page.getByRole('checkbox', { name: 'Show original PDF' })).toBeChecked()
  await expect(page.getByTitle('Original PDF: test-script.pdf')).toBeVisible()

  const promptsBox = await page.getByRole('region', { name: 'Recognized prompts' }).boundingBox()
  const pdfBox = await page.getByRole('region', { name: 'Original PDF' }).boundingBox()
  expect(promptsBox.x).toBeLessThan(pdfBox.x)
  expect(cspMessages).toEqual([])

  await page.getByRole('checkbox', { name: 'Show original PDF' }).uncheck()
  await expect(page.getByTitle('Original PDF: test-script.pdf')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'ALICE dialogue 1' })).toBeVisible()
})
