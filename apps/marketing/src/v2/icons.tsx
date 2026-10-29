export function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M7.6 14.2 3.4 10l1.4-1.4 2.8 2.8 7.6-7.6L16.6 5z" />
    </svg>
  )
}

export function AppleIcon() {
  return (
    <svg className="ico" viewBox="0 0 384 512" width="16" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
      />
    </svg>
  )
}

export function LockIcon({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="3.5" fill={color} />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="12" cy="15.5" r="1.8" fill="#fff" />
    </svg>
  )
}

export function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="9" r="3.2" fill="currentColor" />
      <circle cx="16" cy="9" r="3.2" fill="currentColor" />
      <path
        d="M2.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M10.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  )
}

export function VerifiedIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="vtick" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0A74BE" />
      <path
        d="M6.8 12.4l3.4 3.4 7-7.2"
        fill="none"
        stroke="#fff"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
