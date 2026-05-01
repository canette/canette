import Link from "next/link"
import { Button } from "@/components/ui/button"
import { AppShell } from "@/components/app-shell"
import { ProjectList } from "@/components/project-list"

export default function DashboardPage() {
  return (
    <AppShell actions={
      <Button asChild size="sm">
        <Link href="/dashboard/projects/new">New project</Link>
      </Button>
    }>
      <ProjectList />
    </AppShell>
  )
}
