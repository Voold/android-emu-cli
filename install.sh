#!/usr/bin/env bash
set -euo pipefail

DRY_RUN="${ANDROID_EMU_DRY_RUN:-0}"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

run() {
  if [[ "$DRY_RUN" == '1' ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return
  fi
  "$@"
}

accept_android_licenses() {
  if [[ "$DRY_RUN" == '1' ]]; then
    echo '[dry-run] yes | sdkmanager --licenses'
    return
  fi
  local sdkmanager_status
  yes | sdkmanager --licenses || {
    sdkmanager_status=${PIPESTATUS[1]}
    return "$sdkmanager_status"
  }
}

initialize_mitmproxy_ca() {
  local ca_path="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
  if [[ -r "$ca_path" ]]; then
    if [[ "$DRY_RUN" == '1' ]]; then
      echo "[dry-run] would validate existing PEM: $ca_path"
      return
    fi
    if grep -Eq -- '-----BEGIN( [A-Z0-9]+)* PRIVATE KEY-----' "$ca_path"; then
      echo "Локальный CA mitmproxy содержит закрытый ключ и не может использоваться: $ca_path" >&2
      return 1
    fi
    if openssl x509 -in "$ca_path" -noout >/dev/null 2>&1; then
      echo "Локальный CA mitmproxy уже существует: $ca_path"
      return
    fi
    echo "Локальный CA mitmproxy не проходит проверку openssl: $ca_path" >&2
    return 1
  fi
  if [[ "$DRY_RUN" == '1' ]]; then
    echo "[dry-run] would start mitmdump briefly to create $ca_path"
    return
  fi

  local log_path pid
  log_path="$(mktemp -t android-emu-mitmproxy)"
  mitmdump --quiet --listen-port 0 >"$log_path" 2>&1 &
  pid=$!
  for _ in {1..20}; do
    [[ -r "$ca_path" ]] && break
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  if [[ ! -r "$ca_path" ]]; then
    cat "$log_path" >&2
    rm -f "$log_path"
    echo 'mitmproxy не создал локальный CA.' >&2
    return 1
  fi
  rm -f "$log_path"
}

activate_homebrew() {
  local brew_bin=''
  if [[ "$DRY_RUN" == '1' ]] && ! command -v brew >/dev/null 2>&1; then
    case "$(uname -m)" in
      arm64) brew_bin='/opt/homebrew/bin/brew' ;;
      x86_64) brew_bin='/usr/local/bin/brew' ;;
      *) brew_bin='/opt/homebrew/bin/brew' ;;
    esac
    echo "[dry-run] would eval \"$brew_bin shellenv\""
    return
  fi
  if command -v brew >/dev/null 2>&1; then
    brew_bin="$(command -v brew)"
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    brew_bin='/opt/homebrew/bin/brew'
  elif [[ -x /usr/local/bin/brew ]]; then
    brew_bin='/usr/local/bin/brew'
  fi

  if [[ -z "$brew_bin" ]]; then
    echo 'Homebrew установлен, но brew не найден. Откройте новый Terminal и повторите ./install.sh.' >&2
    return 1
  fi

  if [[ "$DRY_RUN" == '1' ]]; then
    echo "[dry-run] would eval \"$brew_bin shellenv\""
    return
  fi

  eval "$("$brew_bin" shellenv)"
}

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'Этот установщик поддерживает только macOS.' >&2
  exit 1
fi

cat <<EOF
android-emu: подготовка macOS

Будут установлены или проверены:
  - Homebrew (если его ещё нет)
  - Node.js, Android Command-line Tools и mitmproxy
  - Android platform-tools и emulator
  - зависимости npm и глобальная команда android-emu
  - локальный CA mitmproxy в ~/.mitmproxy

ANDROID_HOME: $ANDROID_HOME
EOF

if [[ "$DRY_RUN" != '1' ]]; then
  read -r -p 'Продолжить? [y/N] ' answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo 'Установка отменена.'
    exit 0
  fi
fi

if ! command -v brew >/dev/null 2>&1; then
  if [[ "$DRY_RUN" == '1' ]]; then
    echo '[dry-run] would install Homebrew from https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'
  else
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
fi

activate_homebrew

run brew install node mitmproxy
run brew install --cask android-commandlinetools

run mkdir -p "$ANDROID_HOME"
accept_android_licenses
run sdkmanager --install 'platform-tools' 'emulator'
run npm ci
run npm link
initialize_mitmproxy_ca
run android-emu doctor
