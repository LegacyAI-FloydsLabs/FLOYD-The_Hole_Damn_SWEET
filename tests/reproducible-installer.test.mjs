import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('upstream.lock', 'utf8'));
const prepare = readFileSync('scripts/prepare-release-inputs.sh', 'utf8');
const installer = readFileSync('scripts/build-installer.sh', 'utf8');
const workflow = readFileSync('.github/workflows/clean-macos-install.yml', 'utf8');

test('every packaged Node project has a committed lockfile', () => {
  assert.doesNotThrow(() => readFileSync('pnpm-lock.yaml', 'utf8'));
  for (const path of [
    'intake/surfaces/desktop/package-lock.json',
    'intake/surfaces/ide/package-lock.json',
    'intake/surfaces/launcher/package-lock.json',
    'intake/surfaces/pty/package-lock.json',
  ]) assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), path);
  assert.equal(rootPackage.engines.node, '>=26');
  assert.equal(rootPackage.packageManager, 'pnpm@11.24.0');
});

test('OpenCode lock identifies and hashes an immutable platform artifact', () => {
  assert.match(lock.opencode.artifact_url, /opencode-darwin-arm64-1\.17\.18\.tgz$/);
  assert.match(lock.opencode.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.opencode.artifact_binary_path, 'package/bin/opencode');
  assert.match(lock.opencode.sha256, /^[a-f0-9]{64}$/);
});

test('installer rebuilds in an isolated git export before staging', () => {
  assert.match(installer, /git archive HEAD/);
  assert.match(installer, /prepare-release-inputs\.sh" "\$SOURCE"/);
  assert.match(installer, /SOURCE\/\.floyd-build\/opencode\/opencode/);
  assert.doesNotMatch(installer, /ENGINE_SRC=.*FLOYD_RUNTIME_ROOT/);
  assert.doesNotMatch(installer, /rsync -a "\$ROOT\/\$f"/);
  assert.match(installer, /SOURCE\/build-assets\/FLOYD\.icns/);
  assert.match(installer, /SOURCE\/\$workspace\/node_modules/);
  assert.doesNotMatch(installer, /pkgbuild --analyze/);
  assert.match(installer, /<plist version="1\.0"><array\/><\/plist>/);
  assert.match(installer, /--component-plist "\$COMPONENTS"/);
  assert.match(prepare, /release builds require Node 26 or newer/);
  assert.match(prepare, /npx --yes pnpm@11\.24\.0 install --frozen-lockfile/);
  assert.match(prepare, /npm ci/);
  assert.match(prepare, /npm run build/);
  assert.match(prepare, /CI=true npx --yes pnpm@11\.24\.0 install --prod --frozen-lockfile/);
  assert.match(prepare, /npm prune --omit=dev/);
  assert.doesNotMatch(installer, /--exclude-dir=intake/);
  for (const path of [
    'scripts/apply-omf-vault-routing-patch.sh',
    'intake/surfaces/omf/launch.sh',
    'intake/surfaces/desktop/server/chrono-hook.ts',
    'intake/surfaces/desktop/server/chrono-tools.ts',
    'intake/surfaces/desktop/server/floyd-core-experience.ts',
    'intake/surfaces/desktop/server/index.ts',
    'intake/surfaces/ide/server/core-experience.mjs',
    'intake/surfaces/pty/src/floyd-core.js',
  ]) assert.doesNotMatch(readFileSync(path, 'utf8'), /\/Volumes\/(?:Storage|SanDisk)/, path);
});

test('cloud workflow builds, installs, and exercises the installed application', () => {
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /test "\$\(uname -m\)" = arm64/);
  assert.match(workflow, /sudo installer -pkg/);
  assert.match(workflow, /verify-installed-application\.sh/);
  const installedVerifier = readFileSync('scripts/verify-installed-application.sh', 'utf8');
  assert.match(installedVerifier, /OpenCode version mismatch/);
  assert.match(installedVerifier, /Contents\/MacOS\/FLOYD Desktop Suite/);
  assert.match(installedVerifier, /engine.*ok/);
  assert.doesNotMatch(installedVerifier, /frame-server\.mjs.*>/);
});
