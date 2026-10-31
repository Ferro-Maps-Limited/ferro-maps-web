/**
 * Shared argv check for scripts that must not write.
 * Only --project is accepted. There is no default project.
 */

const WRITE_FLAG = /^--(?:write|apply|set|update|delete|commit|create|merge|import|seed)(?:=|$)/;

function parseReadOnlyProject(argv) {
  for (const token of argv) {
    const flag = token.split("=")[0];
    if (WRITE_FLAG.test(flag) || flag === "-w") {
      return {error: `Refusing to run: ${token} is a write flag. This script only reads.`};
    }
  }
  let project = "";
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--project") {
      project = argv[i + 1] || "";
      i += 1;
      if (!project || project.startsWith("--")) {
        return {error: "Refusing to run: --project needs a project id."};
      }
    } else if (token.startsWith("--project=")) {
      project = token.slice("--project=".length);
    } else if (token.startsWith("-")) {
      return {error: `Refusing to run: unknown flag ${token}. This script only reads and accepts only --project.`};
    } else {
      return {error: `Refusing to run: unexpected argument ${token}.`};
    }
  }
  if (!project) {
    return {error: "Refusing to run without --project. There is no default."};
  }
  return {project};
}

module.exports = {parseReadOnlyProject};
