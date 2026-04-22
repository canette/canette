import { AppShell } from "@/components/app-shell"
import { SettingsNav } from "./settings-nav"

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell breadcrumb={[{ label: "Settings" }]} rawMain>
      <div className="max-w-6xl mx-auto w-full px-6 py-8">
        <div className="flex gap-10">
          <aside className="w-44 shrink-0">
            <SettingsNav />
          </aside>
          <main className="flex-1 min-w-0">
            {children}
          </main>
        </div>
      </div>
    </AppShell>
  )
}
