#!/system/bin/sh
# Android 14+ moves the system trust store into the Conscrypt APEX.  Keep every
# existing APEX CA and add only this module's public CA files before bind-mounting.
MODDIR=${0%/*}
APEX_CA_DIR=/apex/com.android.conscrypt/cacerts
MODULE_CA_DIR="$MODDIR/system/etc/security/cacerts"
MERGED_CA_DIR="$MODDIR/apex-cacerts"
LOG_TAG=android-emu-ca

log_line() {
  log -t "$LOG_TAG" "$1"
}

fail_closed() {
  log_line "ERROR: $1; APEX trust store was not replaced."
  exit 1
}

safe_ca_name() {
  name=$1
  hash=${name%%.*}
  suffix=${name#*.}
  [ "$hash.$suffix" = "$name" ] || return 1
  [ "${#hash}" -eq 8 ] || return 1
  case "$hash" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  case "$suffix" in
    *[!0-9]*|'') return 1 ;;
  esac
  return 0
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
  1) log_line "Conscrypt APEX is not active; using the standard system overlay."; exit 0 ;;
  *) fail_closed "cannot determine active Conscrypt certificate store" ;;
esac

[ -d "$MODULE_CA_DIR" ] || fail_closed "module CA directory is missing"
case "$MERGED_CA_DIR" in
  "$MODDIR"/apex-cacerts) ;;
  *) fail_closed "unsafe merged CA path" ;;
esac

rm -rf "$MERGED_CA_DIR" || fail_closed "cannot clear the bounded merged CA directory"
mkdir -p "$MERGED_CA_DIR" || fail_closed "cannot create merged CA directory"

for source in "$APEX_CA_DIR"/*; do
  [ -f "$source" ] || continue
  name=${source##*/}
  safe_ca_name "$name" || continue
  cp -fp "$source" "$MERGED_CA_DIR/$name" || fail_closed "cannot copy APEX CA $name"
done

for source in "$MODULE_CA_DIR"/*; do
  [ -f "$source" ] || continue
  name=${source##*/}
  safe_ca_name "$name" || fail_closed "unsafe module CA filename: $name"
  target="$MERGED_CA_DIR/$name"
  if [ -e "$target" ]; then
    cmp -s "$source" "$target" && {
      log_line "Reusing identical existing CA $name."
      continue
    }
    fail_closed "module CA filename collides with an existing CA: $name"
  fi
  cp -fp "$source" "$target" || fail_closed "cannot copy module CA $name"
done

chown 0:0 "$MERGED_CA_DIR" "$MERGED_CA_DIR"/* || fail_closed "cannot set CA owner"
chmod 0755 "$MERGED_CA_DIR" || fail_closed "cannot set CA directory mode"
chmod 0644 "$MERGED_CA_DIR"/* || fail_closed "cannot set CA file mode"
chcon u:object_r:system_file:s0 "$MERGED_CA_DIR" "$MERGED_CA_DIR"/* || fail_closed "cannot set readable SELinux context"
mount -o bind "$MERGED_CA_DIR" "$APEX_CA_DIR" || fail_closed "cannot bind merged CAs over Conscrypt APEX"
log_line "Merged public module CAs into the Conscrypt APEX trust store."
