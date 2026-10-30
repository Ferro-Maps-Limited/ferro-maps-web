/**
 * Deploy only the web functions codebase `default`.
 *
 *   npm run deploy -- <firebase-alias>
 *   npm run deploy -- -P <firebase-alias>
 *
 * An alias is required. This script does not fall back to the default project
 * in .firebaserc, and it never deploys Firestore rules. See DEPLOY.md.
 */
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
let alias = ''

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '-P' || arg === '--project') {
    alias = args[i + 1] ?? ''
    break
  }
  if (arg.startsWith('--project=')) {
    alias = arg.slice('--project='.length)
    break
  }
  if (!arg.startsWith('-')) {
    alias = arg
    break
  }
}

if (!alias || alias.startsWith('-')) {
  console.error('Refusing to deploy without a Firebase project alias.')
  console.error('Usage: npm run deploy -- <alias>')
  console.error('   or: npm run deploy -- -P <alias>')
  console.error('Runs: firebase deploy --only functions:default -P <alias>')
  console.error('Firestore rules are not deployed from this repo. See functions/DEPLOY.md.')
  process.exit(1)
}

const child = spawn(
  'firebase',
  ['deploy', '--only', 'functions:default', '-P', alias],
  { stdio: 'inherit' },
)

child.on('error', (err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`firebase deploy exited from ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
