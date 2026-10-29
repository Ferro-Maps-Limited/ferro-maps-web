import { Route, Routes } from 'react-router-dom'
import '@fontsource/nunito/900.css'
import './v2.css'
import V2Layout from './V2Layout'
import HomePage from './pages/HomePage'
import HowItWorksPage from './pages/HowItWorksPage'
import JobsPage from './pages/JobsPage'
import MissionPage from './pages/MissionPage'
import SocialsPage from './pages/SocialsPage'
import StoriesPage from './pages/StoriesPage'
import ContactPage from './pages/ContactPage'
import NotFoundPage from './pages/NotFoundPage'

export default function V2Routes() {
  return (
    <Routes>
      <Route element={<V2Layout />}>
        <Route index element={<HomePage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="mission" element={<MissionPage />} />
        <Route path="socials" element={<SocialsPage />} />
        <Route path="stories" element={<StoriesPage />} />
        <Route path="contact" element={<ContactPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
