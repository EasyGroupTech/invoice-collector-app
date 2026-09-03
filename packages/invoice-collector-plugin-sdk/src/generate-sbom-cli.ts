#!/usr/bin/env node
import { generateSbom, type GenerateSbomOptions } from './generate-sbom.js';

function parseArgs(argv: string[]): GenerateSbomOptions {
  const options: GenerateSbomOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--cwd':
        options.cwd = value;
        i += 1;
        break;
      case '--workspace':
        options.workspace = value;
        i += 1;
        break;
      case '--output':
        options.outputFile = value;
        i += 1;
        break;
      default:
        throw new Error(`generate-sbom: unrecognized argument "${arg}"`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await generateSbom(options);

  if (!result.compatibility.compatible) {
    const count = result.compatibility.violations.length;
    console.error(`generate-sbom: found ${count} MIT-incompatible dependenc${count === 1 ? 'y' : 'ies'}:`);
    for (const violation of result.compatibility.violations) {
      console.error(`  - ${violation.name}@${violation.version ?? 'unknown'}: ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`generate-sbom: wrote ${result.outputFile} — all dependencies MIT-compatible.`);
}

main().catch((error: unknown) => {
  console.error('generate-sbom failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
