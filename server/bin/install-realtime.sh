#!/usr/bin/env bash
# Installs Kolam's live-update server (server/bin/realtime) as a background service. Run it once on a VPS:
#
#   bash server/bin/install-realtime.sh               install, or reinstall after updating Kolam
#   bash server/bin/install-realtime.sh --uninstall   remove it
#
# Then proxy a path to it in your web server (see deploy/nginx.conf or deploy/apache.conf) and set REALTIME_URL in .env,
# e.g. REALTIME_URL=wss://notes.example.com/ws. Without it Kolam still works: browsers poll about once a second.
#
# macOS: a LaunchAgent that starts at login and restarts if it stops. Linux: a systemd service, set up with sudo.
# Override the PHP binary with KOLAM_PHP=/path/to/php.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="kolam-realtime"

pick_php() {
  if [ -n "${KOLAM_PHP:-}" ]; then echo "$KOLAM_PHP"
  elif [[ "$ROOT" == /Applications/XAMPP/* ]] && [ -x /Applications/XAMPP/xamppfiles/bin/php ]; then echo /Applications/XAMPP/xamppfiles/bin/php
  else command -v php || true; fi
}

if [ "$(uname)" = Darwin ]; then
  LABEL="com.kolam.realtime" DOMAIN="gui/$(id -u)"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
fi

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$(uname)" = Darwin ]; then rm -f "$PLIST"
  else
    sudo systemctl disable --now "$NAME" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/$NAME.service" && sudo systemctl daemon-reload
  fi
  echo "Kolam realtime server removed. Remove REALTIME_URL from .env so browsers go back to polling."
  exit 0
fi

PHP="$(pick_php)"
[ -n "$PHP" ] && [ -x "$PHP" ] || { echo "PHP not found. Set KOLAM_PHP=/path/to/php and run this again." >&2; exit 1; }
# checks the PHP version and the database settings in .env, and finds the storage folder and the address to listen on
read -r STORAGE LISTEN < <(cd "$ROOT" && "$PHP" -r 'if (PHP_VERSION_ID < 80100) { fwrite(STDERR, "PHP 8.1 or newer is needed (this is " . PHP_VERSION . ")\n"); exit(1); }
  require "server/bootstrap.php"; Kolam\Db::pdo(); echo Kolam\Config::get("storage"), " ", Kolam\Config::get("realtime_listen");')
LOG_DIR="$STORAGE/logs"
mkdir -p "$LOG_DIR"

if [ "$(uname)" = Darwin ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PHP</string><string>$ROOT/server/bin/realtime</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/realtime.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/realtime.log</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 2
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then
    echo "Kolam realtime server is running on $LISTEN and starts by itself whenever you log in."
  else
    echo "The realtime server did not start. See $LOG_DIR/realtime.log" >&2; exit 1
  fi
else
  command -v systemctl >/dev/null || { echo "systemd not found. Run '$PHP $ROOT/server/bin/realtime' with your process manager (e.g. aaPanel's Supervisor)." >&2; exit 1; }
  sudo tee "/etc/systemd/system/$NAME.service" >/dev/null <<UNIT
[Unit]
Description=Kolam realtime server (live updates and presence)
After=network-online.target mysql.service mariadb.service

[Service]
User=$(id -un)
WorkingDirectory=$ROOT
ExecStart=$PHP $ROOT/server/bin/realtime
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$NAME"
  sleep 2
  if systemctl is-active --quiet "$NAME"; then
    echo "Kolam realtime server is running on $LISTEN and starts with the server. Logs: journalctl -u $NAME"
  else
    echo "The realtime server did not start. See: journalctl -u $NAME" >&2; exit 1
  fi
fi
