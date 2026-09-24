import { collection, getDocs, limit, orderBy, query, where, GeoPoint, Timestamp } from 'firebase/firestore'
import { db } from './firebase'

/**
 * Finding a driver among all of them, not just the page on screen.
 *
 * Firestore has no substring search, so this matches from the start of a name,
 * email or phone number — the way somebody types when they have a name or a
 * number in front of them. Names are stored however the driver typed them
 * ("AHMAD SAHI", "Sameer Miah"), so each casing is asked for separately;
 * Firestore compares strings byte by byte and would otherwise miss them.
 *
 * Anything cleverer — substrings, fuzzy matching, "smith" finding "Smythe" —
 * needs a search index outside Firestore. Worth it once the fleet is large
 * enough that people search by fragments; not yet.
 */

const PER_QUERY = 10
export const MAX_RESULTS = 40
export const MIN_TERM_LENGTH = 2

export type DriverMatch = {
  uid: string
  name: string
  email: string
  phoneNumber: string
  isOnline: boolean
  isSuspended: boolean
  ferroBalance: number
  country: string
  lat?: number
  lng?: number
  joinedAt: Timestamp | null
  suspendedAt: Timestamp | null
}

function titleCase(term: string): string {
  return term.replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
}

/** The spellings of a typed name worth asking Firestore about. */
function nameVariants(term: string): string[] {
  return [...new Set([term, term.toLowerCase(), term.toUpperCase(), titleCase(term)])]
}

/**
 * UK numbers are stored in international form. Somebody reading a number off a
 * ticket types it the way the driver wrote it, which is usually 07…
 */
function phoneVariants(term: string): string[] {
  const digits = term.replace(/[^\d+]/g, '')
  if (!digits) return []
  const variants = [digits]
  if (digits.startsWith('0')) variants.push(`+44${digits.slice(1)}`)
  if (digits.startsWith('44')) variants.push(`+${digits}`)
  if (digits.startsWith('+44')) variants.push(`0${digits.slice(3)}`)
  return [...new Set(variants)]
}

function toMatch(id: string, d: Record<string, unknown>): DriverMatch {
  return {
    uid: (d.uid as string) ?? id,
    name: (d.name as string) ?? '',
    email: (d.email as string) ?? '',
    phoneNumber: (d.phoneNumber as string) ?? '',
    isOnline: d.isOnline === true,
    isSuspended: d.isSuspended === true,
    ferroBalance: typeof d.ferroBalance === 'number' ? d.ferroBalance : 0,
    country: (d.country as string) ?? '',
    lat: d.location instanceof GeoPoint ? d.location.latitude : undefined,
    lng: d.location instanceof GeoPoint ? d.location.longitude : undefined,
    joinedAt: d.joinedAt instanceof Timestamp ? d.joinedAt : d.createdAt instanceof Timestamp ? d.createdAt : null,
    suspendedAt: d.suspendedAt instanceof Timestamp ? d.suspendedAt : null,
  }
}

async function prefixMatches(field: string, value: string): Promise<DriverMatch[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users'),
        orderBy(field),
        where(field, '>=', value),
        where(field, '<=', `${value}`),
        limit(PER_QUERY),
      ),
    )
    return snap.docs.map((d) => toMatch(d.id, d.data()))
  } catch (error) {
    console.error(`Driver search on ${field} failed:`, error)
    return []
  }
}

/** Drivers whose name, email or phone number starts with `term`. */
export async function searchDrivers(term: string): Promise<DriverMatch[]> {
  const trimmed = term.trim()
  if (trimmed.length < MIN_TERM_LENGTH) return []

  const lookups = [
    ...nameVariants(trimmed).map((value) => prefixMatches('name', value)),
    prefixMatches('email', trimmed.toLowerCase()),
    ...phoneVariants(trimmed).map((value) => prefixMatches('phoneNumber', value)),
  ]

  const results = await Promise.all(lookups)
  const byUid = new Map<string, DriverMatch>()
  for (const match of results.flat()) {
    if (!byUid.has(match.uid)) byUid.set(match.uid, match)
  }

  return [...byUid.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_RESULTS)
}

/** The driver who owns an email address, if any. Used to put a ticket in context. */
export async function findDriverByEmail(email: string | undefined): Promise<DriverMatch | null> {
  const value = email?.trim().toLowerCase()
  if (!value) return null
  const matches = await prefixMatches('email', value)
  return matches.find((match) => match.email.trim().toLowerCase() === value) ?? null
}
