import { useRef } from 'react'
import { useDownload } from './useDownload'

type PhoneProps = {
  src: string
  alt: string
  width: number
  height: number
  className?: string
  priority?: boolean
}

export default function Phone({ src, alt, width, height, className, priority = false }: PhoneProps) {
  const { activate } = useDownload()
  const gesture = useRef({ x: 0, y: 0, moved: false })
  const classes = className ? `phone tap-dl ${className}` : 'phone tap-dl'

  return (
    <div
      className={classes}
      role="link"
      tabIndex={0}
      aria-label="Download Ferro Maps"
      onPointerDown={(event) => {
        gesture.current = { x: event.clientX, y: event.clientY, moved: false }
      }}
      onPointerMove={(event) => {
        if (Math.abs(event.clientX - gesture.current.x) > 10 || Math.abs(event.clientY - gesture.current.y) > 10) {
          gesture.current.moved = true
        }
      }}
      onClick={(event) => {
        if (gesture.current.moved) {
          gesture.current.moved = false
          return
        }
        event.preventDefault()
        activate()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
    >
      <i className="b act" />
      <i className="b vu" />
      <i className="b vd" />
      <i className="b pw" />
      <div className="screen">
        <img
          src={src}
          width={width}
          height={height}
          alt={alt}
          decoding="async"
          loading={priority ? 'eager' : 'lazy'}
          {...(priority ? { fetchPriority: 'high' as const } : {})}
        />
      </div>
    </div>
  )
}
