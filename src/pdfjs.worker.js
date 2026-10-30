// PDF.js worker runs in a separate global scope, so install required WebKit
// compatibility there before evaluating PDF.js's worker runtime.
import './pdfRuntimePolyfill.js'
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
