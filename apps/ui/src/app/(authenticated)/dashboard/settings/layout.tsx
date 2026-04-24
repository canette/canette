import { AppShell } from "@/components/app-shell"

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell breadcrumb={[{ label: "Settings" }]} rawMain>
      <div className="max-w-6xl mx-auto w-full px-6 py-8">
        {children}
      </div>
    </AppShell>
  )
}
