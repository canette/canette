import * as Avatar from "@radix-ui/react-avatar"

interface Props {
  name: string
  image?: string
}

export function UserAvatar({ name, image }: Props) {
  return (
    <Avatar.Root className="size-7 rounded-sm shrink-0 overflow-hidden bg-muted flex items-center justify-center">
      <Avatar.Image src={image} alt="" className="size-full object-cover" />
      <Avatar.Fallback className="text-xs font-medium text-muted-foreground leading-none">
        {name.charAt(0).toUpperCase()}
      </Avatar.Fallback>
    </Avatar.Root>
  )
}
