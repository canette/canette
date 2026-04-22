import Link from "next/link"
import Image from "next/image"
import { InstallSnippet } from "@/components/install-snippet"
import { CanetteLogo } from "@/components/canette-logo"
import { features } from "@/data/features"

export default function HomePage() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-24 pb-20">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-center">
          {/* Left: text */}
          <div className="flex flex-col gap-6">
            <span className="inline-flex w-fit items-center rounded-full border border-[#ffdc64]/30 bg-[#ffdc64]/10 px-3 py-1 text-xs font-medium text-[#ffdc64]">
              Fast and User-Friendly PaaS for Kubernetes
            </span>
            <h1 className="text-4xl font-bold tracking-tight lg:text-5xl leading-tight">
              Deploy fast.
              <br />
              Keep it in your cluster.
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              canette is a lightweight deployment platform that runs inside any
              Kubernetes cluster. Push a repository and get a live URL —
              automatic build detection, instant webhook deploys, and
              proven infrastructure behind the scenes.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/docs"
                className="inline-flex items-center gap-1.5 rounded-md bg-[#ffdc64] px-5 py-2.5 text-sm font-semibold text-black hover:bg-[#f5d050] transition-colors"
              >
                Get started
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
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
              <a
                href="https://github.com/canette/canette"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-card transition-colors"
              >
                GitHub
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
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
            <InstallSnippet />
          </div>

          {/* Right: logo with glow */}
          <div className="relative flex items-center justify-center py-8">
            <div className="absolute h-64 w-64 rounded-full bg-[#ffdc64]/8 blur-3xl" />
            <CanetteLogo className="relative h-72 w-auto drop-shadow-2xl" />
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="mb-12 text-center text-2xl font-bold tracking-tight">
            Everything you need to go from repo to running app
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 hover:border-[#ffdc64]/30 transition-colors"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#ffdc64]/10 p-2 text-[#ffdc64]">
                  {f.icon}
                </div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        Copyright © {new Date().getFullYear()} The Canette Authors
      </footer>
    </main>
  );
}
