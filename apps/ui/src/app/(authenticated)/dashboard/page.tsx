import { Button } from "@/components/ui/button"
import { AppShell } from "@/components/app-shell"
import { ProjectList } from "./project-list"

export default function DashboardPage() {
  return (
    <AppShell actions={
      <Button asChild size="sm">
        <a href="/dashboard/projects/new">New project</a>
      </Button>
    }>
      <h1 className="text-xl font-semibold mb-6">Projects</h1>
      <ProjectList />
    </AppShell>
  )
}
