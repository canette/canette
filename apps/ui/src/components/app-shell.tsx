import { CanetteLogo } from "@/components/canette-logo"
import { Footer } from "@/components/footer"
import { UserMenu } from "@/app/(authenticated)/dashboard/user-menu"

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface AppShellProps {
  /** Items appended after the canette logo. Last item is the current page (no href needed). */
  breadcrumb?: BreadcrumbItem[]
  /** Rendered to the left of the UserMenu in the header. */
  actions?: React.ReactNode
  /** When true, skips the default max-w-6xl padded wrapper so the page can control its own layout. */
  rawMain?: boolean
  children: React.ReactNode
}

export function AppShell({ breadcrumb = [], actions, rawMain, children }: AppShellProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <nav className="flex items-center gap-2 text-sm">
            <a
              href="/dashboard"
              className="flex items-center gap-2 font-semibold tracking-tight hover:opacity-80 transition-opacity"
            >
              <CanetteLogo className="size-5 p-0.5" />
              canette
            </a>
            {breadcrumb.map((item, i) => (
              <span key={i} className="contents">
                <span className="text-muted-foreground/40">/</span>
                {item.href ? (
                  <a href={item.href} className="text-muted-foreground hover:text-foreground transition-colors">
                    {item.label}
                  </a>
                ) : (
                  <span className="font-medium">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {actions}
            <UserMenu />
          </div>
        </div>
      </header>

      {rawMain ? (
        <div className="flex-1">{children}</div>
      ) : (
        <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
          {children}
        </main>
      )}

      <Footer />
    </div>
  )
}
