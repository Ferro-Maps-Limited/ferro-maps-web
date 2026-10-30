import { useEffect, useState } from 'react'
import {
  accountDeletedNoticeVisible,
  dismissAccountDeletedNotice,
  subscribeAccountDeleted,
} from '../lib/accountDeletion'

/**
 * Shown after account deletion. The settings modal unmounts as soon as the
 * Auth user disappears, so this is the confirmation that survives the redirect.
 * It also subscribes, because the notice can be recorded after this page mounts.
 */
export default function AccountDeletedNotice() {
  const [visible, setVisible] = useState(accountDeletedNoticeVisible)

  useEffect(() => subscribeAccountDeleted(() => setVisible(true)), [])

  if (!visible) return null

  return (
    <div
      className="fixed top-0 inset-x-0 z-[60] bg-ferro-tint text-ferro-ink text-sm px-4 py-3 text-center border-b border-ferro-primary/20"
      role="status"
    >
      Your account has been deleted and you have been signed out.
      <button
        type="button"
        onClick={() => {
          dismissAccountDeletedNotice()
          setVisible(false)
        }}
        className="ml-3 font-semibold underline"
      >
        Dismiss
      </button>
    </div>
  )
}
