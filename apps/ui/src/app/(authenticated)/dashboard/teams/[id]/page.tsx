import { redirect } from "next/navigation"

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string>>
}) {
  const { id } = await params
  const sp = await searchParams
  const query = new URLSearchParams(sp).toString()
  redirect(`/dashboard/teams/${id}/credentials${query ? `?${query}` : ""}`)
}
