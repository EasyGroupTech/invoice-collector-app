import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkMitCompatibility, type CycloneDxDocument, type MitCompatibilityResult } from './sbom.js';

export interface GenerateSbomOptions {
  /**
   * Directory to run the scan from. For a standalone package (the common case — most plugin
   * authors' own repos), this is that package's own directory, containing its own lockfile.
   * For an npm-workspaces monorepo member (this monorepo's own packages included — verified
   * empirically: `cyclonedx-npm` can't find a workspace member's lockfile from inside the
   * member's own directory, since npm workspaces hoist the lockfile to the root), pass the
   * *workspace root* here and set `workspace` below. Defaults to process.cwd().
   */
  cwd?: string;
  /**
   * Set only when `cwd` is an npm-workspaces root: the target workspace's package name, passed
   * through to `cyclonedx-npm --workspace`. Leave unset for a standalone package.
   */
  workspace?: string;
  /**
   * Where to write the CycloneDX JSON SBOM, relative to `cwd` unless absolute. In workspace mode
   * this is still relative to the *root* `cwd`, not the workspace member's own directory — pass
   * e.g. "packages/my-plugin/sbom.cdx.json" explicitly, since `cyclonedx-npm` itself has no
   * concept of "the workspace member's own directory" to default this against. Defaults to
   * "sbom.cdx.json".
   */
  outputFile?: string;
}

export interface GenerateSbomResult {
  outputFile: string;
  sbom: CycloneDxDocument;
  compatibility: MitCompatibilityResult;
}

const DEFAULT_OUTPUT_FILE = 'sbom.cdx.json';

/**
 * Deliberately pinned, not left to float to whatever npm currently resolves as "latest" —
 * `runCyclonedxNpm` always invokes this exact version via `npx`, so behavior is reproducible for
 * every caller (us and every plugin author alike) without needing `@cyclonedx/cyclonedx-npm`
 * installed as a real dependency anywhere. Kept as `devDependencies` in this package's own
 * `package.json` too, purely so *our* local dev/CI has a warm, matching cache — that declaration
 * has no effect on what a consumer of this SDK ever installs. Bump deliberately, not casually.
 */
export const CYCLONEDX_NPM_VERSION = '6.0.1';

/**
 * Shells out to the real `cyclonedx-npm` CLI rather than reimplementing dependency-tree scanning
 * — deliberately not pinning `--spec-version`, so this tracks whatever that tool's own current
 * stable default emits (§13). `--omit dev`: a plugin's shipped SBOM should reflect what actually
 * runs, not its own build/test tooling.
 */
function runCyclonedxNpm(cwd: string, outputFile: string, workspace: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '--yes',
      `@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`,
      '--omit',
      'dev',
      '--output-file',
      outputFile,
    ];
    if (workspace) {
      args.push('--workspace', workspace, '--no-include-workspace-root');
    }
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cyclonedx-npm exited with code ${code}`));
      }
    });
  });
}

/**
 * Generates a CycloneDX SBOM and checks it for MIT-compatibility. The actual process-spawning
 * here is thin glue, verified manually against real packages (both standalone and, since this
 * monorepo is itself an npm-workspaces member, in `workspace` mode too) rather than covered by
 * the automated suite — a real npx invocation is slow and network-dependent, not a fit for the
 * fast unit-test loop. `checkMitCompatibility` (sbom.test.ts) carries the real test coverage for
 * the logic that actually matters.
 */
export async function generateSbom(options: GenerateSbomOptions = {}): Promise<GenerateSbomResult> {
  const cwd = options.cwd ?? process.cwd();
  const outputFile = options.outputFile ?? DEFAULT_OUTPUT_FILE;

  await runCyclonedxNpm(cwd, outputFile, options.workspace);

  const absoluteOutputFile = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
  const sbom = JSON.parse(await readFile(absoluteOutputFile, 'utf8')) as CycloneDxDocument;
  const compatibility = checkMitCompatibility(sbom);

  return { outputFile: absoluteOutputFile, sbom, compatibility };
}
