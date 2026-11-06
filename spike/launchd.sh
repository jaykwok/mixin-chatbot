#!/bin/bash
# macOS spike (2026-11-06): LaunchDaemon behaviour for docs/dev/macos-inventory-20261104.md §1.13/1.14/1.19.
# Runs on a GitHub Actions macOS runner (passwordless sudo). Creates a role account, a daemon and a GUI-domain one-shot,
# records what launchd does, then removes everything it created. Bash 3.2 compatible.
set -u
label=org.mixin-bot.spike
account=_mixinspike
root=/Users/Shared/mixin-spike
plist=/Library/LaunchDaemons/$label.plist
bun="$(command -v bun)"
log() { printf '\n== %s\n' "$*"; }
wait_for() { local i; for i in $(seq 1 "$2"); do [ -e "$1" ] && return 0; sleep 1; done; return 1; }

log "role account"
if sudo sysadminctl -addUser "$account" -fullName "mixin spike" -UID 499 -shell /usr/bin/false -home /var/empty -roleAccount 2>&1; then
    echo "sysadminctl -roleAccount: ok"
else
    echo "sysadminctl failed; dscl fallback"
    sudo dscl . -create /Users/$account && sudo dscl . -create /Users/$account UniqueID 499 && sudo dscl . -create /Users/$account PrimaryGroupID 20 \
        && sudo dscl . -create /Users/$account UserShell /usr/bin/false && sudo dscl . -create /Users/$account NFSHomeDirectory /var/empty \
        && sudo dscl . -create /Users/$account IsHidden 1
fi
id "$account"; dscl . -read /Users/$account UniqueID PrimaryGroupID UserShell NFSHomeDirectory 2>&1 | head -5

log "service tree"
sudo mkdir -p "$root/bin" "$root/run" "$root/logs"
sudo cp "$bun" "$root/bin/bun"
sudo tee "$root/service.ts" > /dev/null <<'EOF'
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const run = process.cwd() + "/run";
const note = (line: string) => appendFileSync(run + "/events", `${Date.now()} ${process.pid} ${line}\n`);
note("start");
const limits = Bun.spawnSync(["/bin/sh", "-c", "ulimit -n; ulimit -Hn; id; locale; echo HOME=$HOME TMPDIR=$TMPDIR"]).stdout.toString();
writeFileSync(run + "/state-" + process.pid, JSON.stringify({ pid: process.pid, ppid: process.ppid, uid: process.getuid?.(), cwd: process.cwd(), env: process.env, limits }, null, 2));
process.on("SIGTERM", () => { note("SIGTERM"); setTimeout(() => { note("exit after SIGTERM"); process.exit(0); }, 1500); });
setInterval(() => {
  if (existsSync(run + "/exit0")) { note("exit 0 on flag"); process.exit(0); }
  if (existsSync(run + "/exit3")) { note("exit 3 on flag"); process.exit(3); }
}, 200);
EOF
sudo chown -R "$account" "$root/run" "$root/logs"
sudo chmod 755 "$root" "$root/bin" "$root/bin/bun"; sudo chmod 644 "$root/service.ts"
sudo tee "$plist" > /dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$account</string>
  <key>ProgramArguments</key><array><string>$root/bin/bun</string><string>$root/service.ts</string></array>
  <key>WorkingDirectory</key><string>$root</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>LANG</key><string>en_US.UTF-8</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <key>StandardOutPath</key><string>$root/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$root/logs/stderr.log</string>
</dict></plist>
EOF
sudo chown root:wheel "$plist"; sudo chmod 644 "$plist"; plutil -lint "$plist"

log "bootstrap"
t0=$(date +%s)
sudo launchctl bootstrap system "$plist"; echo "bootstrap=$?"
wait_for "$root/run/events" 20 && echo "started after $(( $(date +%s) - t0 ))s"
sleep 2
sudo launchctl print system/$label | head -60
first=$(sudo awk '{print $2; exit}' "$root/run/events")
echo "first pid=$first"
sudo cat "$root/run/state-$first" | head -60

log "SIGKILL -> restart delay"
sudo kill -9 "$first"; t0=$(date +%s)
for i in $(seq 1 40); do n=$(sudo grep -c ' start$' "$root/run/events"); [ "$n" -ge 2 ] && break; sleep 1; done
echo "restarted=$n after $(( $(date +%s) - t0 ))s"
sudo launchctl print system/$label | grep -E 'state|pid|last exit|runs|throttle' | head

log "exit 3 -> restart; exit 0 -> no restart"
sudo touch "$root/run/exit3"; sleep 1; sudo rm -f "$root/run/exit3"
for i in $(seq 1 40); do n=$(sudo grep -c ' start$' "$root/run/events"); [ "$n" -ge 3 ] && break; sleep 1; done
echo "starts after exit 3: $n"
sudo touch "$root/run/exit0"; sleep 15; sudo rm -f "$root/run/exit0"
echo "starts after exit 0 (+15s): $(sudo grep -c ' start$' "$root/run/events")"
sudo launchctl print system/$label | grep -E 'state|pid|last exit' | head

log "kickstart, disable, bootout"
sudo launchctl kickstart system/$label; echo "kickstart=$?"; sleep 3
echo "starts: $(sudo grep -c ' start$' "$root/run/events")"
sudo launchctl disable system/$label; echo "disable=$?"
sudo launchctl print-disabled system | grep "$label"
t0=$(date +%s); sudo launchctl bootout system/$label; echo "bootout=$? after $(( $(date +%s) - t0 ))s"
sudo tail -5 "$root/run/events"
sudo launchctl bootstrap system "$plist"; echo "bootstrap while disabled=$?"
sudo launchctl print system/$label 2>&1 | grep -E 'state|pid' | head -3
sudo launchctl enable system/$label; echo "enable=$?"
sudo launchctl bootstrap system "$plist" 2>&1; echo "bootstrap after enable=$?"; sleep 3
sudo launchctl print system/$label 2>&1 | grep -E 'state|pid' | head -3
sudo launchctl bootout system/$label; echo "final bootout=$?"
echo "stdout:"; sudo cat "$root/logs/stdout.log" | head; echo "stderr:"; sudo cat "$root/logs/stderr.log" | head

log "user domains"
uid=$(id -u)
launchctl print "gui/$uid" > /dev/null 2>&1; echo "gui/$uid printable=$?"
launchctl print "user/$uid" > /dev/null 2>&1; echo "user/$uid printable=$?"
who; stat -f '%Su' /dev/console
oneshot=$HOME/Library/LaunchAgents/org.mixin-bot.spike-task.plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$oneshot" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.mixin-bot.spike-task</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>echo ran \$\$ > /tmp/spike-task.out; sleep 2</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
for domain in "gui/$uid" "user/$uid"; do
    rm -f /tmp/spike-task.out
    launchctl bootstrap "$domain" "$oneshot"; rc=$?
    sleep 4
    echo "$domain bootstrap=$rc ran=$(cat /tmp/spike-task.out 2>/dev/null)"
    launchctl print "$domain/org.mixin-bot.spike-task" 2>&1 | grep -E 'state|last exit|runs' | head -3
    launchctl bootout "$domain/org.mixin-bot.spike-task"; echo "$domain bootout=$?"
done
rm -f "$oneshot"

log "sudo for a console task: does a system one-shot need root"
launchctl bootstrap system "$plist" 2>&1; echo "non-root system bootstrap=$?"

log "cleanup"
sudo rm -f "$plist"; sudo rm -rf "$root"
sudo sysadminctl -deleteUser "$account" 2>&1 || sudo dscl . -delete /Users/$account
id "$account" 2>&1
exit 0
