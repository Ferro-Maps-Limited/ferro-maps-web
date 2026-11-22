import path from "node:path";
import {pathToFileURL} from "node:url";
import {buildImport, summarise, type ImportPlan} from "./src/buildImport.ts";
import {readInput} from "./src/files.ts";
import {type RoadChargeZone} from "./src/types.ts";
import {assertEmulatorOnly, OSM_GATES_FLAG, writeToEmulator} from "./src/writer.ts";

export interface CliArgs {
  input: string;
  write: boolean;
  project: string;
  fetchedAt: string;
  includeOsmGates: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: "",
    write: false,
    project: "",
    fetchedAt: "",
    includeOsmGates: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      i += 1;
      return value;
    };
    if (token === "--input") args.input = next();
    else if (token === "--write") args.write = true;
    else if (token === "--project") args.project = next();
    else if (token === "--fetched-at") args.fetchedAt = next();
    else if (token === OSM_GATES_FLAG) args.includeOsmGates = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

export const HELP = `Import UK road-charge zone boundaries into road_charge_zones.

This command is off unless you pass --input. It reads local files only.
It does not download sources and it does not store prices or charge amounts.

A run without --write prints a summary and does not contact Firestore.
--write writes only when FIRESTORE_EMULATOR_HOST is set and --project
starts with demo-.

${OSM_GATES_FLAG} parses osm-gates.json. It is off unless you pass it.

  --input <dir>       Directory of local source files
  --fetched-at <iso>  UTC timestamp stored on every record
  --write             Write to Firestore after the emulator check
  --project <id>      Required with --write. Must start with demo-
  ${OSM_GATES_FLAG}
`;

export interface RunIO {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  read?: (dir: string, includeOsmGates: boolean) => Promise<Awaited<ReturnType<typeof readInput>>>;
  writeZones?: (projectId: string, zones: RoadChargeZone[], env: NodeJS.ProcessEnv) => Promise<void>;
  now?: () => string;
}

export async function run(argv: string[], io: RunIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  const env = io.env ?? process.env;
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr("Nothing was written.");
    return 2;
  }
  if (args.help) {
    stdout(HELP);
    return 0;
  }
  if (!args.input) {
    stdout("Road-charge zone import is off. Nothing was written.");
    return 0;
  }
  if (args.write && !args.project) {
    stderr("refusing to write: --write requires --project <id>. Nothing was written.");
    return 2;
  }
  if (!args.write && args.project) {
    stderr("--project is ignored without --write. Nothing was written.");
  }
  const fetchedAt = args.fetchedAt || (io.now ? io.now() : new Date().toISOString());
  try {
    const read = io.read ?? readInput;
    const files = await read(args.input, args.includeOsmGates);
    const plan: ImportPlan = buildImport(files, {fetchedAt, includeOsmGates: args.includeOsmGates});
    if (!args.write) {
      stdout(summarise(plan, false).trimEnd());
      return 0;
    }
    assertEmulatorOnly({
      emulatorHost: env.FIRESTORE_EMULATOR_HOST ?? "",
      projectId: args.project,
    });
    const writeZones = io.writeZones ?? writeToEmulator;
    await writeZones(args.project, plan.zones, env);
    stdout(summarise(plan, true).trimEnd());
    stdout(`wrote ${plan.zones.length} road_charge_zones documents`);
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr("Nothing was written.");
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
