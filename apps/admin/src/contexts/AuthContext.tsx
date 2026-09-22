import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  getIdTokenResult,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { toStaffRole, type StaffRole } from '../lib/roles'

type AuthContextType = {
  user: User | null
  role: StaffRole | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<StaffRole>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<StaffRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const tokenResult = await getIdTokenResult(firebaseUser)
        setUser(firebaseUser)
        setRole(toStaffRole(tokenResult.claims.role))
      } else {
        setUser(null)
        setRole(null)
      }
      setLoading(false)
    })
    return unsubscribe
  }, [])

  async function signIn(email: string, password: string) {
    const credential = await signInWithEmailAndPassword(auth, email, password)
    const tokenResult = await getIdTokenResult(credential.user, true)
    const staffRole = toStaffRole(tokenResult.claims.role)
    if (!staffRole) {
      await firebaseSignOut(auth)
      throw new Error('not-staff')
    }
    return staffRole
  }

  async function signOut() {
    await firebaseSignOut(auth)
  }

  return (
    <AuthContext.Provider value={{ user, role, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
