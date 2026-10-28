import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const dshHome = resolve(option('dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')));
const profile = option('profile', process.env.DSH_PROFILE ?? 'desktop');
const profileDir = join(dshHome, 'profiles', profile);
const manifestPath = join(profileDir, 'package.json');
const installedDir = join(profileDir, 'node_modules', sourceManifest.name);

const failures = [];
const passes = [];
const check = (condition, message) => (condition ? passes.push(message) : failures.push(message));
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

check(existsSync(manifestPath), `profile manifest exists: ${manifestPath}`);
if (existsSync(manifestPath)) {
  const profileManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dependency = profileManifest.dependencies?.[sourceManifest.name];
  check(typeof dependency === 'string', `dependency "${sourceManifest.name}" is present`);
  check(Array.isArray(profileManifest.dsh?.profile?.bundles)
    && profileManifest.dsh.profile.bundles.includes(sourceManifest.name),
  `bundle list contains "${sourceManifest.name}"`);
  if (typeof dependency === 'string') {
    check(/(^|[\\/])vendor[\\/]dsh-effort-keeper-[^\\/]+\.tgz$/.test(dependency),
      `dependency points at a vendor tarball: ${dependency}`);
  }
}

check(existsSync(installedDir), `installed package exists: ${installedDir}`);
if (existsSync(installedDir)) {
  const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  check(installedManifest.name === sourceManifest.name, `installed name is ${sourceManifest.name}`);
  check(installedManifest.version === sourceManifest.version,
    `installed version is ${installedManifest.version} (source ${sourceManifest.version})`);

  const files = ['index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'lib/core.js', 'lib/bridge.js'];
  for (const relative of files) {
    const sourceFile = join(root, relative);
    const installedFile = join(installedDir, relative);
    if (!existsSync(installedFile)) {
      failures.push(`installed file missing: ${relative}`);
      continue;
    }
    check(digest(sourceFile) === digest(installedFile), `byte-identical: ${relative}`);
  }

  const installedPatch = readFileSync(join(installedDir, 'cordis.patch.yml'), 'utf8');
  check(installedPatch.includes('id: effort-keeper'), 'installed patch inserts the effort-keeper row');
}

const tarballs = existsSync(join(root, 'vendor'))
  ? readdirSync(join(root, 'vendor')).filter((name) => name.endsWith('.tgz'))
  : [];
console.log(`EffortKeeper install verification`);
console.log(`  DSH home : ${dshHome}`);
console.log(`  Profile  : ${profile}`);
console.log(`  Installed: ${installedDir}`);
console.log(`  Vendor   : ${tarballs.join(', ') || '(none)'}`);
for (const line of passes) console.log(`  PASS  ${line}`);
for (const line of failures) console.log(`  FAIL  ${line}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${passes.length} checks passed.`);
