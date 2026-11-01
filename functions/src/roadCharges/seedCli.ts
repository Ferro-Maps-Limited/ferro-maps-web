import {exampleSeedPayload} from "./exampleConfig.js";

export interface SeedCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Prints the example roadCharges documents. There is no write path.
// --write exits 2 and prints nothing to stdout.
export function runSeedCli(argv: string[]): SeedCliResult {
  if (argv.includes("--write") || argv.includes("--apply")) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "Dry run only. This script never writes to Firestore.\n",
    };
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      exitCode: 0,
      stdout: "Usage: npm run seed:road-charges\nPrints example roadCharges/cc and roadCharges/ulez. --write is refused.\n",
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(exampleSeedPayload(), null, 2)}\n`,
    stderr: "",
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/seedCli.ts") || entry.endsWith("/seedCli.js") ||
    entry.endsWith("\\seedCli.ts") || entry.endsWith("\\seedCli.js");
}

if (isDirectRun()) {
  const result = runSeedCli(process.argv.slice(2));
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
