"use client"

import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  /** Custom fallback UI. Defaults to a minimal inline error message. */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="min-h-screen flex items-center justify-center p-4">
            <div className="text-center space-y-3">
              <p className="text-sm text-muted-foreground">Something went wrong.</p>
              <button
                type="button"
                className="text-sm underline underline-offset-2"
                onClick={() => this.setState({ hasError: false })}
              >
                Try again
              </button>
            </div>
          </div>
        )
      )
    }

    return this.props.children
  }
}
