import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const idePackage = JSON.parse(readFileSync('intake/surfaces/ide/package.json', 'utf8'));
const idePackageLock = JSON.parse(readFileSync('intake/surfaces/ide/package-lock.json', 'utf8'));
const lock = JSON.parse(readFileSync('upstream.lock', 'utf8'));
const prepare = readFileSync('scripts/prepare-release-inputs.sh', 'utf8');
const installer = readFileSync('scripts/build-installer.sh', 'utf8');
const postinstall = readFileSync('scripts/install-packaged-application.sh', 'utf8');
const installedVerifier = readFileSync('scripts/verify-installed-application.sh', 'utf8');
const lspGateway = readFileSync('intake/surfaces/ide/server/lsp-gateway.mjs', 'utf8');
const frameServer = readFileSync('apps/frame/server/frame-server.mjs', 'utf8');
const coreHttp = readFileSync('core/daemon/src/http.ts', 'utf8');
const cursemShim = readFileSync('intake/surfaces/ide/cli/bin/cursem', 'utf8');
const agentTaskRunner = readFileSync('intake/surfaces/ide/server/agent-task-runner.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/clean-macos-install.yml', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const ttyAddons = ['addon-fit', 'addon-webgl', 'addon-canvas', 'addon-search', 'addon-unicode11'];
const ideRuntimeLaunchers = [
  'bash-language-server',
  'pyright',
  'pyright-langserver',
  'typescript-language-server',
  'vscode-css-language-server',
  'vscode-html-language-server',
  'vscode-json-language-server',
];
const packagedGatewayLaunchers = [
  'bash-language-server',
  'pyright-langserver',
  'typescript-language-server',
  'vscode-css-language-server',
  'vscode-html-language-server',
  'vscode-json-language-server',
];
const ideRuntimePackages = [
  'bash-language-server',
  'pyright',
  'typescript',
  'typescript-language-server',
  'vscode-langservers-extracted',
];

test('every packaged Node project has a committed lockfile', () => {
  assert.doesNotThrow(() => readFileSync('pnpm-lock.yaml', 'utf8'));
  for (const path of [
    'intake/surfaces/desktop/package-lock.json',
    'intake/surfaces/ide/package-lock.json',
    'intake/surfaces/launcher/package-lock.json',
    'intake/surfaces/pty/package-lock.json',
    'apps/frame/extensions/floyd-tty-bridge/package-lock.json',
  ]) assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), path);
  assert.equal(rootPackage.engines.node, '>=26');
  assert.equal(rootPackage.packageManager, 'pnpm@11.24.0');
  for (const dependency of ideRuntimePackages) {
    assert.equal(
      idePackageLock.packages[''].dependencies[dependency],
      idePackage.dependencies[dependency],
      `${dependency} must remain a locked IDE production dependency`,
    );
    assert.equal(idePackage.devDependencies?.[dependency], undefined);
  }
});

test('OpenCode lock identifies and hashes an immutable platform artifact', () => {
  assert.match(lock.opencode.artifact_url, /opencode-darwin-arm64-1\.17\.18\.tgz$/);
  assert.match(lock.opencode.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.opencode.artifact_binary_path, 'package/bin/opencode');
  assert.match(lock.opencode.sha256, /^[a-f0-9]{64}$/);
});

test('Node runtime lock identifies and hashes the exact release runtime', () => {
  assert.equal(lock.node.version, '26.5.0');
  assert.match(lock.node.artifact_url, /node-v26\.5\.0-darwin-arm64\.tar\.gz$/);
  assert.match(lock.node.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.node.artifact_binary_path, 'node-v26.5.0-darwin-arm64/bin/node');
  assert.match(lock.node.sha256, /^[a-f0-9]{64}$/);
});

test('installer rebuilds in an isolated git export before staging', () => {
  assert.match(installer, /status --porcelain --untracked-files=no/);
  assert.match(installer, /git archive "\$SOURCE_COMMIT"/);
  assert.match(installer, /git -C "\$ROOT" show -s --format=%cI "\$SOURCE_COMMIT"/);
  assert.match(installer, /prepare-release-inputs\.sh" "\$SOURCE"/);
  assert.match(installer, /SOURCE\/\.floyd-build\/opencode\/opencode/);
  assert.doesNotMatch(installer, /ENGINE_SRC=.*FLOYD_RUNTIME_ROOT/);
  assert.doesNotMatch(installer, /rsync -a "\$ROOT\/\$f"/);
  assert.match(installer, /SOURCE\/build-assets\/FLOYD\.icns/);
  assert.match(installer, /SOURCE\/\$workspace\/node_modules/);
  assert.match(installer, /SOURCE\/\$TTY_BRIDGE\/node_modules/);
  assert.doesNotMatch(installer, /pkgbuild --analyze/);
  assert.match(installer, /ditto -c -k --sequesterRsrc --keepParent "\$APP" "\$ARCHIVE"/);
  assert.match(installer, /SOURCE\/scripts\/install-packaged-application\.sh/);
  assert.match(installer, /--scripts "\$STAGE\/scripts"/);
  assert.doesNotMatch(installer, /--component-plist/);
  assert.match(postinstall, /ditto -x -k "\$ARCHIVE" "\$EXTRACTED"/);
  assert.match(postinstall, /mv "\$CANDIDATE" "\$APP"/);
  assert.match(postinstall, /desktop\/dist-server\/index\.js/);
  assert.match(postinstall, /ide\/dist\/index\.html/);
  assert.match(postinstall, /Resources\/node\/bin\/npm/);
  assert.match(postinstall, /Resources\/node\/bin\/npx/);
  assert.match(postinstall, /Resources\/node\/lib\/node_modules\/npm\/bin\/npm-cli\.js/);
  for (const addon of ttyAddons) {
    assert.match(postinstall, new RegExp(`floyd-tty-bridge/node_modules/@xterm/${addon}`));
  }
  assert.match(postinstall, /IDE_ROOT="\$CANDIDATE\/Contents\/Resources\/workstation\/intake\/surfaces\/ide"/);
  assert.match(postinstall, /required="\$IDE_ROOT\/node_modules\/\.bin\/\$launcher"\n  \[ -x "\$required" \] \|\| \{/);
  for (const launcher of ideRuntimeLaunchers) assert.match(postinstall, new RegExp(`\\b${launcher}\\b`));
  assert.match(postinstall, /TS_SERVER="\$IDE_ROOT\/node_modules\/typescript\/lib\/tsserver\.js"\n\[ -f "\$TS_SERVER" \] \|\| \{/);
  const recovery = postinstall.indexOf('if [ ! -e "$APP" ] && [ -e "$PREVIOUS" ]; then');
  const extractedCleanup = postinstall.indexOf('rm -rf "$EXTRACTED"');
  assert.ok(recovery >= 0 && recovery < extractedCleanup, 'interrupted install recovery must precede cleanup');
  assert.doesNotMatch(postinstall, /rm -rf "\$EXTRACTED" "\$PREVIOUS"/);
  for (const launcher of packagedGatewayLaunchers) {
    assert.match(lspGateway, new RegExp(`['"]${launcher}['"]`));
    assert.ok(ideRuntimeLaunchers.includes(launcher), `${launcher} must be required by the installed package`);
  }
  assert.match(prepare, /\['node'\]\['version'\]/);
  assert.match(prepare, /release builds require Node \$REQUIRED_NODE_VERSION exactly/);
  assert.match(prepare, /npx --yes pnpm@11\.24\.0 install --frozen-lockfile/);
  assert.match(prepare, /npm ci/);
  assert.match(prepare, /npm run build/);
  assert.match(prepare, /CI=true npx --yes pnpm@11\.24\.0 install --prod --frozen-lockfile/);
  assert.match(prepare, /npm prune --omit=dev/);
  assert.equal((prepare.match(/apps\/frame\/extensions\/floyd-tty-bridge/g) || []).length, 3);
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
  assert.match(installedVerifier, /OpenCode version mismatch/);
  assert.match(installedVerifier, /Contents\/MacOS\/FLOYD Desktop Suite/);
  assert.match(installedVerifier, /proxy-app-profiles/);
  assert.match(installedVerifier, /chmod 600 "\$PROFILE_DIR\/\$app\.json"/);
  assert.match(installedVerifier, /Library\/Preferences/);
  assert.match(installedVerifier, /security create-keychain/);
  assert.match(installedVerifier, /security unlock-keychain/);
  assert.match(installedVerifier, /security default-keychain -d user -s/);
  assert.match(installedVerifier, /clean-install verification refuses to replace running service/);
  assert.match(installedVerifier, /SERVICES_STARTED=1/);
  assert.match(installedVerifier, /installed workflow diagnostics/);
  assert.match(installedVerifier, /launch_surface\(\)/);
  assert.match(installedVerifier, /installed surface \$id did not launch \(HTTP \$status\)/);
  assert.match(installedVerifier, /TTY Bridge runtime dependency missing/);
  for (const addon of ttyAddons) assert.match(installedVerifier, new RegExp(`\\b${addon}\\b`));
  assert.match(installedVerifier, /IDE_ROOT="\$WS\/intake\/surfaces\/ide"/);
  assert.match(installedVerifier, /\[ -x "\$IDE_ROOT\/node_modules\/\.bin\/\$launcher" \] \|\| \{/);
  assert.match(installedVerifier, /IDE runtime launcher missing/);
  for (const launcher of ideRuntimeLaunchers) assert.match(installedVerifier, new RegExp(`\\b${launcher}\\b`));
  assert.match(installedVerifier, /\[ -f "\$IDE_ROOT\/node_modules\/typescript\/lib\/tsserver\.js" \] \|\| \{/);
  assert.match(installer, /NODE_DIR="\$HERE\/Resources\/node\/bin"/);
  assert.match(installer, /<key>PATH<\/key><string>%s:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(installer, /<key>FLOYD_AGENT_NODE<\/key><string>%s<\/string>/);
  const frameBootstrap = installer.indexOf('plist com.floyd.frame');
  const vaultReady = installer.indexOf('http://127.0.0.1:13031/healthz');
  const coreProfileReady = installer.indexOf('proxy-app-profiles/core.json');
  const coreBootstrap = installer.indexOf('plist com.floyd.core');
  assert.ok(
    frameBootstrap >= 0
      && vaultReady > frameBootstrap
      && coreProfileReady > frameBootstrap
      && coreBootstrap > vaultReady
      && coreBootstrap > coreProfileReady,
    'the installed launcher must wait for Frame/Vault to mint Core credentials before starting Core',
  );
  assert.doesNotMatch(installer, /FLOYD_NODE_VERSION|FLOYD_NODE_SHA256/);
  assert.match(installer, /node binary sha mismatch/);
  assert.match(installedVerifier, /EnvironmentVariables/);
  assert.match(installedVerifier, /environment\["PATH"\]/);
  assert.match(installedVerifier, /environment\["FLOYD_AGENT_NODE"\]/);
  assert.match(installedVerifier, /installed Node sha mismatch/);
  assert.match(installedVerifier, /installed Node version mismatch/);
  assert.match(installer, /rsync -a "\$STAGE\/\$NODE_ARCHIVE_ROOT\/" "\$RES\/node\/"/);
  assert.match(installedVerifier, /createAgentTaskRunner/);
  for (const tool of ['npm', 'npx', 'tsc']) assert.match(installedVerifier, new RegExp(`['"]${tool}['"]`));
  assert.match(agentTaskRunner, /resolve\(cwd, 'node_modules', '\.bin'\)/);
  assert.match(agentTaskRunner, /resolve\(root, 'node_modules', '\.bin'\)/);
  assert.match(agentTaskRunner, /resolve\(import\.meta\.dirname, '\.\.', 'node_modules', '\.bin'\)/);
  assert.match(agentTaskRunner, /PATH: taskPath/);
  assert.doesNotMatch(installedVerifier, /for app in core ff omf launcher; do/);
  assert.match(installedVerifier, /CORE_PROFILE="\$PROFILE_DIR\/core\.json"/);
  assert.match(installedVerifier, /ENGINE_CONFIG="\$RUNTIME\/engines\/opencode\/config\/opencode\.json"/);
  assert.match(installedVerifier, /profile\["proxyUrl"\] == "http:\/\/127\.0\.0\.1:13031"/);
  assert.match(installedVerifier, /options\["apiKey"\] == profile\["proxyToken"\]/);
  assert.match(installedVerifier, /options\["baseURL"\] == "http:\/\/127\.0\.0\.1:13031\/p\/zai\/api\/coding\/paas\/v4"/);
  assert.match(installedVerifier, /http:\/\/127\.0\.0\.1:13031\/status/);
  assert.match(installedVerifier, /status\.get\("authority"\) == "floyd-vault-keychain"/);
  for (const language of ['typescript', 'json', 'html', 'css', 'python', 'shell']) {
    assert.match(installedVerifier, new RegExp(`\\b${language}\\b`));
  }
  assert.match(installedVerifier, /api\/lsp\/restart/);
  assert.match(installedVerifier, /health\.get\("status"\) == "running"/);
  for (const surface of ['harness-launcher', 'floyd-code-cli', 'ohmyfloyd']) {
    assert.match(installedVerifier, new RegExp(`launch_surface ${surface}`));
  }
  assert.match(installedVerifier, /floyd-agent" code-reviewer --version/);
  assert.match(installedVerifier, /installed \$app managed launcher could not use bundled Node/);
  assert.match(installedVerifier, /\^floyd version v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(installedVerifier, /\^omp\/\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(installedVerifier, /launcher did not execute its packaged binary/);
  assert.match(installedVerifier, /engine.*ok/);
  assert.doesNotMatch(installedVerifier, /frame-server\.mjs.*>/);
});

test('installed release identity and CLI runtime remain self-contained', () => {
  assert.match(installer, /SOURCE_COMMIT=\$\(git -C "\$ROOT" rev-parse HEAD\)/);
  assert.match(installer, /"source_commit": "\$SOURCE_COMMIT"/);
  assert.match(installer, /"node_version": "v\$RELEASE_NODE_VERSION"/);
  assert.match(installer, /"\$WS\/release\.json"/);
  assert.match(postinstall, /workstation\/release\.json/);
  assert.match(frameServer, /PACKAGED_SOURCE_COMMIT/);
  assert.match(frameServer, /requested\.FLOYD_SOURCE_COMMIT = PACKAGED_SOURCE_COMMIT/);
  assert.match(coreHttp, /RELEASE_IDENTITY\.source === "runtime-release"/);
  assert.match(coreHttp, /return RELEASE_IDENTITY\.source_commit/);
  assert.match(installedVerifier, /EXPECTED_SOURCE_COMMIT=\$\(git -C "\$ROOT" rev-parse HEAD\)/);
  assert.match(installedVerifier, /installed release identity mismatch/);
  assert.match(installedVerifier, /\/api\/surfaces/);
  for (const surface of ['desktop', 'ide', 'pty', 'launcher']) {
    assert.match(installedVerifier, new RegExp(`\\b${surface}\\b`));
  }
  assert.match(installedVerifier, /surface\.get\("verified"\) is True/);

  assert.match(cursemShim, /FLOYD_AGENT_NODE/);
  assert.match(cursemShim, /\[ -x "\$NODE_BIN" \]/);
  assert.match(cursemShim, /exec "\$NODE_BIN"/);
  assert.match(installedVerifier, /\/bin\/zsh -l -c '\"\$1\" --version'/);
  assert.match(installedVerifier, /CURSEM bundled-Node smoke/);
});

test('clean-install contract exercises the mandatory internal browser', () => {
  assert.match(readme, /Google Chrome/);
  assert.match(workflow, /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/);
  assert.match(frameServer, /\/api\/action\/open-chrome/);
  assert.match(frameServer, /\/api\/action\/close-chrome/);
  assert.match(installedVerifier, /CHROME_BIN="\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome"/);
  assert.match(installedVerifier, /\/api\/action\/open-chrome/);
  assert.match(installedVerifier, /browser\.get\("opened"\) is True/);
  assert.match(installedVerifier, /browser\.get\("cdpPort"\) == 13032/);
  assert.match(installedVerifier, /len\(browser\.get\("loaded", \[\]\)\) == 2/);
  assert.match(installedVerifier, /\/api\/action\/close-chrome/);
});
