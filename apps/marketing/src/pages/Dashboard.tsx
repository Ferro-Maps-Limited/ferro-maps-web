/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signOut, updateEmail } from 'firebase/auth'
import { User, History, Settings, LogOut, Menu } from 'lucide-react'
import { useAuth } from '../context/useAuth'
import { auth } from '../lib/firebase'
import ferroLogo from '../assets/ferro-logo-2.png'
import { doc, getDoc, updateDoc, onSnapshot, collection, query, orderBy, limit, getDocs } from 'firebase/firestore'
import { db } from '../lib/firebase'
import {
  AccountDeletionCancelled,
  markAccountDeleted,
  requestAccountDeletion,
} from '../lib/accountDeletion'
import { Lock } from 'lucide-react'
import skinClassic from '../assets/skins/ferro-bird-classic.png'
import skinNinja from '../assets/skins/ferro-bird-ninja.png'
import skinDetective from '../assets/skins/ferro-bird-detective.png'
import skinGamer from '../assets/skins/ferro-bird-gamer.png'
import skinSuperhero from '../assets/skins/ferro-bird-superhero.png'
import skinVillain from '../assets/skins/ferro-bird-villain.png'
import friendCrow from '../assets/friends/ferro-bird-crow.png'
import friendFalcon from '../assets/friends/ferro-bird-falcon.png'
import friendParrot from '../assets/friends/ferro-bird-parrot.png'
import friendMagpie from '../assets/friends/ferro-bird-magpie.png'
import friendRobin from '../assets/friends/ferro-bird-robin.png'
import friendHummingbird from '../assets/friends/ferro-bird-hummingbrd.png'
import { getLevelProgress } from '../lib/levelThresholds'

type Tab = 'profile' | 'history' | 'settings'

interface AvatarOption {
  id: string
  src: string
  label: string
  requiredLevel: number
}

const SKINS: AvatarOption[] = [
  { id: 'skin-default', src: skinClassic, label: 'Classic', requiredLevel: 1 },
  { id: 'skin-ninja', src: skinNinja, label: 'Ninja', requiredLevel: 4 },
  { id: 'skin-detective', src: skinDetective, label: 'Detective', requiredLevel: 9 },
  { id: 'skin-gamer', src: skinGamer, label: 'Gamer', requiredLevel: 12 },
  { id: 'skin-superhero', src: skinSuperhero, label: 'Superhero', requiredLevel: 14 },
  { id: 'skin-villain', src: skinVillain, label: 'Villain', requiredLevel: 17 },
]

const FRIENDS: AvatarOption[] = [
  { id: 'friend-crow', src: friendCrow, label: 'Crow', requiredLevel: 5 },
  { id: 'friend-falcon', src: friendFalcon, label: 'Falcon', requiredLevel: 8 },
  { id: 'friend-parrot', src: friendParrot, label: 'Parrot', requiredLevel: 11 },
  { id: 'friend-magpie', src: friendMagpie, label: 'Magpie', requiredLevel: 15 },
  { id: 'friend-robin', src: friendRobin, label: 'Robin', requiredLevel: 18 },
  { id: 'friend-hummingbird', src: friendHummingbird, label: 'Hummingbird', requiredLevel: 20 },
]

const ALL_AVATARS = [...SKINS, ...FRIENDS]

function ProfileSection() {
  const [userData, setUserData] = useState<{ name: string, ferroBalance: number, country: string, selectedAvatar: string, xp: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [pickerTab, setPickerTab] = useState<'skins' | 'friends'>('skins')
  const [saving, setSaving] = useState(false)

  const { user } = useAuth()

  useEffect(() => {
    if (!user) {
      return
    }
    const unsubscribe = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data()
          setUserData({
            name: data.name || '',
            ferroBalance: data.ferroBalance || 0,
            country: data.country || 'GB',
            selectedAvatar: data.selectedAvatar || '',
            xp: typeof data.xp === 'number' ? data.xp : 0,
          })
          setEditName((prev) => (editMode ? prev : data.name || ''))
        }
        setLoading(false)
      },
      () => {
        setError('Failed to load profile.')
        setLoading(false)
      },
    )
    return () => unsubscribe()
  }, [user, editMode])

  if (!user) return <p className="text-neutral-500 text-center p-8">Please sign in to view your profile.</p>
  if (loading) return <div className="flex justify-center mt-12"><div className="animate-spin border-4 border-ferro-primary border-t-transparent rounded-full w-8 h-8" /></div>
  if (error) return <p className="text-red-500 text-center p-8">{error}</p>
  if (!userData) return null

  const progress = getLevelProgress(userData.xp)

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="bg-ferro-primary p-8 flex flex-col items-center">
        <div className="w-24 h-24 rounded-full border-4 border-white overflow-hidden">
          {userData.selectedAvatar ? (
            <img src={ALL_AVATARS.find(a => a.id === userData.selectedAvatar)?.src} alt="avatar" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-ferro-deep flex items-center justify-center text-white text-3xl font-bold">
              {userData.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <h2 className="text-white text-2xl font-bold mt-4">{userData.name}</h2>
        <p className="text-white opacity-80 text-sm mt-1">{user.phoneNumber}</p>
        <button onClick={() => setShowAvatarPicker(p => !p)} className="text-white text-sm underline opacity-80 mt-2 cursor-pointer">
          {showAvatarPicker ? 'Close avatar picker' : 'Change Avatar'}
        </button>
      </div>

      {showAvatarPicker && (
        <div className="bg-white p-6 border-b border-gray-100">
          <p className="text-ferro-ink font-semibold mb-1">Avatar Locker</p>
          <p className="text-neutral-500 text-xs mb-4">Dress up Ferro. Unlock more looks along your journey.</p>

          <div className="flex bg-gray-100 rounded-xl p-1 mb-4">
            <button
              onClick={() => setPickerTab('skins')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                pickerTab === 'skins' ? 'bg-white text-ferro-ink shadow-sm' : 'text-neutral-500'
              }`}
            >
              Skins
            </button>
            <button
              onClick={() => setPickerTab('friends')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                pickerTab === 'friends' ? 'bg-white text-ferro-ink shadow-sm' : 'text-neutral-500'
              }`}
            >
              Friends
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {(pickerTab === 'skins' ? SKINS : FRIENDS).map(avatar => {
              const isLocked = progress.current.level < avatar.requiredLevel
              const isSelected = userData.selectedAvatar === avatar.id
              return (
                <button
                  key={avatar.id}
                  disabled={isLocked}
                  onClick={async () => {
                    if (!user || isLocked) return
                    await updateDoc(doc(db, 'users', user.uid), { selectedAvatar: avatar.id })
                    setUserData(prev => prev ? { ...prev, selectedAvatar: avatar.id } : prev)
                  }}
                  className={`relative flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-colors ${
                    isSelected ? 'border-ferro-primary bg-ferro-tint' : 'border-transparent'
                  } ${isLocked ? 'cursor-not-allowed' : 'hover:bg-gray-50'}`}
                  title={isLocked ? `Unlocks at Level ${avatar.requiredLevel}` : avatar.label}
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-xl">
                    <img
                      src={avatar.src}
                      alt={avatar.label}
                      className={`w-full h-full object-cover ${isLocked ? 'grayscale opacity-50' : ''}`}
                    />
                    {isLocked && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                        <div className="bg-white/90 rounded-full p-1.5">
                          <Lock size={14} className="text-neutral-600" />
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="text-xs font-medium text-neutral-700">{avatar.label}</span>
                  {isLocked && (
                    <span className="text-[10px] font-semibold text-neutral-400">Lvl. {avatar.requiredLevel}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="p-8">
        <div className="bg-gradient-to-r from-ferro-primary to-ferro-deep rounded-xl p-5 mb-6 text-white">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-90">Level {progress.current.level} · {progress.current.name}</p>
            <p className="text-lg font-bold">{userData.xp.toLocaleString()} XP</p>
          </div>
          {progress.next ? (
            <>
              <div className="h-2 rounded-full bg-white/25 overflow-hidden mt-2">
                <div className="h-full bg-white rounded-full" style={{ width: `${progress.progressPercent}%` }} />
              </div>
              <p className="text-xs opacity-90 mt-1.5">
                {progress.xpIntoLevel}/{progress.xpForNextLevel} XP to Level {progress.next.level} · {progress.next.name}
              </p>
            </>
          ) : (
            <p className="text-xs opacity-90 mt-1.5">Max level reached!</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-ferro-tint rounded-xl p-4">
            <p className="text-ferro-primary text-xs font-semibold uppercase tracking-wide">Ferro Balance</p>
            <p className="text-ferro-ink text-2xl font-bold mt-1">{userData.ferroBalance}</p>
            <p className="text-neutral-500 text-xs">points earned</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-neutral-500 text-xs font-semibold uppercase tracking-wide">Region</p>
            <p className="text-ferro-ink text-2xl font-bold mt-1">{userData.country}</p>
            <p className="text-neutral-500 text-xs">your market</p>
          </div>
        </div>

        {!editMode ? (
          <button onClick={() => setEditMode(true)} className="border border-ferro-primary text-ferro-primary rounded-lg px-6 py-2 font-semibold text-sm hover:bg-ferro-tint">
            Edit Display Name
          </button>
        ) : (
          <div>
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="border border-gray-200 rounded-lg px-4 py-2 w-full mb-3 focus:outline-none focus:border-ferro-primary"
            />
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  if (!user) return
                  setSaving(true)
                  await updateDoc(doc(db, 'users', user.uid), { name: editName })
                  setUserData(prev => prev ? { ...prev, name: editName } : prev)
                  setEditMode(false)
                  setSaving(false)
                }}
                className="bg-ferro-primary text-white rounded-lg px-6 py-2 font-semibold text-sm"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={() => setEditMode(false)} className="border border-gray-200 text-neutral-600 rounded-lg px-6 py-2 text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function HistorySection() {
  const { user } = useAuth()
  const [history, setHistory] = useState<{ id: string, hotspot: string, tier: string, points: number, timestamp: any }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchHistory() {
      if (!user) {
        setLoading(false)
        return
      }
      try {
        const q = query(
          collection(db, 'users', user.uid, 'ferroEarnings'),
          orderBy('timestamp', 'desc'),
          limit(20)
        )
        const snap = await getDocs(q)
        setHistory(snap.docs.map(d => ({ id: d.id, ...d.data() } as { id: string, hotspot: string, tier: string, points: number, timestamp: any })))
      } catch {
        setError('Failed to load history.')
      } finally {
        setLoading(false)
      }
    }
    fetchHistory()
  }, [user])

  if (!user) return <p className="text-neutral-500 text-center p-8">Please sign in to view your history.</p>
  if (loading) return <div className="flex justify-center mt-12"><div className="animate-spin border-4 border-ferro-primary border-t-transparent rounded-full w-8 h-8" /></div>
  if (error) return <p className="text-red-500 text-center p-8">{error}</p>
  if (history.length === 0) return (
    <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
      <p className="text-neutral-500">No earnings history yet. Start driving to earn Ferro points!</p>
    </div>
  )

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-gray-100">
        <h2 className="text-xl font-bold text-ferro-ink">Earnings History</h2>
      </div>
      {history.map(item => {
        const tierClass =
          item.tier === 'flawless' ? 'bg-ferro-signal text-ferro-ink' :
          item.tier === 'great' ? 'bg-ferro-primary text-white' :
          'bg-ferro-tint text-ferro-primary'
        return (
          <div key={item.id} className="flex items-center justify-between p-4 border-b border-gray-50 last:border-b-0">
            <div>
              <p className="font-semibold text-ferro-ink text-sm">{item.hotspot}</p>
              <p className="text-neutral-500 text-xs mt-1">
                {new Date(item.timestamp.toDate()).toLocaleDateString('en-GB')}
              </p>
            </div>
            <div className="flex flex-col items-end">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${tierClass}`}>{item.tier}</span>
              <p className="text-ferro-primary font-bold text-sm mt-1 text-right">+{item.points} Ferro</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SettingsSection() {
  const { user } = useAuth()
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletePhase, setDeletePhase] = useState<'confirm' | 'pending' | 'success' | 'error'>('confirm')
  const [deleteError, setDeleteError] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const navigate = useNavigate()
  const deletionRef = useRef<{ cancel: () => void } | null>(null)
  const signOutTimer = useRef<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (signOutTimer.current !== null) window.clearTimeout(signOutTimer.current)
    }
  }, [])

  useEffect(() => {
    async function fetchNotificationPref() {
      if (!user) return
      const snap = await getDoc(doc(db, 'users', user.uid))
      if (snap.exists()) {
        const data = snap.data()
        setNotificationsEnabled(data.notificationsEnabled !== undefined ? data.notificationsEnabled : true)
      }
    }
    fetchNotificationPref()
  }, [user])

  async function handleUpdateEmail() {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      if (!auth.currentUser || !user) return
      await updateEmail(auth.currentUser, email)
      await updateDoc(doc(db, 'users', user.uid), { email })
      setSuccess('Email updated successfully.')
      setEmail('')
    } catch {
      setError('An error occurred. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  function openDeleteConfirm() {
    setDeletePhase('confirm')
    setDeleteError('')
    setShowDeleteConfirm(true)
  }

  function closeDeleteConfirm() {
    if (deletePhase === 'pending' || deletePhase === 'success') return
    deletionRef.current?.cancel()
    deletionRef.current = null
    setShowDeleteConfirm(false)
    setDeletePhase('confirm')
    setDeleteError('')
  }

  // Creates accountDeletionRequests/{uid} and waits for onAccountDeletionRequest.
  // The client must not call deleteUser(): that removes the login and leaves
  // the Firestore profile behind, which locks the driver out of mobile.
  async function handleDeleteAccount() {
    const current = auth.currentUser
    if (!current || deletePhase === 'pending' || deletePhase === 'success') return

    setDeletePhase('pending')
    setDeleteError('')
    deletionRef.current?.cancel()

    const request = requestAccountDeletion(current.uid)
    deletionRef.current = request

    try {
      await request.promise
      if (!mounted.current) return
      deletionRef.current = null
      markAccountDeleted()
      setDeletePhase('success')
      signOutTimer.current = window.setTimeout(() => {
        void signOut(auth).catch(() => {
          // The handler may already have deleted the Auth user.
        })
        navigate('/', { replace: true })
      }, 1200)
    } catch (err) {
      if (err instanceof AccountDeletionCancelled || !mounted.current) return
      deletionRef.current = null
      setDeletePhase('error')
      setDeleteError(err instanceof Error ? err.message : 'An error occurred. Please try again.')
    }
  }

  if (!user) return <p className="text-neutral-500 text-center p-8">Please sign in to view settings.</p>

  return (
    <div className="bg-white rounded-2xl shadow-sm p-8">
      <h2 className="text-xl font-bold text-ferro-ink mb-6">Settings</h2>

      <div>
        <p className="font-semibold text-ferro-ink mb-3">Notification Preferences</p>
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl mb-6">
          <div>
            <p className="text-sm font-medium text-ferro-ink">Flawless hotspot alerts</p>
            <p className="text-neutral-500 text-xs mt-1">Get notified when high-demand opportunities are near you</p>
          </div>
          <button
            onClick={async () => {
              const newVal = !notificationsEnabled
              setNotificationsEnabled(newVal)
              if (user) await updateDoc(doc(db, 'users', user.uid), { notificationsEnabled: newVal })
            }}
            className={`w-12 h-6 rounded-full transition-colors flex items-center px-1 ${notificationsEnabled ? 'bg-ferro-primary' : 'bg-gray-300'}`}
          >
            <span className={`w-4 h-4 bg-white rounded-full transition-transform ${notificationsEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      <hr className="my-6 border-gray-100" />

      <div>
        <p className="font-semibold text-ferro-ink mb-3">Update Email</p>
        <p className="text-neutral-500 text-sm mb-3">Current: {user.email || 'No email set'}</p>
        <input
          type="email"
          placeholder="Enter new email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="border border-gray-200 rounded-lg px-4 py-2 w-full mb-3 focus:outline-none focus:border-ferro-primary text-sm"
        />
        <button
          onClick={handleUpdateEmail}
          className="bg-ferro-primary text-white rounded-lg px-6 py-2 font-semibold text-sm"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {success && <p className="text-green-600 text-sm mt-2">{success}</p>}
        {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
      </div>

      <hr className="my-6 border-gray-100" />

      <div>
        <p className="font-semibold text-ferro-ink mb-2">Delete Account</p>
        <p className="text-neutral-500 text-sm mb-4">Permanently delete your account and all associated data. This cannot be undone.</p>
        <button
          onClick={openDeleteConfirm}
          className="border border-red-300 text-red-500 rounded-lg px-6 py-2 font-semibold text-sm hover:bg-red-50"
        >
          Delete Account
        </button>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 max-w-sm mx-4 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
            {deletePhase === 'pending' && (
              <>
                <div className="flex justify-center mb-4">
                  <div className="animate-spin border-4 border-ferro-primary border-t-transparent rounded-full w-8 h-8" />
                </div>
                <h3 id="delete-account-title" className="text-xl font-bold text-ferro-ink mb-2 text-center">Deleting your account</h3>
                <p className="text-neutral-500 text-sm text-center">
                  We&apos;re removing your Ferro account and the data stored with it. This usually finishes within a minute. Keep this page open.
                </p>
              </>
            )}

            {deletePhase === 'success' && (
              <>
                <h3 id="delete-account-title" className="text-xl font-bold text-ferro-ink mb-2">Account deleted</h3>
                <p className="text-neutral-500 text-sm">Your account has been removed. Signing you out…</p>
              </>
            )}

            {deletePhase === 'error' && (
              <>
                <h3 id="delete-account-title" className="text-xl font-bold text-ferro-ink mb-2">Couldn&apos;t delete your account</h3>
                <p className="text-red-500 text-sm mb-6">{deleteError}</p>
                <div className="flex gap-3">
                  <button
                    onClick={closeDeleteConfirm}
                    className="border border-gray-200 text-neutral-600 rounded-lg px-6 py-2 text-sm"
                  >
                    Close
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    className="bg-red-500 text-white rounded-lg px-6 py-2 font-semibold text-sm"
                  >
                    Try again
                  </button>
                </div>
              </>
            )}

            {deletePhase === 'confirm' && (
              <>
                <h3 id="delete-account-title" className="text-xl font-bold text-ferro-ink mb-2">Are you sure?</h3>
                <p className="text-neutral-500 text-sm mb-6">This will permanently delete your account and all your data. This cannot be undone.</p>
                <div className="flex gap-3">
                  <button
                    onClick={closeDeleteConfirm}
                    className="border border-gray-200 text-neutral-600 rounded-lg px-6 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    className="bg-red-500 text-white rounded-lg px-6 py-2 font-semibold text-sm"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('profile')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const navigate = useNavigate()
  useAuth()

  async function handleSignOut() {
    await signOut(auth)
    navigate('/')
  }

  const navItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'profile', label: 'Profile', icon: <User size={18} /> },
    { id: 'history', label: 'History', icon: <History size={18} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={18} /> },
  ]

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <div className="hidden md:flex flex-col w-64 bg-white border-r border-gray-200 min-h-screen">
        <div className="px-6 py-5 flex items-center gap-3 border-b border-gray-100">
          <Link to="/" className="flex items-center gap-3">
            <img src={ferroLogo} alt="Ferro Maps" className="w-8 h-8 rounded-lg" />
            <span className="font-bold text-ferro-primary">Ferro Maps</span>
          </Link>
        </div>

        <nav className="flex flex-col gap-1 p-4">
          {navItems.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={
                tab === id
                  ? 'flex items-center gap-3 px-4 py-3 rounded-xl bg-ferro-tint text-ferro-primary font-semibold w-full text-left text-sm'
                  : 'flex items-center gap-3 px-4 py-3 rounded-xl text-neutral-600 hover:bg-gray-50 w-full text-left text-sm'
              }
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-auto p-4 border-t border-gray-100">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-neutral-600 hover:bg-gray-50 w-full text-left text-sm"
          >
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="md:hidden flex items-center justify-between px-4 py-4 bg-white border-b border-gray-200">
          <Link to="/" className="flex items-center gap-3">
            <img src={ferroLogo} alt="Ferro Maps" className="w-7 h-7 rounded-lg" />
            <span className="font-bold text-ferro-primary">Ferro Maps</span>
          </Link>
          <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            <Menu size={22} className="text-neutral-600" />
          </button>
        </div>

        <div className="flex-1 p-6 md:p-8 overflow-y-auto pb-20 md:pb-8">
          {tab === 'profile' && <ProfileSection />}
          {tab === 'history' && <HistorySection />}
          {tab === 'settings' && <SettingsSection />}
        </div>
      </div>

      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex">
        {navItems.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={
              tab === id
                ? 'flex-1 flex flex-col items-center py-3 text-ferro-primary'
                : 'flex-1 flex flex-col items-center py-3 text-neutral-400'
            }
          >
            {id === 'profile' ? <User size={20} /> : id === 'history' ? <History size={20} /> : <Settings size={20} />}
            <span className="text-xs mt-1">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
