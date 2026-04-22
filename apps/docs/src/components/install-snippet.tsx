"use client"

import { useState } from "react"

const INSTALL_CMD =
  "open https://canette.dev/docs/install"
  // "helm install canette oci://ghcr.io/canette/charts/canette --namespace canette-system --create-namespace"

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function InstallSnippet() {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(INSTALL_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 font-mono text-sm">
      <span className="text-muted-foreground select-none">$</span>
      <code className="flex-1 overflow-x-auto text-foreground/90 whitespace-nowrap">
        {INSTALL_CMD}
      </code>
      <button
        onClick={copy}
        aria-label="Copy command"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}
