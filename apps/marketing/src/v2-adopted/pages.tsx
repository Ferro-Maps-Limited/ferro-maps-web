import PrivacyPolicy from '../pages/PrivacyPolicy'
import TermsConditions from '../pages/TermsConditions'
import SignIn from '../pages/SignIn'
import Dashboard from '../pages/Dashboard'
import TicketView from '../pages/TicketView'
import Waitlist from '../pages/Waitlist'
import WaitlistConfirmed from '../pages/WaitlistConfirmed'
import ProtectedRoute from '../components/ProtectedRoute'
import V2Chrome from './V2Chrome'

export function V2Privacy() {
  return (
    <V2Chrome title="Privacy Policy — Ferro Maps">
      <PrivacyPolicy embedded />
    </V2Chrome>
  )
}

export function V2Terms() {
  return (
    <V2Chrome title="Terms and Conditions — Ferro Maps">
      <TermsConditions embedded />
    </V2Chrome>
  )
}

export function V2Waitlist() {
  return (
    <V2Chrome title="Join the waitlist — Ferro Maps">
      <Waitlist embedded />
    </V2Chrome>
  )
}

export function V2WaitlistConfirmed() {
  return (
    <V2Chrome title="You're on the list — Ferro Maps">
      <WaitlistConfirmed embedded />
    </V2Chrome>
  )
}

export function V2SignIn() {
  return (
    <V2Chrome title="Sign in — Ferro Maps">
      <SignIn embedded />
    </V2Chrome>
  )
}

export function V2Dashboard() {
  return (
    <V2Chrome title="Dashboard — Ferro Maps">
      <ProtectedRoute>
        <Dashboard embedded />
      </ProtectedRoute>
    </V2Chrome>
  )
}

export function V2Ticket() {
  return (
    <V2Chrome title="Support ticket — Ferro Maps">
      <TicketView embedded />
    </V2Chrome>
  )
}
