import { useMemo, useRef, useState } from 'react'
import { buildPdfDiagnosticReport } from './pdfFollow.js'

export default function PdfDiagnosticDetails({ error, failureTrace = null }) {
  const [copyStatus, setCopyStatus] = useState('')
  const textAreaRef = useRef(null)
  const report = useMemo(() => buildPdfDiagnosticReport(error, failureTrace), [error, failureTrace])

  async function copyReport() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report)
        setCopyStatus('Copied. Paste it into your message.')
        return
      }
    } catch {
      // Continue to the selection-based fallback, which also works on iOS Safari.
    }
    const textArea = textAreaRef.current
    if (!textArea) return
    textArea.focus()
    textArea.select()
    textArea.setSelectionRange(0, report.length)
    const copied = document.execCommand?.('copy') ?? false
    setCopyStatus(copied ? 'Copied. Paste it into your message.' : 'Text selected. Tap Copy in the iPhone selection menu.')
  }

  return (
    <details className="pdf-diagnostic-details">
      <summary>Copy PDF diagnostics for support</summary>
      <p>Includes the browser version, failed PDF stage, and recent trace. It does not include the PDF contents.</p>
      <button className="quiet-button" type="button" onClick={copyReport}>Copy diagnostic report</button>
      {copyStatus && <span className="pdf-diagnostic-copy-status" role="status">{copyStatus}</span>}
      <textarea
        ref={textAreaRef}
        className="pdf-diagnostic-report"
        value={report}
        readOnly
        rows={10}
        onFocus={(event) => event.currentTarget.select()}
        aria-label="PDF diagnostic report; select all and copy if the copy button is unavailable"
      />
    </details>
  )
}
