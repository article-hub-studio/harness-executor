#!/usr/bin/env bash
# =============================================================
#  Harness Executor — selfhost installer 1 lệnh
#
#    curl -fsSL https://raw.githubusercontent.com/article-hub-studio/harness-executor/main/install.sh | bash
#
#  Hoạt động trên: Ubuntu/Debian · Fedora/Arch · macOS · Termux (chính điện thoại!)
#  Tuỳ chọn:  --port 8787   --dir ~/harness-executor   --service (systemd)   --daemon
# =============================================================
set -euo pipefail

REPO_URL="${UPIO_REPO:-https://github.com/article-hub-studio/harness-executor.git}"
PORT="${UPIO_PORT:-8787}"
DIR=""
MODE="run"          # run | daemon | service
BRANCH="main"

say()  { printf '\033[1m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- parse args ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --dir)     DIR="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --service) MODE="service"; shift ;;
    --daemon)  MODE="daemon"; shift ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Tham số không hiểu: $1 (xem --help)" ;;
  esac
done
DIR="${DIR:-$HOME/harness-executor}"
IS_TERMUX=false
case "${PREFIX:-}" in *com.termux*) IS_TERMUX=true ;; esac

banner() {
  cat <<'EOF'

   ██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗███████╗
   ██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝
   ███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗███████╗
   ██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║╚════██║
   ██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║███████║
   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝
              EXECUTOR · self-hosted MCP control plane
EOF
}

# ---------- 1. Node.js ≥20 ----------
need_node=true
if command -v node >/dev/null 2>&1; then
  V="$(node -v | sed 's/v//' | cut -d. -f1)"
  if [ "$V" -ge 20 ] 2>/dev/null; then need_node=false; ok "Node.js $(node -v) đã có"; fi
fi
if $need_node; then
  say "Cài đặt Node.js ≥20…"
  if $IS_TERMUX; then
    pkg install -y nodejs-lts || pkg install -y nodejs || die "pkg install nodejs thất bại"
  elif command -v apt-get >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != 0 ]; then SUDO=sudo; else SUDO=; fi
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 \
      || warn "nodesource setup lỗi — thử node của distro"
    $SUDO apt-get install -y nodejs >/dev/null 2>&1 \
      || { $SUDO apt-get update -y >/dev/null; $SUDO apt-get install -y nodejs npm >/dev/null; } \
      || die "apt cài Node thất bại — cài thủ công rồi chạy lại"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs || die "dnf thất bại"
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm nodejs || die "pacman thất bại"
  elif command -v brew >/dev/null 2>&1; then brew install node@22 || brew install node || die "brew thất bại"
  else
    # fallback binary tĩnh
    ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64 ;; aarch64|arm64) A=arm64 ;; *) die "Arch lạ: $ARCH" ;; esac
    NV="v22.11.0"
    say "Tải node ${NV} binary (${A})…"
    mkdir -p "$HOME/.local/opt"
    curl -fsSL "https://nodejs.org/dist/${NV}/node-${NV}-linux-${A}.tar.xz" -o /tmp/node.txz || die "tải node thất bại"
    tar -xJf /tmp/node.txz -C "$HOME/.local/opt"
    export PATH="$HOME/.local/opt/node-${NV}-linux-${A}/bin:$PATH"
  fi
  ok "Node.js $(node -v)"
fi

# ---------- 2. git ----------
if ! command -v git >/dev/null 2>&1; then
  say "Cài git…"
  if $IS_TERMUX; then pkg install -y git
  elif command -v apt-get >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != 0 ]; then SUDO=sudo; else SUDO=; fi
    $SUDO apt-get install -y git
  else die "Thiếu git — cài rồi chạy lại"; fi
fi

# ---------- 3. clone / update ----------
# Repo phải THẬT SỰ hợp lệ mới đi đường update; hỏng/dở thì xoá sạch clone lại
repo_ok() {
  [ -d "$DIR/.git" ] \
    && git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "$DIR" remote get-url origin >/dev/null 2>&1
}

safe_clone() {
  rm -rf "$DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DIR" --quiet || die "clone thất bại — kiểm tra mạng rồi chạy lại"
}

if repo_ok; then
  say "Cập nhật mã nguồn tại $DIR…"
  if ! ( git -C "$DIR" fetch origin "$BRANCH" --quiet \
         && git -C "$DIR" reset --hard "origin/$BRANCH" --quiet ); then
    warn "Repo hiện tại hỏng/không cập nhật được — tải lại từ đầu…"
    safe_clone
  fi
else
  if [ -d "$DIR" ]; then
    say "Thư mục $DIR có sẵn nhưng không phải repo hợp lệ — tải lại từ đầu…"
  else
    say "Clone repository vào $DIR …"
  fi
  safe_clone
fi
cd "$DIR"

# ---------- 4. dữ liệu (zero-dependency: không npm install!) ----------
if [ ! -s data/mcps.json ]; then
  say "Sinh registry Luau/LSP (10 MCP THẬT · 10 plugins · 13 skills)…"
  node scripts/generate-registries.js >/dev/null
fi
mkdir -p workspace mcp-servers

# ---------- 4b. binary luau-lsp cho MCP server bundled ----------
# luau-lsp là tiến trình THẬT mà server/mcp/luau-mcp bọc lại. Thiếu nó thì
# luau-mcp phải fallback sang `npx -y luau-lsp` (~40s mỗi lần gọi) — chậm không dùng được.
if command -v luau-lsp >/dev/null 2>&1; then
  ok "luau-lsp có sẵn ($(luau-lsp --version 2>/dev/null | head -1))"
elif command -v npm >/dev/null 2>&1; then
  say "Cài luau-lsp toàn cục (cho MCP server Luau)…"
  if npm i -g luau-lsp >/dev/null 2>&1; then
    ok "luau-lsp đã cài: $(luau-lsp --version 2>/dev/null | head -1)"
  else
    warn "không cài được luau-lsp — MCP luau-lsp sẽ chạy qua npx (chậm hơn nhiều)"
  fi
fi

# ---------- 5. chạy ----------
export PORT

# Phiên bản mã nguồn VỪA cập nhật trên đĩa (nguồn sự thật: package.json)
disk_version() {
  node -e 'try{process.stdout.write(require("./package.json").version||"")}catch(e){}' 2>/dev/null
}

# Đọc một field từ /api/status của tiến trình ĐANG CHẠY (rỗng nếu cổng không có harness)
status_field() {
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null \
    | FIELD="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.ok&&j[process.env.FIELD]!=null)process.stdout.write(String(j[process.env.FIELD]))}catch(e){}})' 2>/dev/null
}
running_version() { status_field version; }

# Mọi PID đang LISTEN cổng $PORT (không xét thư mục)
port_pids() {
  local pids=""
  if command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
  fi
  [ -z "$pids" ] && command -v lsof >/dev/null 2>&1 && pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
  [ -z "$pids" ] && command -v fuser >/dev/null 2>&1 && pids=$(fuser -n tcp "$PORT" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$')
  echo "$pids"
}

# Thư mục làm việc của một PID (bỏ hậu tố " (deleted)" khi thư mục bị clone lại)
pid_cwd() {
  local cwd
  cwd=$(readlink "/proc/$1/cwd" 2>/dev/null || true)
  [ -z "$cwd" ] && cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  echo "${cwd% (deleted)}"
}

# PID đang LISTEN cổng $PORT VÀ có cwd đúng $DIR — để không bao giờ giết nhầm
# tiến trình khác của người dùng.
port_pid_in_dir() {
  local p cwd want
  want=$(readlink -f "$DIR" 2>/dev/null || echo "$DIR")
  for p in $(port_pids); do
    cwd=$(pid_cwd "$p")
    if [ "$cwd" = "$want" ] || [ "$cwd" = "$DIR" ]; then echo "$p"; return 0; fi
  done
  return 0
}

# Dừng bản đang chạy trong $DIR (systemd → pid do server tự báo → pid file → PID giữ cổng).
# KHÔNG dùng pkill theo tên tiến trình vì lệnh đó giết cả instance khác ngoài $DIR.
# BẤT BIẾN: chỉ kill PID vừa giữ cổng $PORT vừa thuộc $DIR — nếu không thoả thì bỏ,
# vì kill sai sẽ hạ một server đang phục vụ cổng khác (hoặc app khác của người dùng).
stop_running() {
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user is-active harness.service >/dev/null 2>&1; then
    say "Khởi động lại systemd service…"
    systemctl --user restart harness.service && return 0
  fi

  local listening pid="" cand srv_root want cwd
  listening=$(port_pids)
  want=$(readlink -f "$DIR" 2>/dev/null || echo "$DIR")

  # Ứng viên theo thứ tự tin cậy: server tự báo pid (v1.3.0+) → pid file → dò cổng
  srv_root=$(status_field rootDir)
  for cand in "$(status_field pid)" "$(cat "$DIR/harness.pid" 2>/dev/null || true)" "$(port_pid_in_dir)"; do
    [ -z "$cand" ] && continue
    kill -0 "$cand" 2>/dev/null || continue
    # (a) phải đang giữ đúng cổng $PORT
    echo "$listening" | tr ' ' '\n' | grep -qx "$cand" || continue
    # (b) phải thuộc đúng $DIR (ưu tiên rootDir do server tự báo, sau đó cwd)
    if [ -n "$srv_root" ] && [ "$srv_root" != "$want" ] && [ "$srv_root" != "$DIR" ]; then continue; fi
    cwd=$(pid_cwd "$cand")
    if [ -n "$cwd" ] && [ "$cwd" != "$want" ] && [ "$cwd" != "$DIR" ] && [ -z "$srv_root" ]; then continue; fi
    pid="$cand"; break
  done

  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
    ok "Đã dừng tiến trình cũ (PID $pid)"
    return 0
  fi
  warn "Không tìm được tiến trình harness của $DIR đang giữ cổng $PORT — không kill gì cả"
  return 1
}

RUN_VER="$(running_version)"
DISK_VER="$(disk_version)"

if [ -n "$RUN_VER" ]; then
  if [ -n "$DISK_VER" ] && [ "$RUN_VER" != "$DISK_VER" ]; then
    # Đây là ĐƯỜNG UPDATE: mã nguồn đã git pull sang bản mới nhưng tiến trình cũ
    # vẫn giữ code cũ trong RAM → phải restart, nếu không người dùng "update" mà
    # vẫn thấy bản cũ.
    say "Đang chạy v$RUN_VER · mã nguồn đã cập nhật v$DISK_VER → khởi động lại…"
    if stop_running; then
      # systemd tự bật lại: xác nhận rồi thoát
      if command -v systemctl >/dev/null 2>&1 \
         && systemctl --user is-active harness.service >/dev/null 2>&1; then
        sleep 3
        ok "Service đã chạy lại ở v$(running_version)"
        exit 0
      fi
    else
      die "Không giải phóng được cổng $PORT — dừng thủ công rồi chạy lại lệnh cài"
    fi
    # rơi xuống phần khởi động bên dưới với code mới
  else
    ok "Harness Executor v$RUN_VER ĐANG CHẠY SẴN ở cổng $PORT — không khởi động trùng."
    echo "   ✓ Mở APK là tự kết nối ngay."
    echo "   Muốn khởi động lại: chạy lại lệnh cài sau khi có bản mới, hoặc"
    echo "     kill \$(cat $DIR/harness.pid 2>/dev/null) && chạy lại lệnh cài"
    exit 0
  fi
fi

# Termux: giữ CPU thức dậy để Android không giết server khi thu nhỏ/tắt màn
if $IS_TERMUX && command -v termux-wake-lock >/dev/null 2>&1; then
  say "Giữ wake-lock (chống Android kill tiến trình)…"
  termux-wake-lock 2>/dev/null || warn "không đặt được wake-lock — đừng vuốt tắt app Termux"
fi
LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -3 || true)

case "$MODE" in
  service)
    say "Tạo systemd user service…"
    mkdir -p "$HOME/.config/systemd/user"
    NODE_BIN="$(command -v node)"
    cat > "$HOME/.config/systemd/user/harness.service" <<EOF
[Unit]
Description=Harness Executor (MCP control plane)
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=3
Environment=PORT=$PORT

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now harness.service
    ok "Service đang chạy — quản lý bằng: systemctl --user status harness"
    ;;
  daemon)
    say "Khởi động nền (nohup)…"
    nohup node server/index.js > "$DIR/harness.log" 2>&1 &
    echo $! > "$DIR/harness.pid"
    sleep 2
    PID_N="$(cat "$DIR/harness.pid")"
    if kill -0 "$PID_N" 2>/dev/null; then
      ok "PID $PID_N · log: tail -f $DIR/harness.log"
      sleep 4
      if kill -0 "$PID_N" 2>/dev/null; then
        ok "Server vẫn sống sau 6s — tốt."
      else
        warn "Server tít sau khi installer thoát (Android/Termux kill?) — xem: tail -20 $DIR/harness.log"
        tail -20 "$DIR/harness.log" 2>/dev/null | sed 's/^/      │ /'
      fi
    else
      die "Node chết ngay — xem log: tail -20 $DIR/harness.log"
    fi
    ;;
  *)
    banner
    ;;
esac

echo ""
ok  "Harness Executor sẵn sàng!"
echo "   ┌─ Mở trên điện thoại / APK (cùng Wi-Fi):"
$([ -n "$LAN_IPS" ]) && for ip in $LAN_IPS; do echo "   │    http://$ip:$PORT"; done
echo "   ├─ Trên CHÍNH máy này:  http://localhost:$PORT"
if $IS_TERMUX; then
  echo "   └─ APK cài trên máy này sẽ tự tìm thấy ở 127.0.0.1:$PORT"
  echo "      ⚠ ĐỪNG vuốt tắt Termux — đã bật wake-lock nhưng Android vẫn có thể kill"
else
  echo "   └─ Dừng (Ctrl+C) hoặc: systemctl --user stop harness"
fi
echo ""
[ "$(basename "$0")" = "install.sh" ] && [ "$MODE" = "run" ] && exec node server/index.js
