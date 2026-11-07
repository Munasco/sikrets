# shellcheck shell=bash
# Sourced by host.sh: the enclave image's lifecycle on the host. Tested by images.test.ts.
#
# An image is a slot: its EIF, its measurements (nitro-cli's JSON, with PCR0) and the commit it was
# built from (.sha). Slots: new (built, not running), cur (running), prev (the last good one, for
# rollback), out (the one being replaced, only while a switch is in progress) and rejected (rolled
# back from; never started again by itself).
#
#   build:    (empty) -> new                   a failed build leaves no new slot
#   up:       new -> cur, cur -> out; once /healthz answers, out -> prev
#   rollback: prev -> cur, cur -> out; once /healthz answers, out -> rejected
#   failure:  cur -> back where it came from, out -> cur, and the old units restart (EXIT trap)
#
# The caller sets EIF and STATE and defines: stop_enclave, start_enclave, healthy (0 once the new
# enclave's gateway answers), pinned_pcr0s (prints the PCR0s the KMS key allows, one per line;
# fails if it can't tell), head_sha (the checkout's commit) and, optionally, deployed (after a
# switch) and fallback (when a failed switch has no enclave to go back to).

slot_eif() { if [ "$1" = cur ]; then echo "$EIF"; else echo "$EIF.$1"; fi; }
slot_meas() { if [ "$1" = cur ]; then echo "$STATE/measurements.json"; else echo "$STATE/measurements.$1.json"; fi; }
slot_sha() { echo "$(slot_eif "$1").sha"; }
complete() { [ -s "$(slot_eif "$1")" ] && [ -s "$(slot_meas "$1")" ]; }
clear_slot() { rm -f "$(slot_eif "$1")" "$(slot_meas "$1")" "$(slot_sha "$1")"; }

# Moves a whole image to another slot, replacing what was there. Checks the source first, so a
# missing piece never leaves half an image moved.
move_slot() {
  complete "$1" || { echo "image slot $1 is incomplete; nothing moved" >&2; return 1; }
  clear_slot "$2"
  mv -f "$(slot_eif "$1")" "$(slot_eif "$2")"
  mv -f "$(slot_meas "$1")" "$(slot_meas "$2")"
  if [ -f "$(slot_sha "$1")" ]; then mv -f "$(slot_sha "$1")" "$(slot_sha "$2")"; fi
}

pcr0() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["Measurements"]["PCR0"].lower())' "$(slot_meas "$1")"; }
slot_commit() { cat "$(slot_sha "$1")" 2>/dev/null || echo unknown; }

# Whether the KMS key lets this slot's image decrypt. FORCE=1 skips the check (say, the pin can't
# be read and you've checked it yourself).
check_pinned() {
  local want pins
  want=$(pcr0 "$1") || { echo "can't read the $1 image's PCR0" >&2; return 1; }
  [ "${FORCE:-}" = 1 ] && return 0
  pins=$(pinned_pcr0s) || { echo "can't read which PCR0s the KMS key allows; FORCE=1 to go ahead anyway" >&2; return 1; }
  if ! printf '%s\n' "$pins" | grep -qix "$want"; then
    echo "the KMS key doesn't allow the $1 image (PCR0 ${want:0:16}…): it couldn't decrypt the model key." >&2
    echo "Pin it first, from your machine: ENCLAVE_PCR0=<live PCR0>,$want deploy/aws.sh" >&2
    return 1
  fi
}

# `up` starts only an image built from the commit that's checked out now.
check_new() {
  complete new || return 1
  local built head
  built=$(slot_commit new)
  head=$(head_sha)
  if [ "$built" != "$head" ] && [ "${FORCE:-}" != 1 ]; then
    echo "the built image is from $built, but the checkout is $head; run host.sh build (or FORCE=1)" >&2
    return 2
  fi
}

# A switch in progress: the slot the new image came from, and how far it got (aside: the running
# image moved to out; swapped: the new one is in cur). Kept in $STATE/switch too, written before
# each step, so a run killed midway (no EXIT trap) is undone by the next one (resume_switch).
TXN_FROM=""
TXN_STAGE=""
TXN_KEEP=""
txn() {
  TXN_FROM=$1
  TXN_STAGE=$2
  TXN_KEEP=${3:-}
  if [ -n "$1" ]; then
    printf '%s %s %s\n' "$1" "$2" "${3:-}" > "$STATE/switch.tmp" && mv -f "$STATE/switch.tmp" "$STATE/switch"
  else
    rm -f "$STATE/switch"
  fi
}

# Undoes a switch an earlier run left unfinished, if there is one.
resume_switch() {
  [ -s "$STATE/switch" ] || return 0
  read -r TXN_FROM TXN_STAGE TXN_KEEP < "$STATE/switch"
  echo "an earlier switch (from $TXN_FROM) didn't finish" >&2
  undo_switch
}

# Undoes a switch that didn't finish: the image that was starting goes back to its slot, the one it
# replaced comes back, and the old units start again.
undo_switch() {
  [ -n "$TXN_FROM" ] || return 0
  local opts=$-
  set +e
  if [ "$TXN_STAGE" = committing ]; then
    # The new image had answered; only putting the old one away was left.
    if complete out; then move_slot out "$TXN_KEEP"; fi
    txn "" ""
    case $opts in *e*) set -e ;; esac
    return 0
  fi
  echo "switch failed; restoring the image that was running" >&2
  stop_enclave
  # "swapped" is recorded before the move: cur is the new image only if it left its own slot.
  if [ "$TXN_STAGE" = swapped ] && ! complete "$TXN_FROM"; then move_slot cur "$TXN_FROM"; fi
  if complete out; then move_slot out cur; fi
  if complete cur; then
    start_enclave
  else
    echo "no enclave image was running before" >&2
    if declare -F fallback >/dev/null; then fallback; fi
  fi
  txn "" ""
  case $opts in *e*) set -e ;; esac
}

# switch <from> <old-goes-to>: starts the image in slot <from>, keeping the running one aside until
# the new one answers. A failed step undoes it here; the caller's EXIT trap (undo_switch) covers
# an exit in between (set -e, a signal).
switch() {
  local from=$1 keep=$2
  complete "$from" || { echo "no $from image" >&2; return 1; }
  clear_slot out
  txn "$from" started
  if complete cur; then
    # Recorded first: if this run dies between the two, the next one finds the image in out.
    txn "$from" aside
    move_slot cur out || { undo_switch; return 1; }
  fi
  txn "$from" swapped
  move_slot "$from" cur || { undo_switch; return 1; }
  stop_enclave || { undo_switch; return 1; }
  start_enclave || { undo_switch; return 1; }
  healthy || { echo "the new enclave didn't answer /healthz" >&2; undo_switch; return 1; }
  # Committed: only now does the replaced image take the prev (or rejected) slot.
  txn "$from" committing "$keep"
  if complete out; then move_slot out "$keep"; fi
  txn "" ""
  echo "running commit $(slot_commit cur) (PCR0 $(pcr0 cur | cut -c1-16)…)"
  if declare -F deployed >/dev/null; then deployed "$(slot_commit cur)" || true; fi
}
