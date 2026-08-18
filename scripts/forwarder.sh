#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/3xui-aggregator}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
RULES_FILE="$DATA_DIR/redirect_rules.json"
STATUS_FILE="$DATA_DIR/redirect_status.json"
HOST_IPS_FILE="$DATA_DIR/redirect_host_ips.json"
CHAIN_NAT="AGG_REDIRECT"
CHAIN_FWD="AGG_REDIRECT_FWD"
CHAIN_POST="AGG_REDIRECT_POST"
SLEEP_SEC="${SLEEP_SEC:-3}"
IPT=""

need_root() { [ "${EUID}" -eq 0 ] || { echo "Run as root" >&2; exit 1; }; }
cmd_exists() { command -v "$1" >/dev/null 2>&1; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n'; }

pick_iptables() {
  if [ -n "${IPTABLES_BIN:-}" ] && command -v "$IPTABLES_BIN" >/dev/null 2>&1; then IPT="$IPTABLES_BIN"; return 0; fi
  local c
  for c in iptables-nft iptables iptables-legacy; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -S >/dev/null 2>&1; then IPT="$c"; return 0; fi
  done
  for c in iptables-nft iptables iptables-legacy; do
    if command -v "$c" >/dev/null 2>&1; then IPT="$c"; return 0; fi
  done
  return 1
}

write_status() {
  local ok="$1" msg="$2"
  mkdir -p "$DATA_DIR"
  printf '{"ok":%s,"message":"%s","updatedAt":"%s","rules":[]}' "$ok" "$(json_escape "$msg")" "$(date -Iseconds)" > "$STATUS_FILE"
}

write_apply_status() {
  local ok="$1" msg="$2" commands="$3" ipt_bin="${4:-$IPT}"
  mkdir -p "$DATA_DIR"
  python3 - "$RULES_FILE" "$STATUS_FILE" "$ok" "$msg" "$commands" "$ipt_bin" <<'PY'
import json, sys, datetime, subprocess, re
rules_path, status_path, ok, msg, commands, ipt_bin = sys.argv[1:7]
try:
    data=json.load(open(rules_path, encoding='utf-8'))
except Exception:
    data={'rules':[]}

def get_counter(chain, target_host, port):
    # Best effort: parse filter chain counters for destination/port.
    try:
        out=subprocess.check_output([ipt_bin, '-L', chain, '-v', '-n', '-x'], text=True, stderr=subprocess.DEVNULL, timeout=3)
    except Exception:
        return {}
    packets=bytes_=0
    for line in out.splitlines():
        if target_host in line and str(port) in line:
            parts=line.split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                packets += int(parts[0]); bytes_ += int(parts[1])
    return {'packets': packets, 'bytes': bytes_} if packets or bytes_ else {}

items=[]
for r in data.get('rules',[]) or []:
    try:
        rid=int(r.get('id'))
        port=int(r.get('target_port'))
    except Exception:
        continue
    metrics={'iptablesCommands': int(commands or 0), 'iptables': ipt_bin}
    metrics.update(get_counter('AGG_REDIRECT_FWD', str(r.get('target_host','')), port))
    items.append({
        'id': rid,
        'node_id': r.get('node_id'),
        'bind_ip': r.get('bind_ip'),
        'target_host': r.get('target_host'),
        'target_port': port,
        'protocol': r.get('protocol','tcp'),
        'rewrite_enabled': bool(r.get('rewrite_enabled', True)),
        'status': 'active' if ok == 'true' else 'error',
        'error': '' if ok == 'true' else msg,
        'metrics': metrics
    })
out={
    'ok': ok == 'true',
    'message': msg,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(),
    'iptables': ipt_bin,
    'rules': items
}
json.dump(out, open(status_path, 'w', encoding='utf-8'), ensure_ascii=False)
PY
}


refresh_runtime_status() {
  mkdir -p "$DATA_DIR"
  [ -n "$IPT" ] || pick_iptables || true
  local limit="${REDIRECT_BANDWIDTH_LIMIT_MBPS:-300}"
  python3 - "$RULES_FILE" "$STATUS_FILE" "${IPT:-iptables}" "$limit" <<'PYNET'
import json, sys, datetime, subprocess, time
rules_path, status_path, ipt_bin, limit = sys.argv[1:5]
try:
    data=json.load(open(rules_path, encoding='utf-8'))
except Exception:
    data={'rules':[]}
try:
    status=json.load(open(status_path, encoding='utf-8'))
except Exception:
    status={'ok': False, 'message': 'No status yet', 'rules': []}
try:
    limit_mbps=float(limit or 300)
except Exception:
    limit_mbps=300.0

def read_netdev():
    rx=tx=0
    ignored=('lo','docker','veth','br-','virbr','cni','flannel','kube','tailscale')
    try:
        for line in open('/proc/net/dev', encoding='utf-8', errors='ignore'):
            if ':' not in line: continue
            name, rest=line.split(':',1)
            name=name.strip()
            if not name or name.startswith(ignored): continue
            parts=rest.split()
            if len(parts) >= 16:
                rx += int(parts[0]); tx += int(parts[8])
    except Exception:
        pass
    return rx, tx

def chain_output(chain):
    try:
        return subprocess.check_output([ipt_bin, '-L', chain, '-v', '-n', '-x'], text=True, stderr=subprocess.DEVNULL, timeout=3)
    except Exception:
        return ''

fwd_out=chain_output('AGG_REDIRECT_FWD')
def get_counter(target_host, port):
    packets=bytes_=0
    for line in fwd_out.splitlines():
        if str(target_host) in line and str(port) in line:
            parts=line.split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                packets += int(parts[0]); bytes_ += int(parts[1])
    return {'packets': packets, 'bytes': bytes_} if packets or bytes_ else {}

now=time.time()
rx, tx = read_netdev()
prev = status.get('systemNetwork') or {}
prev_t = float(prev.get('sampledAtEpoch') or 0)
prev_rx = int(prev.get('rxBytes') or 0)
prev_tx = int(prev.get('txBytes') or 0)
rx_mbps = tx_mbps = total_mbps = 0.0
if prev_t > 0 and now > prev_t and rx >= prev_rx and tx >= prev_tx:
    dt = max(0.001, now - prev_t)
    rx_mbps = ((rx - prev_rx) * 8) / dt / 1000000
    tx_mbps = ((tx - prev_tx) * 8) / dt / 1000000
    total_mbps = rx_mbps + tx_mbps
usage = (total_mbps / limit_mbps * 100) if limit_mbps > 0 else 0
state = 'ok'
if limit_mbps > 0 and usage >= 90: state = 'critical'
elif limit_mbps > 0 and usage >= 70: state = 'warn'
old_rules = {int(r.get('id')): r for r in (status.get('rules') or []) if str(r.get('id','')).isdigit()}
items=[]
for r in data.get('rules',[]) or []:
    try:
        rid=int(r.get('id')); port=int(r.get('target_port'))
    except Exception:
        continue
    old=old_rules.get(rid,{})
    metrics=dict(old.get('metrics') or {})
    previous_bytes=int(metrics.get('bytes') or 0)
    previous_sample=float(metrics.get('sampledAtEpoch') or 0)
    current=get_counter(str(r.get('target_host','')), port)
    metrics.update(current)
    current_bytes=int(metrics.get('bytes') or 0)
    rule_dt=now-previous_sample if previous_sample > 0 else 0
    delta=max(0, current_bytes-previous_bytes) if current_bytes >= previous_bytes else 0
    metrics['rateMbps']=round((delta * 8) / rule_dt / 1000000, 3) if rule_dt > 0 else 0
    metrics['deltaBytes']=delta
    metrics['sampledAtEpoch']=now
    metrics['iptables'] = ipt_bin
    items.append({
        'id': rid,
        'node_id': r.get('node_id'),
        'bind_ip': r.get('bind_ip'),
        'target_host': r.get('target_host'),
        'target_port': port,
        'protocol': r.get('protocol','tcp'),
        'rewrite_enabled': bool(r.get('rewrite_enabled', True)),
        'status': old.get('status') or ('active' if status.get('ok') else 'pending'),
        'error': old.get('error') or '',
        'metrics': metrics
    })
status['rules'] = items
status['systemNetwork'] = {
    'rxBytes': rx,
    'txBytes': tx,
    'rxMbps': round(rx_mbps, 2),
    'txMbps': round(tx_mbps, 2),
    'totalMbps': round(total_mbps, 2),
    'limitMbps': limit_mbps,
    'usagePercent': round(usage, 1),
    'state': state,
    'sampledAtEpoch': now,
    'sampledAt': datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
}
status['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
status['backend'] = 'iptables-nft' if 'nft' in ipt_bin else 'iptables'
json.dump(status, open(status_path, 'w', encoding='utf-8'), ensure_ascii=False)
PYNET
}

write_host_ips() {
  mkdir -p "$DATA_DIR"
  if cmd_exists ip; then
    ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | awk 'BEGIN{printf "["} {printf "%s\"%s\"", sep, $0; sep=","} END{print "]"}' > "$HOST_IPS_FILE"
  else
    printf '[]\n' > "$HOST_IPS_FILE"
  fi
}

ipt_chain_exists() { local table="$1" chain="$2"; if [ "$table" = "filter" ]; then "$IPT" -S "$chain" >/dev/null 2>&1; else "$IPT" -t "$table" -S "$chain" >/dev/null 2>&1; fi; }

ensure_chain() {
  local table="$1" chain="$2"
  if [ "$table" = "filter" ]; then
    "$IPT" -N "$chain" 2>/dev/null || true
    "$IPT" -F "$chain" 2>/dev/null || true
  else
    "$IPT" -t "$table" -N "$chain" 2>/dev/null || true
    "$IPT" -t "$table" -F "$chain" 2>/dev/null || true
  fi
}

ensure_jump() {
  local table="$1" from="$2" chain="$3"
  if [ "$table" = "filter" ]; then
    "$IPT" -C "$from" -j "$chain" 2>/dev/null || "$IPT" -I "$from" 1 -j "$chain"
  else
    "$IPT" -t "$table" -C "$from" -j "$chain" 2>/dev/null || "$IPT" -t "$table" -I "$from" 1 -j "$chain"
  fi
}

remove_jump() {
  local table="$1" from="$2" chain="$3"
  if [ "$table" = "filter" ]; then
    while "$IPT" -C "$from" -j "$chain" 2>/dev/null; do "$IPT" -D "$from" -j "$chain" || break; done
  else
    while "$IPT" -t "$table" -C "$from" -j "$chain" 2>/dev/null; do "$IPT" -t "$table" -D "$from" -j "$chain" || break; done
  fi
}

clear_rules() {
  pick_iptables || { write_status false "iptables/iptables-nft not found"; return 1; }
  remove_jump nat PREROUTING "$CHAIN_NAT" || true
  remove_jump nat POSTROUTING "$CHAIN_POST" || true
  remove_jump filter FORWARD "$CHAIN_FWD" || true
  "$IPT" -t nat -F "$CHAIN_NAT" 2>/dev/null || true
  "$IPT" -t nat -X "$CHAIN_NAT" 2>/dev/null || true
  "$IPT" -t nat -F "$CHAIN_POST" 2>/dev/null || true
  "$IPT" -t nat -X "$CHAIN_POST" 2>/dev/null || true
  "$IPT" -F "$CHAIN_FWD" 2>/dev/null || true
  "$IPT" -X "$CHAIN_FWD" 2>/dev/null || true
  write_status true "Managed redirect rules cleared via $IPT"
}

apply_rules() {
  need_root
  mkdir -p "$DATA_DIR"
  write_host_ips
  if ! pick_iptables; then write_status false "iptables/iptables-nft not found"; exit 1; fi
  if [ ! -f "$RULES_FILE" ]; then clear_rules; write_status true "No redirect rules file"; return 0; fi
  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
  ensure_chain nat "$CHAIN_NAT"
  ensure_chain nat "$CHAIN_POST"
  ensure_chain filter "$CHAIN_FWD"
  ensure_jump nat PREROUTING "$CHAIN_NAT"
  ensure_jump nat POSTROUTING "$CHAIN_POST"
  ensure_jump filter FORWARD "$CHAIN_FWD"

  local tmp_script
  tmp_script="$(mktemp)"
  python3 - "$RULES_FILE" "$IPT" <<'PY' > "$tmp_script"
import json, shlex, sys, re
path, ipt = sys.argv[1:3]
try:
    data=json.load(open(path, encoding='utf-8'))
except Exception:
    data={'rules':[]}
for r in data.get('rules',[]) or []:
    try:
        bind=str(r.get('bind_ip','')).strip()
        target=str(r.get('target_host','')).strip()
        port=int(r.get('target_port'))
        proto=str(r.get('protocol','tcp')).lower()
    except Exception:
        continue
    # Safety guard: never let a stale/manual rules file hijack the panel ports.
    if port in (80, 443):
        continue
    if not re.match(r'^[0-9.]+$', bind) or not target or not (1 <= port <= 65535):
        continue
    protos=['tcp','udp'] if proto=='both' else [proto]
    for p in protos:
        if p not in ('tcp','udp'):
            continue
        q=shlex.quote
        print('{} -t nat -A AGG_REDIRECT -d {} -p {} --dport {} -j DNAT --to-destination {}:{}'.format(q(ipt), q(bind), p, port, q(target), port))
        print('{} -A AGG_REDIRECT_FWD -p {} -d {} --dport {} -j ACCEPT'.format(q(ipt), p, q(target), port))
        print('{} -A AGG_REDIRECT_FWD -p {} -s {} --sport {} -j ACCEPT'.format(q(ipt), p, q(target), port))
        print('{} -t nat -A AGG_REDIRECT_POST -p {} -d {} --dport {} -j MASQUERADE'.format(q(ipt), p, q(target), port))
PY
  bash "$tmp_script"
  local count
  count="$(grep -c "^$(printf '%s' "$IPT" | sed 's/[^^]/[&]/g; s/\^/\\^/g') " "$tmp_script" 2>/dev/null || true)"
  [ -n "$count" ] || count="0"
  rm -f "$tmp_script"
  write_apply_status true "Redirect rules applied, iptables commands: $count" "$count" "$IPT"
  refresh_runtime_status || true
}

status() {
  write_host_ips
  if [ -f "$STATUS_FILE" ]; then cat "$STATUS_FILE"; else write_status false "No status yet"; cat "$STATUS_FILE"; fi
}

loop() {
  need_root
  local last_hash=""
  while true; do
    write_host_ips
    local hash="none"
    [ -f "$RULES_FILE" ] && hash="$(sha256sum "$RULES_FILE" | awk '{print $1}')"
    if [ "$hash" != "$last_hash" ]; then
      if apply_rules; then :; else write_status false "Failed to apply redirect rules"; fi
      last_hash="$hash"
    else
      refresh_runtime_status || true
    fi
    sleep "$SLEEP_SEC"
  done
}

case "${1:-apply}" in
  apply) apply_rules ;;
  clear) need_root; clear_rules ;;
  status) status ;;
  ips) write_host_ips; cat "$HOST_IPS_FILE" ;;
  loop) loop ;;
  *) echo "Usage: $0 {apply|clear|status|ips|loop}" >&2; exit 2 ;;
esac
