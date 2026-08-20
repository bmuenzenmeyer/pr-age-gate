/**
 * Minimal replacement for @actions/core's input/logging helpers. Zero
 * dependencies is the point here — see README for why. GitHub Actions sets
 * one INPUT_<NAME> env var per declared input regardless of whether the
 * action is native or composite, JS or TypeScript; this mirrors
 * @actions/core.getInput's exact naming convention (uppercased, spaces —
 * not hyphens — become underscores) so action.yml's `inputs:` block needs
 * no special wiring.
 */
export function getInput(name: string): string {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return process.env[key]?.trim() ?? "";
}

export function info(message: string): void {
  console.log(message);
}

/**
 * Annotates the run without failing it — same workflow-command syntax as
 * setFailed. Used for conditions that are expected rather than wrong, so
 * `warning` would be its own kind of noise on every affected PR.
 */
export function notice(message: string): void {
  console.log(`::notice::${message}`);
}

/** Workflow command syntax GitHub Actions parses out of stderr/stdout to annotate the run. */
export function setFailed(message: string): void {
  process.exitCode = 1;
  console.error(`::error::${message}`);
}
