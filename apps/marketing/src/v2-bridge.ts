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

function showStatus(form: HTMLFormElement, message: string, ok: boolean) {
  let status = form.querySelector<HTMLElement>('[data-v2-status]')
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
  if (!ok) status.dataset.v2Status = 'error'
}

async function joinWaitlist(email: string): Promise<'ok' | 'duplicate'> {
  const docId = encodeEmailToDocId(email)
  try {
    await setDoc(doc(db, 'waitlist', docId), {
      email,
      country: 'United Kingdom',
      signedUpAt: serverTimestamp(),
      consentGiven: true,
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
    const button = form.querySelector<HTMLButtonElement>('button')
    if (button) button.disabled = true
    void joinWaitlist(email)
      .then((result) => {
        if (result === 'duplicate') {
          showStatus(form, "You're already on the list.", false)
          if (button) button.disabled = false
          return
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
    void joinWaitlist(email)
      .then((result) => {
        const ok = form.querySelector<HTMLElement>('.ok')
        if (result === 'duplicate') {
          showStatus(form, "You're already on the list.", false)
          if (button) button.disabled = false
          return
        }
        if (ok) {
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
    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }
    const name = formText(form, 'name')
    const email = formText(form, 'email')
    const message = formText(form, 'message')
    const button = form.querySelector<HTMLButtonElement>('button')
    if (button) button.disabled = true
    void addDoc(collection(db, 'supportRequests'), {
      name,
      email,
      message,
      agreedToPolicy: false,
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

const gold = document.querySelector<HTMLFormElement>('form.wait')
if (gold) wireGold(gold)

const jobs = document.querySelector<HTMLFormElement>('#jobs-form')
if (jobs) wireJobs(jobs)

const contact = document.querySelector<HTMLFormElement>('#contact-form')
if (contact) wireContact(contact)
