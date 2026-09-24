import { useState } from 'react'
import { Button, Dialog, Input } from '@ferro-maps/ui'
import { Megaphone, TriangleAlert } from 'lucide-react'
import { submitConfigRequest } from '../lib/configRequests'

/**
 * Editing what the apps read: the latest app version, and the promo banner.
 *
 * Both are one confirmation away from a push notification to every driver, so
 * the dialogs say exactly who is about to be notified and neither saves on a
 * stray keystroke. Editing a banner's words without republishing it is a
 * separate, quiet action — the mobile trigger only notifies when the banner is
 * newly active or carries a new id.
 */

export type AppConfig = {
  latestVersion?: string
  updateMessage?: string
  bannerTitle?: string
  bannerBody?: string
  bannerActive?: boolean
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle last:border-0">
      <span className="text-body-sm text-text-tertiary">{label}</span>
      <span className="text-body-sm font-semibold text-text-primary text-right">{value}</span>
    </div>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-md bg-amber-50 p-3 mb-4">
      <TriangleAlert size={16} className="text-status-warning flex-shrink-0 mt-0.5" />
      <p className="text-body-sm text-text-secondary">{children}</p>
    </div>
  )
}

export default function ReleaseControls({ config, drivers }: { config: AppConfig; drivers: number | null }) {
  const [versionOpen, setVersionOpen] = useState(false)
  const [bannerOpen, setBannerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [version, setVersion] = useState(config.latestVersion ?? '')
  const [versionMessage, setVersionMessage] = useState(config.updateMessage ?? '')
  const [title, setTitle] = useState(config.bannerTitle ?? '')
  const [body, setBody] = useState(config.bannerBody ?? '')

  const everyone = drivers ? `all ${drivers.toLocaleString()} drivers` : 'every driver'

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true)
    setError(null)
    try {
      await work()
      setDone(success)
      setVersionOpen(false)
      setBannerOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="text-label font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Megaphone size={16} />
        Release and messaging
      </p>

      <Row label="Latest app version" value={config.latestVersion ?? '—'} />
      <Row label="Promo banner" value={config.bannerActive ? 'Showing to drivers' : 'Not showing'} />

      {config.bannerTitle && (
        <div className={`mt-3 rounded-md bg-ferro-deep text-white p-3 ${config.bannerActive ? '' : 'opacity-60'}`}>
          <p className="text-overline uppercase tracking-wide text-white/60">
            {config.bannerActive ? 'Showing now' : 'Saved, not showing'}
          </p>
          <p className="text-label font-semibold">{config.bannerTitle}</p>
          <p className="text-caption text-white/80">{config.bannerBody}</p>
        </div>
      )}

      <div className="flex gap-2 mt-4 flex-wrap">
        <Button variant="secondary" onClick={() => setVersionOpen(true)}>
          Change version
        </Button>
        <Button variant="secondary" onClick={() => setBannerOpen(true)}>
          {config.bannerActive ? 'Edit banner' : 'Set a banner'}
        </Button>
      </div>

      {done && <p className="text-body-sm text-status-success mt-3">{done}</p>}
      {error && !versionOpen && !bannerOpen && <p className="text-body-sm text-status-danger mt-3">{error}</p>}

      <p className="text-caption text-text-tertiary mt-3">
        Both are applied by a background job after checking, because config cannot be written from a browser.
      </p>

      <Dialog
        open={versionOpen}
        onOpenChange={setVersionOpen}
        title="Change the latest app version"
        description="Drivers on an older build are prompted to update."
      >
        <Warning>
          Saving a new version number notifies {everyone}. Leaving it as it is changes nothing and notifies nobody.
        </Warning>

        <div className="flex flex-col gap-3">
          <Input label="Version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.3.0" />
          <Input
            label="Message (optional)"
            value={versionMessage}
            onChange={(e) => setVersionMessage(e.target.value)}
            placeholder="FerroMaps 1.3.0 is available."
          />
          {error && <p className="text-body-sm text-status-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={() => setVersionOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || version.trim() === (config.latestVersion ?? '')}
            onClick={() =>
              void run(
                () =>
                  submitConfigRequest('appVersion', {
                    latestVersion: version.trim(),
                    updateMessage: versionMessage.trim() || undefined,
                  }),
                `Version set to ${version.trim()}. Drivers on older builds have been notified.`,
              )
            }
          >
            {busy ? 'Publishing…' : `Publish and notify ${everyone}`}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={bannerOpen}
        onOpenChange={setBannerOpen}
        title="Promo banner"
        description="Shown inside the app, on top of the map."
      >
        <Warning>
          Publishing sends a notification to {everyone}. Saving the wording without publishing updates the banner
          quietly for anyone who opens the app.
        </Warning>

        <div className="flex flex-col gap-3">
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Busy tonight" />
          <Input
            label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Stadium event at 19:00."
          />
          {error && <p className="text-body-sm text-status-danger">{error}</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 mt-5">
          {config.bannerActive && (
            <Button
              variant="secondary"
              disabled={busy}
              className="border-status-danger text-status-danger hover:bg-red-50"
              onClick={() =>
                void run(
                  () =>
                    submitConfigRequest('banner', {
                      title: title.trim(),
                      body: body.trim(),
                      isActive: false,
                      notify: false,
                    }),
                  'Banner hidden. Nobody was notified.',
                )
              }
            >
              Stop showing it
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy || !title.trim() || !body.trim()}
            onClick={() =>
              void run(
                () =>
                  submitConfigRequest('banner', {
                    title: title.trim(),
                    body: body.trim(),
                    isActive: config.bannerActive ?? false,
                    notify: false,
                  }),
                'Wording saved. Nobody was notified.',
              )
            }
          >
            Save wording quietly
          </Button>
          <Button
            disabled={busy || !title.trim() || !body.trim()}
            onClick={() =>
              void run(
                () =>
                  submitConfigRequest('banner', {
                    title: title.trim(),
                    body: body.trim(),
                    isActive: true,
                    notify: true,
                  }),
                `Banner published. ${everyone.charAt(0).toUpperCase()}${everyone.slice(1)} notified.`,
              )
            }
          >
            {busy ? 'Publishing…' : `Publish and notify ${everyone}`}
          </Button>
        </div>
      </Dialog>
    </>
  )
}
