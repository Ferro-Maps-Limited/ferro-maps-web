import { useCallback, useRef, useState, type ReactNode } from 'react'
import { AppleIcon } from './icons'
import { APP_STORE, PLAY_STORE } from './links'
import { DownloadContext, useDownload, type DownloadValue } from './useDownload'

type Platform = 'ios' | 'android' | 'desktop'

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (ios) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [platform] = useState(detectPlatform)
  const href = platform === 'ios' ? APP_STORE : platform === 'android' ? PLAY_STORE : '#download'

  const activate = useCallback(() => {
    if (platform === 'ios') {
      window.location.assign(APP_STORE)
      return
    }
    if (platform === 'android') {
      window.location.assign(PLAY_STORE)
      return
    }
    const dialog = dialogRef.current
    if (dialog && typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
      dialog.querySelector<HTMLElement>('.dl-opts a')?.focus()
      return
    }
    window.location.hash = 'download'
  }, [platform])

  const onAnchorClick = useCallback(
    (event: { preventDefault: () => void }) => {
      if (platform === 'desktop') {
        event.preventDefault()
        activate()
      }
    },
    [platform, activate],
  )

  const value: DownloadValue = { href, onAnchorClick, activate }

  return (
    <DownloadContext.Provider value={value}>
      {children}
      <dialog
        className="dl-dialog"
        id="dl-dialog"
        aria-labelledby="dl-title"
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
      >
        <form method="dialog">
          <button className="dl-x" type="submit" aria-label="Close">
            ×
          </button>
        </form>
        <h2 id="dl-title">Download Ferro Maps</h2>
        <p>Choose your phone</p>
        <div className="dl-opts">
          <a className="btn btn-blue" href={APP_STORE}>
            <AppleIcon />
            iPhone
          </a>
          <a className="btn btn-ink" href={PLAY_STORE}>
            ▶ Android
          </a>
        </div>
      </dialog>
    </DownloadContext.Provider>
  )
}

export function DownloadButton({ className, children }: { className: string; children: ReactNode }) {
  const { href, onAnchorClick } = useDownload()
  return (
    <a className={className} href={href} onClick={onAnchorClick}>
      {children}
    </a>
  )
}

export function StoreButtons() {
  return (
    <div className="ctas center">
      <a className="btn btn-white" href={APP_STORE}>
        <AppleIcon />
        App Store
      </a>
      <a className="btn btn-ink" href={PLAY_STORE}>
        ▶ Google Play
      </a>
    </div>
  )
}

export function DownloadStrip() {
  return (
    <section className="dl-strip" id="download">
      <div className="wrap center-t">
        <h2 className="big">Get Ferro Maps</h2>
        <p className="along-line dark">
          Works next to Uber, Bolt and any ride-hailing app. Not connected to your accounts.
        </p>
        <StoreButtons />
      </div>
    </section>
  )
}
