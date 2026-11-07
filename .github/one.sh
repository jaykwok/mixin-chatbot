set -u
echo "=== tools"
brew install bash coreutils uv oven-sh/bun/bun >/dev/null 2>&1; echo "brew exit $?"
brew install --cask libreoffice >/dev/null 2>&1; echo "libreoffice exit $?"
ls -l /opt/homebrew/bin/bun /opt/homebrew/bin/bash /opt/homebrew/bin/uv /opt/homebrew/opt/coreutils/libexec/gnubin/ls 2>&1 | cut -c1-200
/opt/homebrew/bin/bun --version
# A Python with the project's dependencies outside the runner's home, so the service account can run it.
export UV_PYTHON_INSTALL_DIR=/tmp/mixin-office-py
UV_PROJECT_ENVIRONMENT=/tmp/mixin-office-venv uv sync -q --frozen; echo "uv sync exit $?"
chmod -R a+rX /tmp/mixin-office-py /tmp/mixin-office-venv
echo "=== real launchd (root)"
sudo env MIXIN_TEST_REAL_LAUNCHD=1 MIXIN_TEST_MACOS_TOOLS=1 MIXIN_TEST_OFFICE_PYTHON=/tmp/mixin-office-venv/bin/python "$(command -v bun)" test tests/ops/core-real-launchd.test.ts 2>&1 | tail -60 | cut -c1-300
echo "=== entry (not root)"
"$(command -v bun)" test tests/ops/macos-entry.test.ts 2>&1 | tail -20 | cut -c1-300
echo "=== entry help under sudo"
sudo /bin/bash scripts/ops.sh help 2>&1 | head -3
sudo env MIXIN_OPS_BUN="$(command -v bun)" /bin/bash scripts/ops.sh doctor --json 2>&1 | head -c 600; echo
echo "=== sudo PATH"
sudo sh -c 'echo "PATH=$PATH"; command -v bun || echo "no bun on sudo PATH"'
sudo -i true 2>/dev/null; sudo grep -E "secure_path|env_keep" /etc/sudoers 2>&1 | head -5
echo "=== leftovers"
id _mixinbot 2>&1; dscl . -read /Groups/_mixinbot 2>&1 | head -3; ls -l /Library/LaunchDaemons | grep mixin; sudo launchctl list | grep mixin
ps -axo user,pid,comm | grep -i -E 'soffice|oosplash' | grep -v grep
exit 0
