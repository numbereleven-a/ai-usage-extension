/**
 * Packages the built Firefox extension into an unsigned XPI.
 * Run via `pnpm release` (which builds first).
 */
import webExt from 'web-ext';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const distDir = resolve(root, 'dist');
const releaseDir = resolve(root, 'release');

if (!existsSync(distDir)) {
  console.error('✗ dist/ not found — run `pnpm build` first.');
  process.exit(1);
}

const { name, version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

if (version !== manifest.version) {
  console.error(`✗ Version mismatch: package.json is ${version}, manifest.json is ${manifest.version}.`);
  console.error('  Run `pnpm bump` or update both files before releasing.');
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });

const xpiName = `${name}-${version}-firefox.xpi`;

await webExt.cmd.build({
  sourceDir: distDir,
  artifactsDir: releaseDir,
  filename: xpiName,
  overwriteDest: true,
}, { shouldExitProgram: false });

console.log(`✓ Packaged release/${xpiName} (unsigned)`);
