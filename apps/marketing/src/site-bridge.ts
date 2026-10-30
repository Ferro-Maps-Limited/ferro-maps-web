import { addDoc, collection, doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from './lib/firebase'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function encodeEmailToDocId(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

function formText(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const CONSENT_MESSAGE = 'Please tick the box to agree before you continue.'

function consentBox(form: HTMLFormElement): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>('input[name="consent"]')
}

// The tickbox is required: nothing is written until it is ticked, and the
// stored consent flags come from the box itself.
function hasConsent(form: HTMLFormElement): boolean {
  const box = consentBox(form)
  if (box?.checked) return true
  showStatus(form, CONSENT_MESSAGE, false)
  box?.focus()
  return false
}

function clearError(status: HTMLElement) {
  delete status.dataset.siteStatus
  status.classList.remove('consent-error')
}

function showStatus(form: HTMLFormElement, message: string, ok: boolean) {
  let status = form.querySelector<HTMLElement>('[data-site-status]')
  if (!status) {
    status = form.querySelector<HTMLElement>('.ok')
  }
  if (!status) {
    status = document.createElement('p')
    status.className = 'ok'
    form.append(status)
  }
  status.hidden = false
  status.style.display = 'block'
  status.textContent = message
  status.setAttribute('role', 'status')
  if (ok) {
    clearError(status)
  } else {
    status.dataset.siteStatus = 'error'
    status.classList.add('consent-error')
  }
}

async function joinWaitlist(email: string, consentGiven: boolean): Promise<'ok' | 'duplicate'> {
  const docId = encodeEmailToDocId(email)
  try {
    await setDoc(doc(db, 'waitlist', docId), {
      email,
      country: 'United Kingdom',
      signedUpAt: serverTimestamp(),
      consentGiven,
    })
    return 'ok'
  } catch (unknownError: unknown) {
    const firebaseError = unknownError as { code?: string }
    if (firebaseError.code === 'permission-denied') return 'duplicate'
    throw unknownError
  }
}

function detach(form: HTMLFormElement): HTMLFormElement {
  const clone = form.cloneNode(true) as HTMLFormElement
  form.replaceWith(clone)
  return clone
}

function wireGold(form: HTMLFormElement) {
  form = detach(form)
  form.removeAttribute('onsubmit')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const email = (form.querySelector<HTMLInputElement>('input[type="email"]')?.value ?? '').trim()
    if (!EMAIL_PATTERN.test(email)) {
      showStatus(form, 'Please enter a valid email address.', false)
      return
    }
    if (!hasConsent(form)) return
    const button = form.querySelector<HTMLButtonElement>('button')
    if (button) button.disabled = true
    void joinWaitlist(email, consentBox(form)?.checked === true)
      .then((result) => {
        if (result === 'duplicate') {
          showStatus(form, "You're already on the list.", false)
          if (button) button.disabled = false
          return
        }
        const ok = form.querySelector<HTMLElement>('.ok')
        if (ok) {
          clearError(ok)
          ok.removeAttribute('style')
          ok.textContent = "You're on the list ✨"
        }
        form.classList.add('done')
      })
      .catch(() => {
        showStatus(form, 'Something went wrong. Please try again.', false)
        if (button) button.disabled = false
      })
  })
}

function wireJobs(form: HTMLFormElement) {
  form = detach(form)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!hasConsent(form)) return
    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }
    const email = formText(form, 'email')
    if (!EMAIL_PATTERN.test(email)) {
      showStatus(form, 'Please enter a valid email address.', false)
      return
    }
    const button = form.querySelector<HTMLButtonElement>('button')
    if (button) button.disabled = true
    void joinWaitlist(email, consentBox(form)?.checked === true)
      .then((result) => {
        const ok = form.querySelector<HTMLElement>('.ok')
        if (result === 'duplicate') {
          showStatus(form, "You're already on the list.", false)
          if (button) button.disabled = false
          return
        }
        if (ok) {
          clearError(ok)
          ok.hidden = false
          ok.textContent = "Thanks — you're on the list ✨"
        }
      })
      .catch(() => {
        showStatus(form, 'Something went wrong. Please try again.', false)
        if (button) button.disabled = false
      })
  })
}

function wireContact(form: HTMLFormElement) {
  form = detach(form)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!hasConsent(form)) return
    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }
    const name = formText(form, 'name')
    const email = formText(form, 'email')
    const message = formText(form, 'message')
    // Same limits as the supportRequests create rule.
    if (name.length > 200 || email.length > 320 || message.length > 5000) {
      showStatus(form, 'Please shorten your message and try again.', false)
      return
    }
    const button = form.querySelector<HTMLButtonElement>('button')
    if (button) button.disabled = true
    void addDoc(collection(db, 'supportRequests'), {
      name,
      email,
      message,
      agreedToPolicy: consentBox(form)?.checked === true,
      submittedAt: serverTimestamp(),
      status: 'open',
      ticketNumber: Date.now(),
      subject: message.slice(0, 60),
      replies: [],
    })
      .then(() => {
        showStatus(form, "Message sent. We'll be in touch soon.", true)
        form.reset()
        if (button) button.disabled = false
      })
      .catch(() => {
        showStatus(form, 'Something went wrong. Please try again.', false)
        if (button) button.disabled = false
      })
  })
}

// After account deletion the dashboard sends people home, which is now a static
// page. Show the same confirmation the app shows (see AccountDeletedNotice),
// read from the same sessionStorage flag.
const ACCOUNT_DELETED_KEY = 'ferro.accountDeleted'

function showAccountDeletedNotice() {
  if (sessionStorage.getItem(ACCOUNT_DELETED_KEY) !== '1') return
  const bar = document.createElement('div')
  bar.setAttribute('role', 'status')
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:1000;padding:12px 16px;text-align:center;' +
    'font:600 14px/1.4 inherit;background:#fff4cc;color:#14110f;border-bottom:2px solid #14110f'
  bar.textContent = 'Your account has been deleted and you have been signed out.'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Dismiss'
  dismiss.style.cssText = 'margin-left:12px;font:inherit;text-decoration:underline;background:none;border:0;color:inherit;cursor:pointer'
  dismiss.addEventListener('click', () => {
    sessionStorage.removeItem(ACCOUNT_DELETED_KEY)
    bar.remove()
  })
  bar.append(dismiss)
  document.body.append(bar)
}

try {
  showAccountDeletedNotice()
} catch {
  // sessionStorage can be unavailable (privacy modes); the notice is optional.
}

const gold = document.querySelector<HTMLFormElement>('form.wait')
if (gold) wireGold(gold)

const jobs = document.querySelector<HTMLFormElement>('#jobs-form')
if (jobs) wireJobs(jobs)

const contact = document.querySelector<HTMLFormElement>('#contact-form')
if (contact) wireContact(contact)
