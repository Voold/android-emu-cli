#!/system/bin/sh
# Zygote can use its own mount namespace.  Re-assert the safe APEX bind mount
# there after boot; post-fs-data.sh already mounted it in the init namespace.
MODDIR=${0%/*}
APEX_CA_DIR=/apex/com.android.conscrypt/cacerts
MERGED_CA_DIR="$MODDIR/apex-cacerts"
LOG_TAG=android-emu-ca
MAX_ZYGOTE_ATTEMPTS=20
ZYGOTE_RETRY_SECONDS=1

log_line() {
  log -t "$LOG_TAG" "$1"
}

bind_for_zygote() {
  process_name=$1
  for pid in $(pidof "$process_name"); do
    case "$pid" in
      *[!0-9]*|'') log_line "ERROR: invalid $process_name pid"; continue ;;
    esac
    ZYGOTE_FOUND=$((ZYGOTE_FOUND + 1))
    nsenter -t "$pid" -m -- mount -o bind "$MERGED_CA_DIR" "$APEX_CA_DIR" || {
      log_line "ERROR: cannot bind merged CAs in $process_name namespace (pid $pid). Verify the module manually."
      continue
    }
    ZYGOTE_BOUND=$((ZYGOTE_BOUND + 1))
    log_line "Bound merged CAs in $process_name namespace (pid $pid)."
  done
}

is_apex_active() {
  [ -d "$APEX_CA_DIR" ] || return 1
  SDK_VERSION=$(getprop ro.build.version.sdk)
  case "$SDK_VERSION" in
    *[!0-9]*|'') log_line "ERROR: malformed Android SDK level: ${SDK_VERSION:-empty}"; return 2 ;;
  esac
  if [ "$SDK_VERSION" -lt 1 ] || [ "$SDK_VERSION" -gt 999 ]; then
    log_line "ERROR: out-of-range Android SDK level: $SDK_VERSION"
    return 2
  fi
  SYSTEM_CERTS_ENABLED=$(getprop system.certs.enabled)
  case "$SYSTEM_CERTS_ENABLED" in
    ''|false) ;;
    true) return 1 ;;
    *) log_line "ERROR: malformed system.certs.enabled: $SYSTEM_CERTS_ENABLED"; return 2 ;;
  esac
  [ "$SDK_VERSION" -lt 34 ] && return 1
  for source in "$APEX_CA_DIR"/*; do
    [ -e "$source" ] && return 0
  done
  return 1
}

is_apex_active
APEX_STATE=$?
case "$APEX_STATE" in
  0) ;;
  1) log_line "Conscrypt APEX is not active; no zygote namespace mount is required."; exit 0 ;;
  *) log_line "ERROR: cannot determine active Conscrypt certificate store."; exit 1 ;;
esac

if [ ! -d "$MERGED_CA_DIR" ]; then
  log_line "Merged CA directory is absent; retrying the bounded post-fs-data setup."
  "$MODDIR/post-fs-data.sh" || {
    log_line "ERROR: post-fs-data recovery failed; APEX trust store was not modified."
    exit 1
  }
fi
[ -d "$MERGED_CA_DIR" ] || {
  log_line "ERROR: merged CA directory is still missing; APEX trust store was not modified."
  exit 1
}

mount -o bind "$MERGED_CA_DIR" "$APEX_CA_DIR" || {
  log_line "ERROR: cannot bind merged CAs in init namespace; verify the module manually."
  exit 1
}
attempt=1
while [ "$attempt" -le "$MAX_ZYGOTE_ATTEMPTS" ]; do
  ZYGOTE_FOUND=0
  ZYGOTE_BOUND=0
  bind_for_zygote zygote
  bind_for_zygote zygote64
  if [ "$ZYGOTE_FOUND" -gt 0 ] && [ "$ZYGOTE_BOUND" -eq "$ZYGOTE_FOUND" ]; then
    log_line "Verified CA bind mount in $ZYGOTE_BOUND zygote namespace(s)."
    exit 0
  fi
  if [ "$attempt" -eq "$MAX_ZYGOTE_ATTEMPTS" ]; then
    log_line "ERROR: timed out waiting for zygote namespace bind after $MAX_ZYGOTE_ATTEMPTS attempts."
    exit 1
  fi
  log_line "Waiting for complete zygote namespace bind (attempt $attempt/$MAX_ZYGOTE_ATTEMPTS)."
  sleep "$ZYGOTE_RETRY_SECONDS"
  attempt=$((attempt + 1))
done
