import { BookOpen } from "lucide-react"
import { GitHubIcon } from "@/components/icons/github-icon"

const DOCS_URL = "https://canette.dev/docs"
const GITHUB_URL = "https://github.com/canette/canette"

export function Footer() {
  return (
    <footer className="mt-auto">
      <div className="max-w-6xl mx-auto px-6 h-12 flex items-center justify-end">
        <nav className="flex items-center gap-4">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen size={13} />
            Docs
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <GitHubIcon size={13} />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  )
}
