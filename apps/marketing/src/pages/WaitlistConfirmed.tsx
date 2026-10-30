import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle } from 'lucide-react'
import { Card } from '@ferro-maps/ui'
import Header from '../Header'
import Footer from '../Footer'

export default function WaitlistConfirmed({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()

  useEffect(() => {
    const timer = setTimeout(() => {
      navigate('/')
    }, 4000)
    return () => clearTimeout(timer)
  }, [embedded, navigate])

  return (
    <div className={`min-h-screen bg-white font-sans${embedded ? ' v2-shift' : ''}`}>
      {embedded ? null : <Header />}

      <main className="flex flex-col items-center px-4 py-20">
        <div className="w-full max-w-md text-center mb-8 pt-10">
          <h1 className="text-3xl font-bold text-text-primary mb-2">You're all set</h1>
          <p className="text-text-secondary text-sm">
            We'll email you as soon as Ferro Maps launches in your area.
          </p>
        </div>

        <Card className="w-full max-w-md rounded-card">
          <div className="flex flex-col items-center text-center gap-3 bg-green-50 border border-green-200 rounded-md p-6">
            <CheckCircle className="w-8 h-8 text-green-600" />
            <p className="text-sm font-medium text-text-primary">You're on the list!</p>
          </div>
        </Card>
      </main>

      {embedded ? null : <Footer />}
    </div>
  )
}
