// Real product facts carried over from the current marketing site and legal pages.

export const COMPANY = 'Ferro Maps Ltd'
export const COMPANY_NUMBER = '17197682'
export const REGISTERED_OFFICE = 'Icon Tower, North Acton, London W3 6FD'
export const SUPPORT_EMAIL = 'support@ferromaps.com'
export const LINKEDIN = 'https://www.linkedin.com/company/ferromaps'

export const homeTitle = 'Ferro Maps — Navigation for Income'
export const homeDescription =
  'Ferro Maps tells gig economy drivers in London where demand is highest before they drive there. Live hotspots, Good, Great and Flawless tiers, and XP rewards.'

export const whereToEarn =
  'Real-time hotspot map showing demand zones near you. Know where to go before you start driving.'
export const whenToEarn =
  'Live demand windows with countdown timers. Know how long each opportunity lasts before it expires.'
export const earnRewards = 'Collect XP points every time you act on a hotspot.'

export const steps = [
  {
    title: 'Create your account.',
    body: 'Download Ferro Maps and create your account with your phone number. The sign-in page texts you a 6-digit code.',
  },
  {
    title: 'See live demand.',
    body: 'Open the map at the start of your shift. Hotspots near you are colour-coded Good, Great and Flawless.',
  },
  {
    title: 'Act on it.',
    body: 'Drive to an opportunity and collect Ferro points. The app tells you how long the window lasts. It does not guarantee earnings.',
  },
] as const

// COPY-REVIEW: the live FAQ says "7 categories". The count is left out here because it is already out of date, and the named categories below are the ones the current site publishes.
export const categoriesAnswer =
  'Ferro Maps hotspots fall into categories, each with its own icon on the map. Venue covers high-footfall locations like hotels, museums, tourist attractions, stadiums, and nightclubs (nightclubs only show Thursday to Saturday). Event covers anything happening at a specific time, from concerts and plays to quiz nights. Flights reflects scheduled arrivals and departures at airports. Transport Disruption flags train or tube delays that push more people onto the road. Flight Disruption flags delayed or cancelled flights creating sudden demand at the airport. Hotspot Egg is a limited-time bonus opportunity added by drivers themselves. Parking highlights free parking nearby, also added by drivers.'

export const faqs = [
  {
    q: 'What is Ferro Maps?',
    a: 'Ferro Maps is a navigation for income app for gig economy drivers. It tells you where demand is highest in real time so you can position yourself smarter and earn more, before you drive there.',
  },
  {
    q: 'Which cities is Ferro Maps available in?',
    a: 'Ferro Maps is currently live in London. We are building towards expansion across the UK and internationally in later phases. If you are outside London, you can join our waitlist to be notified when we launch in your area.',
  },
  {
    q: 'What do the hotspot categories mean?',
    a: categoriesAnswer,
  },
  {
    q: 'Does Ferro Maps replace my Uber or Bolt app?',
    a: 'No. Ferro Maps works alongside your existing driver apps. You continue to accept jobs through Uber, Bolt, or whichever platform you use. Ferro Maps is the intelligence layer you open between trips to decide where to position yourself next.',
  },
  {
    q: 'How do I earn XP points?',
    a: 'You earn XP by completing gigs and engaging with hotspots. The more you use Ferro Maps to find and act on opportunities, the faster your XP builds. As your XP increases, you level up and unlock new rewards, including exclusive avatar skins and new ferro bird friends to add to your profile. Your current level and progress towards the next one are always visible from your profile screen.',
  },
] as const
