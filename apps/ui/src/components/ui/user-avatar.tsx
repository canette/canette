interface Props {
  name: string
  image?: string
}

export function UserAvatar({ name, image }: Props) {
  return (
    <div className="size-7 rounded-sm shrink-0 overflow-hidden bg-muted flex items-center justify-center">
      {image
        ? <img src={image} alt="" className="size-full object-cover" />
        : <span className="text-xs font-medium text-muted-foreground leading-none">{name.charAt(0).toUpperCase()}</span>
      }
    </div>
  )
}
