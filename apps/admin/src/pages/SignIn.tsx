import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { Button, Card, Input } from '@ferro-maps/ui'
import { useAuth } from '../contexts/AuthContext'
import ferroBirdIcon from '../assets/ferro-bird-icon.png'
import { homeFor } from '../lib/roles'

type FirebaseError = { code?: string; message: string }

function mapError(err: FirebaseError): string {
  if (err.message === 'not-staff') {
    return 'This account does not have access to the admin console. Contact Brandon if you believe this is a mistake.'
  }
  switch (err.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.'
    case 'auth/invalid-email':
      return 'Please enter a valid email address.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.'
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection and try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

export default function SignIn() {
  const { signIn } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const role = await signIn(email, password)
      navigate(homeFor(role))
    } catch (err) {
      setError(mapError(err as FirebaseError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-ferro-tint flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 mb-6">
          <img
            src={ferroBirdIcon}
            alt="Ferro the Bird"
            className="w-16 h-16 rounded-card shadow-md"
          />
          <div className="text-center">
            <h1 className="text-xl font-semibold text-gray-900">Admin sign in</h1>
            <p className="text-sm text-gray-500 mt-1">Ferro Maps internal access only</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />

          <div className="relative">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-[30px] text-gray-400 hover:text-gray-600 focus:outline-none"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <Button type="submit" disabled={loading} className="w-full mt-2">
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
