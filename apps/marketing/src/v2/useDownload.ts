import { createContext, useContext } from 'react'

export type DownloadValue = {
  href: string
  onAnchorClick: (event: { preventDefault: () => void }) => void
  activate: () => void
}

export const DownloadContext = createContext<DownloadValue | null>(null)

export function useDownload(): DownloadValue {
  const value = useContext(DownloadContext)
  if (!value) throw new Error('useDownload must be used inside DownloadProvider')
  return value
}
