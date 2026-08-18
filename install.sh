#!/usr/bin/env bash
set -Eeuo pipefail

INSTANCE_NAME="${AGG_INSTANCE:-${INSTANCE_NAME:-default}}"
APP_DIR="${APP_DIR:-/opt/3xui-aggregator}"
REPO_URL_DEFAULT="https://github.com/dagmagnat/Nexus-Panel.git"
BRANCH_DEFAULT="main"

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
BLUE='\033[1;34m'
MAGENTA='\033[1;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

NEXUS_UI_ACTIVE=0
NEXUS_UI_ANIMATE=0
NEXUS_UI_STEP=0
NEXUS_UI_ERROR_SHOWN=0
NEXUS_UI_LAST_STEP_LOG=""
NEXUS_UI_LOG_FILE=""
NEXUS_UI_LOG_DIR=""

ENV_FILE="$APP_DIR/.env"
INSTALL_CONF="$APP_DIR/.install.conf"
BACKUP_DIR="/opt/3xui-backups"
SHORTCUT_BIN="/usr/local/bin/agg"
SOURCE_CONF="/etc/3xui-aggregator-source.conf"
AGG_CONTAINER_NAME="3xui-aggregator"
CADDY_CONTAINER_NAME="3xui-aggregator-caddy"
COMPOSE_PROJECT_NAME="3xui-aggregator"
FORWARDER_SERVICE_NAME="3xui-aggregator-forwarder"
UPDATER_SERVICE_NAME="3xui-aggregator-web-updater"
INSTALLER_RAW_URL_DEFAULT="https://raw.githubusercontent.com/dagmagnat/Nexus-Panel/main/install.sh"
REPO_URL="${REPO_URL_DEFAULT}"
BRANCH="${BRANCH_DEFAULT}"
INSTALLER_RAW_URL="${INSTALLER_RAW_URL_DEFAULT}"

say() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
err() { echo -e "${RED}$*${NC}"; }
info() { echo -e "${CYAN}$*${NC}"; }

ui_init() {
  [ "$NEXUS_UI_ACTIVE" = "1" ] && return 0
  NEXUS_UI_ACTIVE=1

  local stamp log_root
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  log_root="${NEXUS_INSTALLER_LOG_DIR:-/var/log/nexus-panel}"
  NEXUS_UI_LOG_DIR="$log_root/install-$stamp-$$"
  NEXUS_UI_LOG_FILE="$log_root/install-$stamp-$$.log"
  mkdir -p "$NEXUS_UI_LOG_DIR"
  : > "$NEXUS_UI_LOG_FILE"
  chmod 700 "$NEXUS_UI_LOG_DIR" 2>/dev/null || true
  chmod 600 "$NEXUS_UI_LOG_FILE" 2>/dev/null || true

  # Даже если stdout направлен в tee, stdin и /dev/tty остаются терминалом.
  # Поэтому анимация видна пользователю, а обычный текст сохраняется в журнал.
  if [ "${NEXUS_INSTALLER_PLAIN:-0}" != "1" ] && [ -t 0 ] && [ -w /dev/tty ]; then
    # Редирект stderr должен действовать только на попытку открыть fd 9.
    # `exec 9>/dev/tty 2>/dev/null` без группы навсегда отправлял stderr всего
    # установщика в /dev/null: меню и приглашение ввода становились невидимыми.
    if { exec 9>/dev/tty; } 2>/dev/null; then
      NEXUS_UI_ANIMATE=1
    fi
  fi
}

ui_banner() {
  ui_init
  printf '\n'
  printf "${CYAN}        ╭──────────────────────────────────────╮${NC}\n"
  printf "${CYAN}        │${NC} ${MAGENTA}◆${NC}  ${BOLD}N E X U S   P A N E L${NC}           ${CYAN}│${NC}\n"
  printf "${CYAN}        │${NC}    ${DIM}Spectrum installer · safe deploy${NC}    ${CYAN}│${NC}\n"
  printf "${CYAN}        ╰──────────────────────────────────────╯${NC}\n"
  printf "${DIM}        Клиенты, UUID, ссылки и data сохраняются${NC}\n\n"
  printf 'Nexus Panel installer started: %s\n' "$(date -Is)" >> "$NEXUS_UI_LOG_FILE"
}

ui_section() {
  local title="$1"
  printf '\n'
  printf "${BLUE}  ┌─ ${BOLD}%s${NC}\n" "$title"
}

ui_step_success() {
  local number="$1" label="$2" elapsed="$3"
  printf "${GREEN}  ✓${NC} ${DIM}%02d${NC}  %-48s ${DIM}%ss${NC}\n" "$number" "$label" "$elapsed"
}

ui_error_hint() {
  local source="${1:-}"
  if grep -Eqi 'could not get lock|unable to acquire.*lock|dpkg frontend lock' "$source" 2>/dev/null; then
    printf '  │  Пояснение: apt/dpkg занят другим обновлением. Дождись его завершения и повтори команду.\n' >&2
  elif grep -Eqi 'no space left|disk quota exceeded' "$source" 2>/dev/null; then
    printf '  │  Пояснение: на диске закончилось место. Освободи место (особенно /var/lib/docker) и повтори установку.\n' >&2
  elif grep -Eqi 'could not resolve|temporary failure in name resolution|name or service not known' "$source" 2>/dev/null; then
    printf '  │  Пояснение: сервер не может разрешить DNS-имя. Проверь DNS и доступ в интернет.\n' >&2
  elif grep -Eqi 'connection refused|connection timed out|operation timed out|network is unreachable' "$source" 2>/dev/null; then
    printf '  │  Пояснение: сетевое соединение недоступно. Проверь firewall, маршрут и доступ VPS в интернет.\n' >&2
  elif grep -Eqi 'address already in use|port .*already|bind.*failed' "$source" 2>/dev/null; then
    printf '  │  Пояснение: требуемый порт уже занят. Посмотри владельца порта командой ss -ltnp.\n' >&2
  elif grep -Eqi 'permission denied|must be run as root|run as root' "$source" 2>/dev/null; then
    printf '  │  Пояснение: не хватает прав. Запусти команду после sudo -i.\n' >&2
  elif grep -Eqi 'docker daemon|cannot connect to the docker|failed to start docker' "$source" 2>/dev/null; then
    printf '  │  Пояснение: Docker не запущен или повреждён. Проверь systemctl status docker.\n' >&2
  else
    printf '  │  Пояснение: этап завершился ненулевым кодом. Точная причина находится в строках ниже и полном журнале.\n' >&2
  fi
}

ui_step_failure() {
  local number="$1" label="$2" status="$3" step_log="$4"
  NEXUS_UI_ERROR_SHOWN=1
  printf "${RED}  ✕ %02d  %s${NC} ${DIM}(код %s)${NC}\n" "$number" "$label" "$status" >&2
  printf "${RED}  ├─ Ошибка команды. Последние строки:${NC}\n" >&2
  ui_error_hint "$step_log"
  if [ -s "$step_log" ]; then
    tail -n "${NEXUS_INSTALLER_ERROR_LINES:-80}" "$step_log" | sed 's/^/  │  /' >&2
  else
    printf '  │  Команда завершилась без диагностического вывода.\n' >&2
  fi
  printf "${RED}  └─ Полный журнал: %s${NC}\n" "$NEXUS_UI_LOG_FILE" >&2
}

ui_run() {
  local label="$1"
  shift
  ui_init
  NEXUS_UI_STEP=$((NEXUS_UI_STEP + 1))
  NEXUS_UI_ERROR_SHOWN=0

  local number step_log start now elapsed pid status frame_index
  local -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  number="$NEXUS_UI_STEP"
  step_log="$NEXUS_UI_LOG_DIR/step-$(printf '%02d' "$number").log"
  NEXUS_UI_LAST_STEP_LOG="$step_log"
  start="$(date +%s)"
  frame_index=0

  {
    printf '\n===== STEP %02d: %s =====\n' "$number" "$label"
    printf 'Started: %s\n' "$(date -Is)"
  } >> "$NEXUS_UI_LOG_FILE"

  # Служебные шаги всегда неинтерактивны. Без явного /dev/null некоторые
  # команды наследуют SSH-терминал и ждут Enter, хотя вопроса на экране нет.
  "$@" </dev/null > "$step_log" 2>&1 &
  pid=$!

  if [ "$NEXUS_UI_ANIMATE" = "1" ]; then
    while kill -0 "$pid" 2>/dev/null; do
      now="$(date +%s)"
      elapsed=$((now - start))
      printf '\r\033[2K%s  %s %02d  %s · %ss%s' "$CYAN" "${frames[$frame_index]}" "$number" "$label" "$elapsed" "$NC" >&9
      frame_index=$(((frame_index + 1) % ${#frames[@]}))
      sleep 0.12
    done
    printf '\r\033[2K' >&9
  else
    printf "${CYAN}  …${NC} ${DIM}%02d${NC}  %s\n" "$number" "$label"
    while kill -0 "$pid" 2>/dev/null; do
      sleep 0.2
      now="$(date +%s)"
      elapsed=$((now - start))
      if [ "$elapsed" -gt 0 ] && [ $((elapsed % 15)) -eq 0 ] && [ "${NEXUS_UI_LAST_REPORT:-}" != "$elapsed" ]; then
        printf "${DIM}      всё ещё выполняется · %ss${NC}\n" "$elapsed"
        NEXUS_UI_LAST_REPORT="$elapsed"
      fi
    done
  fi

  if wait "$pid"; then
    status=0
  else
    status=$?
  fi
  now="$(date +%s)"
  elapsed=$((now - start))
  cat "$step_log" >> "$NEXUS_UI_LOG_FILE"
  printf 'Finished: %s (status=%s)\n' "$(date -Is)" "$status" >> "$NEXUS_UI_LOG_FILE"

  if [ "$status" -eq 0 ]; then
    ui_step_success "$number" "$label" "$elapsed"
    return 0
  fi

  ui_step_failure "$number" "$label" "$status" "$step_log"
  return "$status"
}

ui_unhandled_error() {
  local status="${1:-1}" line="${2:-?}"
  [ "$status" -ne 0 ] || return 0
  [ "$NEXUS_UI_ERROR_SHOWN" = "1" ] && return 0
  NEXUS_UI_ERROR_SHOWN=1
  set +e
  printf '\n'
  printf "${RED}  ╭─ Установка остановлена${NC}\n" >&2
  printf "${RED}  │  Код ошибки: %s · строка install.sh: %s${NC}\n" "$status" "$line" >&2
  if [ -n "$NEXUS_UI_LAST_STEP_LOG" ] && [ -s "$NEXUS_UI_LAST_STEP_LOG" ]; then
    ui_error_hint "$NEXUS_UI_LAST_STEP_LOG"
    printf "${RED}  │  Последние строки:${NC}\n" >&2
    tail -n "${NEXUS_INSTALLER_ERROR_LINES:-80}" "$NEXUS_UI_LAST_STEP_LOG" | sed 's/^/  │  /' >&2
  fi
  if [ -n "$NEXUS_UI_LOG_FILE" ]; then
    printf "${RED}  ╰─ Журнал: %s${NC}\n" "$NEXUS_UI_LOG_FILE" >&2
  else
    printf "${RED}  ╰─ Проверь вывод выше.${NC}\n" >&2
  fi
}

ui_install_error_trap() {
  trap 'ui_unhandled_error "$?" "$LINENO"' ERR
}

maybe_clear_screen() {
  # По умолчанию сохраняем журнал терминала: при установке через SSH ошибки
  # curl/apt должны оставаться видимыми. Очистку можно включить явно.
  if [ "${NEXUS_INSTALLER_CLEAR:-0}" = "1" ] && [ -t 1 ]; then
    clear || true
  fi
}

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    err "Запусти установку от root: sudo -i"
    exit 1
  fi
}

ask() {
  local prompt="$1"
  local default="${2-}"
  local value
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " value || true
    value="${value//$'\r'/}"
    echo "${value:-$default}"
  else
    read -r -p "$prompt: " value || true
    value="${value//$'\r'/}"
    echo "$value"
  fi
}

ask_secret_optional() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt: " value || true
  echo
  value="${value//$'\r'/}"
  echo "$value"
}

trim() {
  local var="$1"
  var="${var//$'\r'/}"
  var="${var#\"${var%%[![:space:]]*}\"}"
  var="${var%\"${var##*[![:space:]]}\"}"
  echo "$var"
}


sanitize_instance_name() {
  local value
  value="$(trim "${1:-default}")"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+|-+$//g')"
  [ -n "$value" ] || value="default"
  echo "$value"
}

refresh_runtime_paths() {
  INSTANCE_NAME="$(sanitize_instance_name "${INSTANCE_NAME:-default}")"
  if [ "$INSTANCE_NAME" = "default" ]; then
    if [ -z "${APP_DIR:-}" ]; then APP_DIR="/opt/3xui-aggregator"; fi
    SOURCE_CONF="/etc/3xui-aggregator-source.conf"
    COMPOSE_PROJECT_NAME="3xui-aggregator"
    AGG_CONTAINER_NAME="3xui-aggregator"
    CADDY_CONTAINER_NAME="3xui-aggregator-caddy"
    FORWARDER_SERVICE_NAME="3xui-aggregator-forwarder"
UPDATER_SERVICE_NAME="3xui-aggregator-web-updater"
  else
    APP_DIR="/opt/3xui-aggregator-${INSTANCE_NAME}"
    SOURCE_CONF="/etc/3xui-aggregator-${INSTANCE_NAME}-source.conf"
    COMPOSE_PROJECT_NAME="3xui-aggregator-${INSTANCE_NAME}"
    AGG_CONTAINER_NAME="3xui-aggregator-${INSTANCE_NAME}"
    CADDY_CONTAINER_NAME="3xui-aggregator-${INSTANCE_NAME}-caddy"
    FORWARDER_SERVICE_NAME="3xui-aggregator-${INSTANCE_NAME}-forwarder"
    UPDATER_SERVICE_NAME="3xui-aggregator-${INSTANCE_NAME}-web-updater"
  fi
  ENV_FILE="$APP_DIR/.env"
  INSTALL_CONF="$APP_DIR/.install.conf"
}

set_instance_context() {
  INSTANCE_NAME="$(sanitize_instance_name "${1:-default}")"
  if [ "$INSTANCE_NAME" = "default" ]; then APP_DIR="/opt/3xui-aggregator"; else APP_DIR="/opt/3xui-aggregator-${INSTANCE_NAME}"; fi
  refresh_runtime_paths
}

prompt_instance_for_new_install() {
  echo
  say "Экземпляр панели:"
  warn "Для нескольких панелей на одном сервере используй разные имена экземпляров и разные IP привязки Caddy."
  warn "default = /opt/3xui-aggregator. Примеры: project1, panel2, shop-a."
  local value
  value="$(ask 'Имя экземпляра' "${INSTANCE_NAME:-default}")"
  set_instance_context "$value"
  if [ -d "$APP_DIR" ] && [ -f "$ENV_FILE" ]; then
    warn "Экземпляр $INSTANCE_NAME уже существует: $APP_DIR"
  fi
}

validate_domain() {
  local domain="$1"
  domain="$(trim "$domain")"
  if ! printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$'; then
    err "Домен введён некорректно: $domain"
    exit 1
  fi
}

validate_email() {
  local email="$1"
  email="$(trim "$email")"

  if ! printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    err "Email введён некорректно."
    exit 1
  fi
}


is_valid_domain() {
  local domain
  domain="$(trim "$1")"
  printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$'
}

is_valid_email() {
  local email
  email="$(trim "$1")"
  printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
}

is_valid_ipv4() {
  local ip
  ip="$(trim "$1")"
  printf '%s' "$ip" | awk -F. '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
      }
      exit 0
    }
  '
}

ask_choice_loop() {
  local prompt="$1"
  local default="$2"
  local allowed="$3"
  local value
  while true; do
    value="$(ask "$prompt" "$default")"
    value="$(trim "$value")"
    case " $allowed " in
      *" $value "*) echo "$value"; return 0 ;;
    esac
    err "Неверный выбор: $value"
    warn "Допустимые варианты: $allowed"
  done
}

ask_port_loop() {
  local prompt="$1"
  local default="$2"
  local value
  while true; do
    value="$(ask "$prompt" "$default")"
    value="$(trim "$value")"
    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
      if [ "$value" = "80" ] || [ "$value" = "443" ]; then
        err "Порты 80 и 443 зарезервированы под вход в панель/Caddy. Выбери другой порт."
        continue
      fi
      echo "$value"
      return 0
    fi
    err "Порт должен быть числом от 1 до 65535."
  done
}

ask_domain_loop() {
  local prompt="$1"
  local default="${2:-}"
  local value
  while true; do
    value="$(ask "$prompt" "$default")"
    value="$(trim "$value")"
    if [ -n "$value" ] && is_valid_domain "$value"; then
      echo "$value"
      return 0
    fi
    err "Домен введён некорректно. Пример: example.com"
  done
}

ask_email_loop() {
  local prompt="$1"
  local default="${2:-}"
  local value
  while true; do
    value="$(ask "$prompt" "$default")"
    value="$(trim "$value")"
    if [ -n "$value" ] && is_valid_email "$value"; then
      echo "$value"
      return 0
    fi
    err "Email введён некорректно. Пример: admin@example.com"
  done
}

port_in_use() {
  local port="$1"
  local bind_ip="${2:-${BIND_IP:-}}"

  if [ -z "$bind_ip" ]; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
    return $?
  fi

  ss -ltnH 2>/dev/null | awk -v port=":${port}" -v bind_ip="$bind_ip" '
    {
      addr = $4
      if (addr !~ port "$") next
      host = addr
      sub(port "$", "", host)
      gsub(/^\[/, "", host)
      gsub(/\]$/, "", host)
      if (host == bind_ip || host == "0.0.0.0" || host == "*" || host == "::") found = 1
    }
    END { exit found ? 0 : 1 }
  '
}

check_domain_ports_if_needed() {
  local need_80_443="0"

  if [ "${PANEL_MODE}" = "domain" ] || [ "${SUB_MODE}" = "domain" ]; then
    need_80_443="1"
  fi

  if [ "$need_80_443" != "1" ]; then
    return
  fi

  local bad=0

  if port_in_use 80; then
    err "Порт 80 уже занят. Для обычного доменного режима через встроенный Caddy он должен быть свободен."
    bad=1
  fi

  if port_in_use 443; then
    err "Порт 443 уже занят. Для обычного доменного режима через встроенный Caddy он должен быть свободен."
    bad=1
  fi

  if [ "$bad" -ne 1 ]; then
    return
  fi

  warn "На этом сервере уже заняты 80/443. Обычно это значит, что их использует 3x-ui, другой Caddy/Nginx/Apache или xray."
  warn "Кто держит порты:"
  ss -ltnp 2>/dev/null | grep -E '(:80 |:443 )' || true
  echo
  warn "Обычный доменный режим не будет запущен, чтобы не мешать уже работающей панели."
  say "Что сделать дальше:"
  say "1 - Переключить агрегатор на IP + порт и продолжить"
  say "2 - Переключить агрегатор на домен + выбранный порт и продолжить"
  say "0 - Остановить установку"

  local choice
  choice="$(ask_choice_loop 'Выбор' '1' '0 1 2')"

  case "$choice" in
    1)
      PANEL_MODE="ip"
      SUB_MODE="ip"
      PANEL_DOMAIN=""
      SUB_DOMAIN=""
      PANEL_EMAIL=""
      BIND_IP=""
      local default_ip
      default_ip="${PANEL_IP:-$(get_public_server_ip)}"
      PANEL_IP="$(ask 'IP для панели' "$default_ip")"
      PANEL_IP="$(trim "$PANEL_IP")"
      SUB_IP="$PANEL_IP"
      SUB_PUBLIC_URL=""
      ;;
    2)
      PANEL_MODE="domain_port"
      SUB_MODE="domain_port"
      PANEL_EMAIL=""
      if [ -z "${PANEL_DOMAIN:-}" ]; then
        PANEL_DOMAIN="$(ask_domain_loop 'Домен для панели' '')"
      fi
      SUB_DOMAIN="$PANEL_DOMAIN"
      SUB_PUBLIC_URL="https://${PANEL_DOMAIN}:${APP_PORT}"
      SUB_URL_MODE="custom"
      ;;
    0)
      warn "Установка остановлена. Проект не был удалён из-за занятого 80/443."
      exit 1
      ;;
  esac
}

ensure_dir() {
  mkdir -p "$APP_DIR"
  mkdir -p "$APP_DIR/data"
  mkdir -p "$BACKUP_DIR"
}


load_source_config() {
  REPO_URL="${REPO_URL_DEFAULT}"
  BRANCH="${BRANCH_DEFAULT}"
  INSTALLER_RAW_URL="${INSTALLER_RAW_URL_DEFAULT}"

  if [ -f "$SOURCE_CONF" ]; then
    # shellcheck disable=SC1090
    source "$SOURCE_CONF"
  fi

  if [ -f "$APP_DIR/.source.conf" ]; then
    # shellcheck disable=SC1090
    source "$APP_DIR/.source.conf"
  fi

  REPO_URL="${REPO_URL:-$REPO_URL_DEFAULT}"
  BRANCH="${BRANCH:-$BRANCH_DEFAULT}"
  INSTALLER_RAW_URL="${INSTALLER_RAW_URL:-$INSTALLER_RAW_URL_DEFAULT}"

  # Stage109: перенести только прежний официальный адрес. Пользовательские fork
  # остаются нетронутыми и продолжают обновляться из своего источника.
  case "${REPO_URL%/}" in
    "https://github.com/dagmagnat/3xui-Aggregator"|"https://github.com/dagmagnat/3xui-Aggregator.git"|"https://github.com/dagmagnat/3xui-aggregator"|"https://github.com/dagmagnat/3xui-aggregator.git")
      REPO_URL="$REPO_URL_DEFAULT"
      ;;
  esac
  case "${INSTALLER_RAW_URL%/}" in
    "https://raw.githubusercontent.com/dagmagnat/3xui-Aggregator/main/install.sh"|"https://raw.githubusercontent.com/dagmagnat/3xui-aggregator/main/install.sh")
      INSTALLER_RAW_URL="$INSTALLER_RAW_URL_DEFAULT"
      ;;
  esac
}

save_source_config() {
  cat > "$SOURCE_CONF" <<EOF
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
INSTALLER_RAW_URL=${INSTALLER_RAW_URL}
AGG_INSTANCE=${INSTANCE_NAME}
EOF

  if [ -d "$APP_DIR" ]; then
    cat > "$APP_DIR/.source.conf" <<EOF
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
INSTALLER_RAW_URL=${INSTALLER_RAW_URL}
AGG_INSTANCE=${INSTANCE_NAME}
EOF
  fi
}

load_existing_config() {
  APP_PORT="${APP_PORT:-3000}"
  ADMIN_USER="${ADMIN_USER:-admin}"
  ADMIN_PASS="${ADMIN_PASS:-}"
  APP_SECRET_VALUE="${APP_SECRET_VALUE:-}"
  SESSION_SECRET_VALUE="${SESSION_SECRET_VALUE:-}"
  PANEL_PUBLIC_URL="${PANEL_PUBLIC_URL:-}"
  SUB_PUBLIC_URL="${SUB_PUBLIC_URL:-}"
  SUB_URL_MODE="${SUB_URL_MODE:-custom}"
  local had_env_file=0

  if [ -f "$ENV_FILE" ]; then
    had_env_file=1
    while IFS='=' read -r key value; do
      [ -z "$key" ] && continue
      case "$key" in
        PORT) APP_PORT="$value" ;;
        ADMIN_USERNAME) ADMIN_USER="$value" ;;
        ADMIN_PASSWORD) ADMIN_PASS="$value" ;;
        APP_SECRET) APP_SECRET_VALUE="$value" ;;
        SESSION_SECRET) SESSION_SECRET_VALUE="$value" ;;
        PANEL_PUBLIC_URL) PANEL_PUBLIC_URL="$value" ;;
        SUB_PUBLIC_URL) SUB_PUBLIC_URL="$value" ;;
        SUB_URL_MODE) SUB_URL_MODE="$value" ;;
        INSTALL_BIND_IP) BIND_IP="$value" ;;
      esac
    done < <(grep -E '^(PORT|ADMIN_USERNAME|ADMIN_PASSWORD|APP_SECRET|SESSION_SECRET|PANEL_PUBLIC_URL|SUB_PUBLIC_URL|SUB_URL_MODE|INSTALL_BIND_IP)=' "$ENV_FILE" || true)
  fi


  if [ -f "$INSTALL_CONF" ]; then
    # shellcheck disable=SC1090
    source "$INSTALL_CONF"
  fi

  PANEL_MODE="${PANEL_MODE:-ip}"
  PANEL_DOMAIN="${PANEL_DOMAIN:-}"
  PANEL_IP="${PANEL_IP:-}"
  PANEL_EMAIL="${PANEL_EMAIL:-}"

  SUB_MODE="${SUB_MODE:-$PANEL_MODE}"
  SUB_DOMAIN="${SUB_DOMAIN:-}"
  SUB_IP="${SUB_IP:-}"
  BIND_IP="${BIND_IP:-}"
}

save_install_conf() {
  cat > "$INSTALL_CONF" <<EOF
PANEL_MODE=${PANEL_MODE}
PANEL_DOMAIN=${PANEL_DOMAIN}
PANEL_IP=${PANEL_IP}
PANEL_EMAIL=${PANEL_EMAIL}
SUB_MODE=${SUB_MODE}
SUB_DOMAIN=${SUB_DOMAIN}
SUB_IP=${SUB_IP}
SUB_URL_MODE=${SUB_URL_MODE}
BIND_IP=${BIND_IP}
APP_PORT=${APP_PORT}
INSTANCE_NAME=${INSTANCE_NAME}
AGG_CONTAINER_NAME=${AGG_CONTAINER_NAME}
CADDY_CONTAINER_NAME=${CADDY_CONTAINER_NAME}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
UPDATER_SERVICE_NAME=${UPDATER_SERVICE_NAME}
EOF
}

write_env_file() {
  if [ -z "${APP_SECRET_VALUE:-}" ]; then
    APP_SECRET_VALUE="$(openssl rand -hex 32)"
  fi

  if [ -z "${SESSION_SECRET_VALUE:-}" ]; then
    SESSION_SECRET_VALUE="$(openssl rand -hex 32)"
  fi

  local trust_proxy_value="0"
  local session_secure_value="0"
  if [ "${PANEL_MODE}" = "domain" ] || [ "${PANEL_MODE}" = "domain_port" ]; then
    trust_proxy_value="1"
    session_secure_value="1"
  fi

  ADMIN_USER="$(printf '%s' "$ADMIN_USER" | tr -d '\r\n')"
  ADMIN_PASS="$(printf '%s' "$ADMIN_PASS" | tr -d '\r\n')"

  cat > "$ENV_FILE" <<EOF
PORT=${APP_PORT}
APP_SECRET=${APP_SECRET_VALUE}
SESSION_SECRET=${SESSION_SECRET_VALUE}
TRUST_PROXY=${trust_proxy_value}
SESSION_SECURE=${session_secure_value}
ADMIN_USERNAME=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASS}
BASE_URL=${SUB_PUBLIC_URL}
PANEL_PUBLIC_URL=${PANEL_PUBLIC_URL}
SUB_PUBLIC_URL=${SUB_PUBLIC_URL}
SUB_URL_MODE=${SUB_URL_MODE:-custom}
INSTALL_BIND_IP=${BIND_IP:-}
APP_DIR=${APP_DIR}
BACKUP_DIR=${BACKUP_DIR}
INSTANCE_NAME=${INSTANCE_NAME}
AGG_CONTAINER_NAME=${AGG_CONTAINER_NAME}
CADDY_CONTAINER_NAME=${CADDY_CONTAINER_NAME}
NODE_ENV=production
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}
NPM_INSTALL_TIMEOUT=${NPM_INSTALL_TIMEOUT:-420}
NPM_FALLBACK_REGISTRY=${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
NPM_FETCH_TIMEOUT=${NPM_FETCH_TIMEOUT:-60000}
NPM_FETCH_RETRIES=${NPM_FETCH_RETRIES:-2}
EOF
  chmod 600 "$ENV_FILE"
}

install_packages() {
  ui_run "Обновление списка пакетов" apt-get update -y
  ui_run "Установка системных компонентов" env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y ca-certificates curl git lsb-release openssl \
    apt-transport-https software-properties-common iproute2 iptables nftables \
    netcat-openbsd python3 openssh-server sudo
}

install_vpn_local_ssh_access() {
  # Отдельный непривилегированный пользователь позволяет контейнеру управлять
  # WireGuard/AWG/Outline на том же VPS без privileged-режима и без пароля root.
  local vpn_user="aggvpn"
  local key_file="$APP_DIR/data/vpn_local_ed25519"
  local key_pub="${key_file}.pub"
  local user_home="/home/${vpn_user}"
  local auth_file="${user_home}/.ssh/authorized_keys"
  local bash_path true_path
  # `command -v true` in Bash may return the shell builtin name `true` instead
  # of an absolute executable path. sudoers requires a fully-qualified path.
  bash_path="$(type -P bash 2>/dev/null || true)"
  true_path="$(type -P true 2>/dev/null || true)"
  [ -n "$bash_path" ] && [ -x "$bash_path" ] || bash_path="/usr/bin/bash"
  [ -n "$true_path" ] && [ -x "$true_path" ] || true_path="/usr/bin/true"
  [ -x "$bash_path" ] || bash_path="/bin/bash"
  [ -x "$true_path" ] || true_path="/bin/true"

  mkdir -p "$APP_DIR/data"
  chmod 700 "$APP_DIR/data" 2>/dev/null || true

  if ! id "$vpn_user" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$vpn_user"
  fi

  if [ ! -s "$key_file" ] || [ ! -s "$key_pub" ]; then
    rm -f "$key_file" "$key_pub"
    ssh-keygen -q -t ed25519 -N '' -C '3xui-aggregator-local-vpn' -f "$key_file"
  fi
  chmod 600 "$key_file"
  chmod 644 "$key_pub"

  install -d -m 700 -o "$vpn_user" -g "$vpn_user" "${user_home}/.ssh"
  touch "$auth_file"
  chmod 600 "$auth_file"
  chown "$vpn_user:$vpn_user" "$auth_file"

  local public_key restricted_key
  public_key="$(cat "$key_pub")"
  restricted_key="no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ${public_key}"
  if ! grep -Fqx "$restricted_key" "$auth_file" 2>/dev/null; then
    # Удаляем более старую запись этого же служебного ключа и добавляем текущую.
    sed -i '/3xui-aggregator-local-vpn$/d' "$auth_file" 2>/dev/null || true
    printf '%s\n' "$restricted_key" >> "$auth_file"
  fi
  chown -R "$vpn_user:$vpn_user" "${user_home}/.ssh"

  cat > /etc/sudoers.d/3xui-aggregator-vpn <<EOF
Defaults:${vpn_user} !requiretty
${vpn_user} ALL=(root) NOPASSWD: ${true_path}, ${bash_path} /tmp/agg-vpn.*
EOF
  chmod 440 /etc/sudoers.d/3xui-aggregator-vpn
  if ! visudo -cf /etc/sudoers.d/3xui-aggregator-vpn >/dev/null; then
    rm -f /etc/sudoers.d/3xui-aggregator-vpn
    err "Не удалось создать безопасное sudo-правило для локальных VPN-сервисов."
    exit 1
  fi

  mkdir -p /run/sshd
  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    systemctl enable --now ssh >/dev/null 2>&1 || true
  elif systemctl list-unit-files sshd.service >/dev/null 2>&1; then
    systemctl enable --now sshd >/dev/null 2>&1 || true
  fi

  say "Локальный SSH-доступ для VPN-сервисов подготовлен."
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    NEXUS_UI_STEP=$((NEXUS_UI_STEP + 1))
    ui_step_success "$NEXUS_UI_STEP" "Docker и Docker Compose уже установлены" "0"
    return
  fi

  local docker_installer
  docker_installer="$(mktemp)"
  ui_run "Загрузка официального Docker installer" \
    curl --fail --show-error --location --retry 5 --retry-delay 2 \
      --connect-timeout 20 https://get.docker.com -o "$docker_installer"
  ui_run "Установка Docker Engine и Compose" sh "$docker_installer"
  rm -f "$docker_installer"
  ui_run "Запуск службы Docker" systemctl enable --now docker

  if ! docker compose version >/dev/null 2>&1; then
    err "Docker установлен, но docker compose недоступен."
    exit 1
  fi
}

preserve_runtime_files_if_needed() {
  local preserve_dir="$1"

  if [ ! -d "$APP_DIR" ]; then
    return
  fi

  if [ -f "$APP_DIR/.env" ]; then cp -a "$APP_DIR/.env" "$preserve_dir/.env"; fi
  if [ -f "$APP_DIR/.install.conf" ]; then cp -a "$APP_DIR/.install.conf" "$preserve_dir/.install.conf"; fi
  if [ -f "$APP_DIR/.source.conf" ]; then cp -a "$APP_DIR/.source.conf" "$preserve_dir/.source.conf"; fi
  if [ -d "$APP_DIR/data" ]; then cp -a "$APP_DIR/data" "$preserve_dir/data"; fi
}

restore_runtime_files_if_needed() {
  local preserve_dir="$1"

  if [ -f "$preserve_dir/.env" ]; then cp -a "$preserve_dir/.env" "$APP_DIR/.env"; fi
  if [ -f "$preserve_dir/.install.conf" ]; then cp -a "$preserve_dir/.install.conf" "$APP_DIR/.install.conf"; fi
  if [ -f "$preserve_dir/.source.conf" ]; then cp -a "$preserve_dir/.source.conf" "$APP_DIR/.source.conf"; fi
  if [ -d "$preserve_dir/data" ]; then
    mkdir -p "$APP_DIR/data"
    cp -a "$preserve_dir/data/." "$APP_DIR/data/"
  fi
}

app_dir_has_runtime_data() {
  [ -f "$APP_DIR/.env" ] || [ -f "$APP_DIR/.install.conf" ] || [ -f "$APP_DIR/data/app.db" ] || [ -f "$APP_DIR/data/sessions.sqlite" ]
}

clone_or_update_repo() {
  local repo_url="$1"
  local branch="$2"

  REPO_URL="$repo_url"
  BRANCH="$branch"

  if [ -d "$APP_DIR/.git" ]; then
    local current_origin target_commit
    current_origin="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
    warn "Каталог $APP_DIR уже существует. Сначала проверяю новый источник, не останавливая панель..."
    if [ -n "$current_origin" ] && [ "${current_origin%/}" != "${repo_url%/}" ]; then
      info "Источник будет переключён: $current_origin -> $repo_url"
    fi

    # Fetch напрямую по выбранному URL не зависит от старого origin. Запрет
    # интерактивного запроса логина не даёт обновлению зависнуть на удалённом
    # или приватном прежнем репозитории. До успешной загрузки стек продолжает
    # работать и git-конфигурация остаётся прежней.
    if ! ui_run "Загрузка обновлений Nexus Panel" env GIT_TERMINAL_PROMPT=0 \
      git -c credential.interactive=never -C "$APP_DIR" fetch --prune "$repo_url" "$branch"; then
      err "Не удалось скачать $repo_url (ветка $branch). Панель не остановлена и данные не изменены."
      return 1
    fi
    target_commit="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"

    stop_existing_aggregator_stack
    git -C "$APP_DIR" checkout -B "$branch" "$target_commit"
    git -C "$APP_DIR" reset --hard "$target_commit"
    if git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
      git -C "$APP_DIR" remote set-url origin "$repo_url"
    else
      git -C "$APP_DIR" remote add origin "$repo_url"
    fi
    git -C "$APP_DIR" update-ref "refs/remotes/origin/$branch" "$target_commit"
  else
    info "Сначала скачиваю проект во временный каталог, не останавливая панель..."
    local tmp_dir preserve_dir
    tmp_dir="$(mktemp -d)"
    preserve_dir="$(mktemp -d)"
    if ! ui_run "Загрузка Nexus Panel из GitHub" env GIT_TERMINAL_PROMPT=0 \
      git -c credential.interactive=never clone -b "$branch" "$repo_url" "$tmp_dir"; then
      rm -rf "$tmp_dir" "$preserve_dir"
      err "Не удалось скачать $repo_url (ветка $branch). Панель не остановлена и данные не изменены."
      return 1
    fi

    if [ -d "$APP_DIR" ] && app_dir_has_runtime_data; then
      warn "Каталог $APP_DIR не является git-клоном, но содержит настройки или базу. Сохраняю .env, .install.conf и data перед заменой файлов."
      stop_existing_aggregator_stack
      preserve_runtime_files_if_needed "$preserve_dir"
    fi

    say "Клонирую проект в $APP_DIR ..."
    rm -rf "$APP_DIR"
    mv "$tmp_dir" "$APP_DIR"
    restore_runtime_files_if_needed "$preserve_dir"
    rm -rf "$preserve_dir"
  fi

  save_source_config
}

write_dockerfile_patch_note() {
  if [ -f "$APP_DIR/Dockerfile" ]; then
    info "Dockerfile проверен: npm ci по package-lock, официальный registry, fallback registry и timeout включены."
    grep -E "NODE_OPTIONS=--dns-result-order=ipv4first|NPM_REGISTRY|NPM_INSTALL_TIMEOUT|npm ci|timeout" "$APP_DIR/Dockerfile" >/dev/null 2>&1 || true
  fi
}

compose_all_port() {
  local host_port="$1"
  local container_port="$2"
  printf '%s:%s' "$host_port" "$container_port"
}

compose_bound_port() {
  local host_port="$1"
  local container_port="$2"
  if [ -n "${BIND_IP:-}" ]; then
    printf '%s:%s:%s' "$BIND_IP" "$host_port" "$container_port"
  else
    printf '%s:%s' "$host_port" "$container_port"
  fi
}

write_compose_ip_only() {
  cat > "$APP_DIR/docker-compose.yml" <<EOF
name: ${COMPOSE_PROJECT_NAME}
services:
  aggregator:
    build:
      context: .
      network: host
      args:
        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org/}
        NPM_FALLBACK_REGISTRY: ${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
        NPM_INSTALL_TIMEOUT: ${NPM_INSTALL_TIMEOUT:-420}
        NPM_FETCH_TIMEOUT: ${NPM_FETCH_TIMEOUT:-60000}
        NPM_FETCH_RETRIES: ${NPM_FETCH_RETRIES:-1}
    container_name: ${AGG_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_all_port "$APP_PORT" "$APP_PORT")"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data
EOF
}

write_caddyfile_single_or_dual() {
  local normal_domains=()
  local port_domains=()
  local all_domains=()

  add_unique() {
    local value="$1"
    shift
    [ -z "$value" ] && return 0
    local existing
    for existing in "$@"; do
      [ "$existing" = "$value" ] && return 0
    done
    echo "$value"
  }

  add_to_array_unique() {
    local __name="$1"
    local __value="$2"
    local __existing __added
    [ -z "$__value" ] && return 0
    eval "for __existing in \"\${${__name}[@]}\"; do [ \"\$__existing\" = \"\$__value\" ] && return 0; done"
    eval "${__name}+=(\"\$__value\")"
  }

  if [ "${PANEL_MODE}" = "domain" ]; then
    add_to_array_unique normal_domains "$PANEL_DOMAIN"
  fi
  if [ "${SUB_MODE}" = "domain" ]; then
    add_to_array_unique normal_domains "$SUB_DOMAIN"
  fi
  if [ "${PANEL_MODE}" = "domain_port" ]; then
    add_to_array_unique port_domains "$PANEL_DOMAIN"
  fi
  if [ "${SUB_MODE}" = "domain_port" ]; then
    add_to_array_unique port_domains "$SUB_DOMAIN"
  fi
  for d in "${normal_domains[@]}" "${port_domains[@]}"; do
    add_to_array_unique all_domains "$d"
  done

  if [ "${#normal_domains[@]}" -gt 0 ] && [ -z "${PANEL_EMAIL:-}" ]; then
    err "Для доменного режима подписок/панели без порта нужен email для SSL."
    exit 1
  fi

  {
    echo "{"
    if [ "${#normal_domains[@]}" -gt 0 ]; then
      echo "    email $PANEL_EMAIL"
    fi
    # Отключаем автоматические HTTP->HTTPS редиректы Caddy: при одном домене
    # для 443 и отдельного порта Caddy может выбрать редирект на порт панели.
    # Ниже мы создаём явные HTTP-блоки и сами решаем, куда вести /json и админку.
    echo "    auto_https disable_redirects"
    echo "}"
    echo

    uses_normal_cert_domain() {
      local domain="$1"
      local existing
      for existing in "${normal_domains[@]}"; do
        [ "$existing" = "$domain" ] && return 0
      done
      return 1
    }

    is_public_path_matcher_needed() {
      [ "${#normal_domains[@]}" -gt 0 ] || return 1
      return 0
    }

    for d in "${all_domains[@]}"; do
      [ -z "$d" ] && continue
      echo "http://${d} {"
      if uses_normal_cert_domain "$d"; then
        if [ "${PANEL_MODE}" = "domain_port" ] && [ "${PANEL_DOMAIN}" = "$d" ]; then
          echo "    @public_sub path /sub/* /json/* /happ/* /happ-routing/* /happ-routing-json/* /open/* /qr /healthz /css/* /js/* /img/* /favicon.ico"
          echo "    redir @public_sub https://${d}{uri} permanent"
          echo "    redir https://${d}:${APP_PORT}{uri} permanent"
        else
          echo "    redir https://${d}{uri} permanent"
        fi
      else
        echo "    redir https://${d}:${APP_PORT}{uri} permanent"
      fi
      echo "}"
      echo
    done

    for d in "${port_domains[@]}"; do
      [ -z "$d" ] && continue
      echo "https://${d}:${APP_PORT} {"
      if uses_normal_cert_domain "$d"; then
        echo "    # Этот же домен уже обслуживается на 443, поэтому Caddy использует обычный публичный сертификат."
        echo "    # tls internal здесь нельзя включать: будет конфликт certificate automation policy."
      else
        echo "    tls internal"
      fi
      echo "    encode gzip"
      echo "    header {"
      echo "        X-Content-Type-Options nosniff"
      echo "        X-Frame-Options DENY"
      echo "        Referrer-Policy no-referrer"
      echo "    }"
      echo "    reverse_proxy aggregator:${APP_PORT}"
      echo "}"
      echo
    done

    for d in "${normal_domains[@]}"; do
      [ -z "$d" ] && continue
      echo "https://${d} {"
      echo "    encode gzip"
      echo "    header {"
      echo "        X-Content-Type-Options nosniff"
      echo "        X-Frame-Options DENY"
      echo "        Referrer-Policy no-referrer"
      echo "    }"
      if [ "${PANEL_MODE}" = "domain" ] && [ "$PANEL_DOMAIN" = "$d" ]; then
        echo "    reverse_proxy aggregator:${APP_PORT}"
      else
        echo "    @public_sub path /sub/* /json/* /happ/* /happ-routing/* /happ-routing-json/* /open/* /qr /healthz /css/* /js/* /img/* /favicon.ico"
        echo "    reverse_proxy @public_sub aggregator:${APP_PORT}"
        echo "    respond 404"
      fi
      echo "}"
      echo
    done
  } > "$APP_DIR/Caddyfile"
}

write_compose_domain_only() {
  cat > "$APP_DIR/docker-compose.yml" <<EOF
name: ${COMPOSE_PROJECT_NAME}
services:
  aggregator:
    build:
      context: .
      network: host
      args:
        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org/}
        NPM_FALLBACK_REGISTRY: ${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
        NPM_INSTALL_TIMEOUT: ${NPM_INSTALL_TIMEOUT:-420}
        NPM_FETCH_TIMEOUT: ${NPM_FETCH_TIMEOUT:-60000}
        NPM_FETCH_RETRIES: ${NPM_FETCH_RETRIES:-1}
    container_name: ${AGG_CONTAINER_NAME}
    restart: unless-stopped
    expose:
      - "${APP_PORT}"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data

  caddy:
    image: caddy:2
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_bound_port 80 80)"
      - "$(compose_bound_port 443 443)"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - aggregator

volumes:
  caddy_data:
  caddy_config:
EOF
}

write_compose_domain_port_self_signed() {
  cat > "$APP_DIR/docker-compose.yml" <<EOF
name: ${COMPOSE_PROJECT_NAME}
services:
  aggregator:
    build:
      context: .
      network: host
      args:
        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org/}
        NPM_FALLBACK_REGISTRY: ${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
        NPM_INSTALL_TIMEOUT: ${NPM_INSTALL_TIMEOUT:-420}
        NPM_FETCH_TIMEOUT: ${NPM_FETCH_TIMEOUT:-60000}
        NPM_FETCH_RETRIES: ${NPM_FETCH_RETRIES:-1}
    container_name: ${AGG_CONTAINER_NAME}
    restart: unless-stopped
    expose:
      - "${APP_PORT}"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data

  caddy:
    image: caddy:2
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_bound_port "$APP_PORT" "$APP_PORT")"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - aggregator

volumes:
  caddy_data:
  caddy_config:
EOF
}

write_compose_domain_and_port_caddy() {
  cat > "$APP_DIR/docker-compose.yml" <<EOF
name: ${COMPOSE_PROJECT_NAME}
services:
  aggregator:
    build:
      context: .
      network: host
      args:
        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org/}
        NPM_FALLBACK_REGISTRY: ${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
        NPM_INSTALL_TIMEOUT: ${NPM_INSTALL_TIMEOUT:-420}
        NPM_FETCH_TIMEOUT: ${NPM_FETCH_TIMEOUT:-60000}
        NPM_FETCH_RETRIES: ${NPM_FETCH_RETRIES:-1}
    container_name: ${AGG_CONTAINER_NAME}
    restart: unless-stopped
    expose:
      - "${APP_PORT}"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data

  caddy:
    image: caddy:2
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_bound_port 80 80)"
      - "$(compose_bound_port 443 443)"
      - "$(compose_bound_port "$APP_PORT" "$APP_PORT")"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - aggregator

volumes:
  caddy_data:
  caddy_config:
EOF
}

write_compose_mixed_domain_ip() {
  cat > "$APP_DIR/docker-compose.yml" <<EOF
name: ${COMPOSE_PROJECT_NAME}
services:
  aggregator:
    build:
      context: .
      network: host
      args:
        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org/}
        NPM_FALLBACK_REGISTRY: ${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}
        NPM_INSTALL_TIMEOUT: ${NPM_INSTALL_TIMEOUT:-420}
        NPM_FETCH_TIMEOUT: ${NPM_FETCH_TIMEOUT:-60000}
        NPM_FETCH_RETRIES: ${NPM_FETCH_RETRIES:-1}
    container_name: ${AGG_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_all_port "$APP_PORT" "$APP_PORT")"
    env_file:
      - .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data

  caddy:
    image: caddy:2
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      - "$(compose_bound_port 80 80)"
      - "$(compose_bound_port 443 443)"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - aggregator

volumes:
  caddy_data:
  caddy_config:
EOF
}

write_runtime_files() {
  local has_domain="0"
  local has_domain_port="0"
  local has_ip="0"

  [ "$PANEL_MODE" = "domain" ] && has_domain="1"
  [ "$SUB_MODE" = "domain" ] && has_domain="1"
  [ "$PANEL_MODE" = "domain_port" ] && has_domain_port="1"
  [ "$SUB_MODE" = "domain_port" ] && has_domain_port="1"
  [ "$PANEL_MODE" = "ip" ] && has_ip="1"
  [ "$SUB_MODE" = "ip" ] && has_ip="1"

  rm -f "$APP_DIR/Caddyfile"

  if [ "$has_domain" = "1" ] && [ "$has_domain_port" = "1" ]; then
    write_caddyfile_single_or_dual
    write_compose_domain_and_port_caddy
  elif [ "$has_domain_port" = "1" ]; then
    write_caddyfile_single_or_dual
    write_compose_domain_port_self_signed
  elif [ "$has_domain" = "1" ]; then
    write_caddyfile_single_or_dual
    if [ "$has_ip" = "1" ]; then
      write_compose_mixed_domain_ip
    else
      write_compose_domain_only
    fi
  else
    write_compose_ip_only
  fi
}

install_forwarder_service() {
  if [ ! -f "$APP_DIR/scripts/forwarder.sh" ]; then
    warn "Host-helper перенаправления не найден: $APP_DIR/scripts/forwarder.sh"
    return 0
  fi

  say "Устанавливаю host-helper перенаправления..."
  chmod +x "$APP_DIR/scripts/forwarder.sh" || true
  mkdir -p "$APP_DIR/data"

  # Убираем старые варианты сервиса, чтобы обновление не оставляло сломанную oneshot-версию.
  systemctl stop "${FORWARDER_SERVICE_NAME}.service" >/dev/null 2>&1 || true
  systemctl disable "${FORWARDER_SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${FORWARDER_SERVICE_NAME}.service"

  cat > "/etc/systemd/system/${FORWARDER_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Nexus Panel traffic redirect helper (${INSTANCE_NAME})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
Environment=APP_DIR=$APP_DIR
Environment=SLEEP_SEC=3
ExecStart=$APP_DIR/scripts/forwarder.sh loop
ExecReload=$APP_DIR/scripts/forwarder.sh apply
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload || true
  if systemctl enable --now "${FORWARDER_SERVICE_NAME}.service" >/dev/null 2>&1; then
    say "Host-helper установлен и запущен: ${FORWARDER_SERVICE_NAME}.service"
  else
    warn "Не удалось запустить ${FORWARDER_SERVICE_NAME}.service. Можно запустить вручную: systemctl restart ${FORWARDER_SERVICE_NAME}"
    journalctl -u "${FORWARDER_SERVICE_NAME}.service" --no-pager -n 20 || true
  fi
}


install_web_update_service() {
  if [ ! -f "$APP_DIR/scripts/web_updater.sh" ]; then
    warn "Host-updater обновления не найден: $APP_DIR/scripts/web_updater.sh"
    return 0
  fi

  say "Устанавливаю host-updater обновления проекта..."
  chmod +x "$APP_DIR/scripts/web_updater.sh" || true
  mkdir -p "$APP_DIR/data"

  cat > "/etc/systemd/system/${UPDATER_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Nexus Panel web updater (${INSTANCE_NAME})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
Environment=APP_DIR=$APP_DIR
Environment=AGG_INSTANCE=$INSTANCE_NAME
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=SLEEP_SEC=3
ExecStart=$APP_DIR/scripts/web_updater.sh loop
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload || true
  if systemctl enable --now "${UPDATER_SERVICE_NAME}.service" >/dev/null 2>&1; then
    say "Host-updater установлен и запущен: ${UPDATER_SERVICE_NAME}.service"
  else
    warn "Не удалось запустить ${UPDATER_SERVICE_NAME}.service. Веб-обновление может быть недоступно."
    journalctl -u "${UPDATER_SERVICE_NAME}.service" --no-pager -n 20 || true
  fi
}

compose_up_build() {
  cd "$APP_DIR"
  export DOCKER_BUILDKIT=1
  export COMPOSE_DOCKER_CLI_BUILD=1
  export COMPOSE_PROGRESS=plain

  if docker compose --help 2>&1 | grep -q -- '--progress'; then
    docker compose --progress plain up -d --build
  else
    docker compose up -d --build
  fi
}

start_stack() {
  ui_run "Сборка и запуск контейнеров" compose_up_build
}

stop_existing_aggregator_stack() {
  if [ ! -d "$APP_DIR" ]; then
    return
  fi

  info "Обнаружен существующий стек агрегатора. Временно останавливаю для обновления..."
  cd "$APP_DIR" || return

  docker compose down --remove-orphans || true
  systemctl disable --now "${FORWARDER_SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${FORWARDER_SERVICE_NAME}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true

  docker stop "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker stop "$AGG_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$AGG_CONTAINER_NAME" >/dev/null 2>&1 || true
}

install_shortcut_command() {
  save_source_config

  local instance_shortcut="/usr/local/bin/agg-${INSTANCE_NAME}"
  cat > "$instance_shortcut" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export APP_DIR="$APP_DIR"
export AGG_INSTANCE="$INSTANCE_NAME"
if [ -f "\$APP_DIR/install.sh" ]; then
  if LC_ALL=C grep -q $'\r' "\$APP_DIR/install.sh"; then
    clean_file="\$(mktemp)"
    sed 's/\r$//' "\$APP_DIR/install.sh" > "\$clean_file"
    install -m 0755 "\$clean_file" "\$APP_DIR/install.sh"
    rm -f "\$clean_file"
  fi
  args=("\$@")
  [ "\${#args[@]}" -gt 0 ] || args=(menu)
  exec bash "\$APP_DIR/install.sh" "\${args[@]}"
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl не найден. Установи curl или запусти установочную команду из README."
  exit 1
fi
tmp_file="\$(mktemp)"
trap 'rm -f "\$tmp_file"' EXIT
curl -fsSL "${INSTALLER_RAW_URL:-$INSTALLER_RAW_URL_DEFAULT}" -o "\$tmp_file"
sed -i 's/\r$//' "\$tmp_file"
args=("\$@")
[ "\${#args[@]}" -gt 0 ] || args=(menu)
exec env APP_DIR="$APP_DIR" AGG_INSTANCE="$INSTANCE_NAME" bash "\$tmp_file" "\${args[@]}"
EOF
  chmod +x "$instance_shortcut"

  cat > "$SHORTCUT_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
launch_installer() {
  if [ ! -f "$APP_DIR/install.sh" ]; then
    echo "install.sh не найден: $APP_DIR/install.sh"
    exit 1
  fi
  if LC_ALL=C grep -q $'\r' "$APP_DIR/install.sh"; then
    clean_file="$(mktemp)"
    sed 's/\r$//' "$APP_DIR/install.sh" > "$clean_file"
    install -m 0755 "$clean_file" "$APP_DIR/install.sh"
    rm -f "$clean_file"
  fi
  args=("$@")
  [ "${#args[@]}" -gt 0 ] || args=(menu)
  exec bash "$APP_DIR/install.sh" "${args[@]}"
}
mapfile -t dirs < <(find /opt -maxdepth 1 -type d \( -name '3xui-aggregator' -o -name '3xui-aggregator-*' \) | sort)
if [ "${#dirs[@]}" -eq 0 ]; then
  echo "Установки Nexus Panel не найдены. Запусти установочную команду из README."
  exit 1
fi
if [ "${#dirs[@]}" -eq 1 ]; then
  export APP_DIR="${dirs[0]}"
  base="$(basename "$APP_DIR")"
  if [ "$base" = "3xui-aggregator" ]; then export AGG_INSTANCE="default"; else export AGG_INSTANCE="${base#3xui-aggregator-}"; fi
  launch_installer "$@"
fi
if [ "$#" -gt 0 ] && [ -d "/opt/3xui-aggregator-$1" ]; then
  export AGG_INSTANCE="$1"
  export APP_DIR="/opt/3xui-aggregator-$1"
  shift
  launch_installer "$@"
fi
echo "Выбери экземпляр Nexus Panel:"
i=1
for d in "${dirs[@]}"; do
  base="$(basename "$d")"
  name="default"
  [ "$base" != "3xui-aggregator" ] && name="${base#3xui-aggregator-}"
  echo "$i) $name  ($d)"
  i=$((i+1))
done
read -r -p "Номер [1]: " choice
choice="${choice:-1}"
idx=$((choice-1))
if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#dirs[@]}" ]; then
  echo "Неверный выбор"
  exit 1
fi
export APP_DIR="${dirs[$idx]}"
base="$(basename "$APP_DIR")"
if [ "$base" = "3xui-aggregator" ]; then export AGG_INSTANCE="default"; else export AGG_INSTANCE="${base#3xui-aggregator-}"; fi
launch_installer "$@"
EOF
  chmod +x "$SHORTCUT_BIN"
}

create_backup() {
  ui_section "Резервная копия"
  mkdir -p "$BACKUP_DIR"

  local stamp archive_name archive_path had_compose
  stamp="$(date +%F-%H%M%S)"
  archive_name="3xui-aggregator-${INSTANCE_NAME}-backup-${stamp}.tar.gz"
  archive_path="$BACKUP_DIR/$archive_name"
  had_compose="0"

  # Для обычного backup нельзя пересобирать Docker-образ и нельзя удалять
  # systemd-service редиректа. Достаточно мягко остановить контейнеры,
  # снять архив и поднять их обратно из уже существующего образа.
  if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/docker-compose.yml" ]; then
    had_compose="1"
    cd "$APP_DIR"
    docker compose stop || true
  fi

  ui_run "Архивация Nexus Panel" tar -czf "$archive_path" \
    -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"

  say "Резервная копия создана:"
  say "$archive_path"

  if [ "$had_compose" = "1" ]; then
    cd "$APP_DIR"
    docker compose up -d --no-build || docker compose up -d || true
  fi
}

restore_from_backup() {
  say "Восстановление из резервной копии"
  mkdir -p "$BACKUP_DIR"

  local latest_backup=""
  latest_backup="$(ls -1t "$BACKUP_DIR"/3xui-aggregator-${INSTANCE_NAME}-backup-*.tar.gz "$BACKUP_DIR"/3xui-aggregator-backup-*.tar.gz 2>/dev/null | head -n 1 || true)"

  local archive_path
  archive_path="$(ask 'Путь к архиву резервной копии' "${latest_backup:-/opt/3xui-backups/backup.tar.gz}")"
  archive_path="$(trim "$archive_path")"

  if [ ! -f "$archive_path" ]; then
    err "Архив не найден: $archive_path"
    exit 1
  fi

  stop_existing_aggregator_stack
  rm -rf "$APP_DIR"
  mkdir -p /opt

  ui_run "Распаковка резервной копии" tar -xzf "$archive_path" -C /opt

  if [ ! -d "$APP_DIR" ]; then
    err "После распаковки каталог $APP_DIR не найден."
    exit 1
  fi

  install_docker_if_needed
  install_shortcut_command

  cd "$APP_DIR"
  compose_up_build
  install_forwarder_service

  say "Восстановление завершено."
}

get_public_server_ip() {
  local server_ip
  server_ip="$(curl -4 -fsSL https://api.ipify.org || echo "127.0.0.1")"
  server_ip="$(trim "$server_ip")"
  echo "$server_ip"
}

trim_url() {
  local value="$1"
  value="$(trim "$value")"
  value="${value%/}"
  echo "$value"
}

url_host_port() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  echo "$value"
}

url_host_only() {
  local hostport
  hostport="$(url_host_port "$1")"
  echo "${hostport%%:*}"
}

url_has_port() {
  local hostport
  hostport="$(url_host_port "$1")"
  [ "$hostport" != "${hostport%%:*}" ]
}

build_panel_public_url() {
  local server_ip="${1:-}"

  if [ "$PANEL_MODE" = "domain" ]; then
    PANEL_PUBLIC_URL="https://${PANEL_DOMAIN}"
  elif [ "$PANEL_MODE" = "domain_port" ]; then
    PANEL_PUBLIC_URL="https://${PANEL_DOMAIN}:${APP_PORT}"
  else
    if [ -z "${PANEL_IP:-}" ]; then
      PANEL_IP="$server_ip"
    fi
    PANEL_PUBLIC_URL="http://${PANEL_IP}:${APP_PORT}"
  fi

  PANEL_PUBLIC_URL="$(trim_url "$PANEL_PUBLIC_URL")"
}

default_subscription_public_url() {
  if [ "$PANEL_MODE" = "domain" ] || [ "$PANEL_MODE" = "domain_port" ]; then
    echo "https://${PANEL_DOMAIN}"
  else
    echo "$PANEL_PUBLIC_URL"
  fi
}

detect_subscription_mode_from_url() {
  local url="$1"
  local host
  host="$(url_host_only "$url")"

  SUB_DOMAIN=""
  SUB_IP=""

  if printf '%s' "$url" | grep -Eqi '^https://'; then
    if url_has_port "$url"; then
      SUB_MODE="domain_port"
      SUB_DOMAIN="$host"
    else
      SUB_MODE="domain"
      SUB_DOMAIN="$host"
    fi
  else
    SUB_MODE="ip"
    SUB_IP="$host"
  fi
}

build_urls() {
  local server_ip="${1:-}"

  build_panel_public_url "$server_ip"

  if [ -z "${SUB_PUBLIC_URL:-}" ]; then
    SUB_PUBLIC_URL="$(default_subscription_public_url)"
  fi

  SUB_PUBLIC_URL="$(trim_url "$SUB_PUBLIC_URL")"
  SUB_URL_MODE="${SUB_URL_MODE:-custom}"
  detect_subscription_mode_from_url "$SUB_PUBLIC_URL"
}

prompt_subscription_public_url() {
  local server_ip="${1:-}"
  build_panel_public_url "$server_ip"

  local default_sub
  default_sub="$(default_subscription_public_url)"

  echo
  say "Публичный адрес подписок JSON/SUB:"
  warn "Адрес панели с портом не добавляется в клиентские ссылки автоматически."
  warn "Для ссылок без порта домен должен открываться на 443 и попадать в агрегатор."

  SUB_PUBLIC_URL="$(ask 'Публичный адрес подписок' "${SUB_PUBLIC_URL:-$default_sub}")"
  SUB_PUBLIC_URL="$(trim_url "$SUB_PUBLIC_URL")"
  SUB_URL_MODE="custom"
  detect_subscription_mode_from_url "$SUB_PUBLIC_URL"

  if [ "$SUB_MODE" = "domain" ] && [ -z "${PANEL_EMAIL:-}" ]; then
    PANEL_EMAIL="$(ask_email_loop 'Email для SSL подписок (LE / Caddy)' "${PANEL_EMAIL:-}")"
  fi
}

prompt_panel_mode() {
  echo
  say "Выбери режим для панели:"
  say "1 - По IP"
  say "2 - По домену, обычный HTTPS 443 через Caddy"
  say "3 - По домену с HTTPS на выбранном порту"
  say "4 - Пропустить, оставить как есть"
  local choice
  choice="$(ask_choice_loop 'Выбор для панели' '4' '1 2 3 4')"

  case "$choice" in
    1)
      PANEL_MODE="ip"
      BIND_IP=""
      local default_ip
      default_ip="${PANEL_IP:-$(get_public_server_ip)}"
      PANEL_IP="$(ask 'IP для панели' "$default_ip")"
      PANEL_IP="$(trim "$PANEL_IP")"
      ;;
    2)
      PANEL_MODE="domain"
      PANEL_DOMAIN="$(ask_domain_loop 'Домен для панели' "${PANEL_DOMAIN:-}")"
      PANEL_EMAIL="$(ask_email_loop 'Email для SSL (LE / Caddy)' "${PANEL_EMAIL:-}")"
      ;;
    3)
      PANEL_MODE="domain_port"
      PANEL_DOMAIN="$(ask_domain_loop 'Домен для панели' "${PANEL_DOMAIN:-}")"
      PANEL_EMAIL=""
      ;;
    4)
      info "Настройки панели оставлены без изменений."
      ;;
  esac
}
prompt_sub_mode() {
  local server_ip
  server_ip="$(get_public_server_ip)"
  prompt_subscription_public_url "$server_ip"
}

uses_caddy_runtime() {
  [ "${PANEL_MODE:-}" = "domain" ] || [ "${PANEL_MODE:-}" = "domain_port" ] || [ "${SUB_MODE:-}" = "domain" ] || [ "${SUB_MODE:-}" = "domain_port" ]
}

prompt_bind_ip_if_needed() {
  if ! uses_caddy_runtime; then
    BIND_IP=""
    return
  fi

  echo
  say "Привязка портов к IP сервера:"
  warn "Если на сервере несколько IP, можно указать IP агрегатора. Тогда Caddy займёт 80/443/порт панели только на этом IP."
  warn "Если сервер обычный или отдельный VPS, оставь пустым."

  local value
  value="$(ask 'IP для привязки портов Caddy' "${BIND_IP:-}")"
  value="$(trim "$value")"

  if [ -z "$value" ]; then
    BIND_IP=""
    return
  fi

  if ! is_valid_ipv4 "$value"; then
    err "IP введён некорректно: $value"
    exit 1
  fi

  BIND_IP="$value"
}

prompt_port_change() {
  echo
  say "Внутренний порт приложения Node.js:"
  warn "В обычном доменном режиме этот порт не попадает в публичную ссылку. Caddy снаружи слушает 80/443."
  say "1 - Изменить внутренний порт"
  say "2 - Оставить текущий"
  local choice
  choice="$(ask_choice_loop 'Выбор по порту' '2' '1 2')"

  case "$choice" in
    1)
      APP_PORT="$(ask_port_loop 'Внутренний порт приложения агрегатора' "${APP_PORT:-3000}")"
      ;;
    2)
      info "Порт оставлен без изменений."
      ;;
  esac
}
prompt_admin_change() {
  echo
  say "Учетные данные панели:"
  say "1 - Изменить логин и/или пароль"
  say "2 - Оставить текущие"
  local choice
  choice="$(ask_choice_loop 'Выбор по логину/паролю' '2' '1 2')"

  case "$choice" in
    1)
      ADMIN_USER="$(ask 'Логин администратора панели' "${ADMIN_USER:-admin}")"
      ADMIN_USER="$(trim "$ADMIN_USER")"
      local new_pass
      new_pass="$(ask_secret_optional 'Новый пароль администратора (оставь пустым, чтобы не менять)')"
      new_pass="$(trim "$new_pass")"
      if [ -n "$new_pass" ]; then ADMIN_PASS="$new_pass"; fi
      if [ -z "${ADMIN_PASS:-}" ]; then
        err "Пароль не должен быть пустым."
        return 1
      fi
      ;;
    2)
      info "Логин и пароль оставлены без изменений."
      ;;
  esac
}
first_install_wizard() {
  local server_ip
  server_ip="$(get_public_server_ip)"

  say "Выбери режим для панели:"
  say "1 - По IP"
  say "2 - По домену, обычный HTTPS 443 через Caddy"
  say "3 - По домену с HTTPS на выбранном порту"
  local panel_choice
  panel_choice="$(ask_choice_loop 'Режим панели' '1' '1 2 3')"

  case "$panel_choice" in
    1)
      PANEL_MODE="ip"
      BIND_IP=""
      PANEL_IP="$(ask 'IP для панели' "$server_ip")"
      PANEL_IP="$(trim "$PANEL_IP")"
      ;;
    2)
      PANEL_MODE="domain"
      PANEL_DOMAIN="$(ask_domain_loop 'Домен для панели' '')"
      PANEL_EMAIL="$(ask_email_loop 'Email для SSL (LE / Caddy)' '')"
      ;;
    3)
      PANEL_MODE="domain_port"
      PANEL_DOMAIN="$(ask_domain_loop 'Домен для панели' '')"
      PANEL_EMAIL=""
      ;;
  esac

  SUB_MODE="$PANEL_MODE"
  SUB_DOMAIN="$PANEL_DOMAIN"
  SUB_IP="$PANEL_IP"

  echo
  APP_PORT="$(ask_port_loop 'Внутренний порт приложения агрегатора' '3000')"

  ADMIN_USER="$(ask 'Логин администратора панели' 'admin')"
  ADMIN_USER="$(trim "$ADMIN_USER")"

  while true; do
    ADMIN_PASS="$(ask_secret_optional 'Пароль администратора панели')"
    ADMIN_PASS="$(trim "$ADMIN_PASS")"
    if [ -n "$ADMIN_PASS" ]; then break; fi
    err "Пароль не должен быть пустым."
  done

  build_panel_public_url "$server_ip"
  prompt_subscription_public_url "$server_ip"
  prompt_bind_ip_if_needed
}

normalize_modes_after_port_choice() {
  # 443 без явного :port — это обычный доменный HTTPS-режим. Если пользователь
  # случайно выбрал режим "домен + порт" и ввёл 443, переводим его в domain,
  # чтобы в ссылках и редиректах не появлялся лишний :443/:3030.
  if [ "${PANEL_MODE:-}" = "domain_port" ] && [ "${APP_PORT:-}" = "443" ]; then
    warn "Для публичного порта 443 используется обычный доменный HTTPS-режим без порта в URL."
    warn "Внутренний порт приложения оставляю 3000, чтобы Caddy снаружи слушал 80/443, а Node работал внутри Docker."
    PANEL_MODE="domain"
    APP_PORT="3000"
    if [ -z "${PANEL_EMAIL:-}" ]; then
      PANEL_EMAIL="$(ask_email_loop 'Email для SSL (LE / Caddy)' "${PANEL_EMAIL:-}")"
    fi
  fi

  if [ "${SUB_MODE:-}" = "domain_port" ] && [ "${APP_PORT:-}" = "443" ]; then
    SUB_MODE="domain"
  fi
}

prepare_config_and_run() {
  ui_section "Применение конфигурации"
  local server_ip
  server_ip="$(get_public_server_ip)"

  local had_existing_stack="0"
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    had_existing_stack="1"
  fi

  if [ "$had_existing_stack" = "1" ]; then
    stop_existing_aggregator_stack
  fi

  sleep 2
  normalize_modes_after_port_choice
  build_urls "$server_ip"
  check_domain_ports_if_needed
  build_urls "$server_ip"

  if { [ "$PANEL_MODE" = "ip" ] || [ "$PANEL_MODE" = "domain_port" ] || [ "$SUB_MODE" = "domain_port" ]; } && port_in_use "$APP_PORT"; then
    err "Порт ${APP_PORT} уже занят после остановки агрегатора. Значит, его использует другой сервис. Выбери другой порт."
    ss -ltnp 2>/dev/null | grep -E "(:${APP_PORT} )" || true
    exit 1
  fi

  ensure_dir
  save_source_config
  save_install_conf
  write_env_file
  write_runtime_files
  write_dockerfile_patch_note
  ui_run "Подготовка локального VPN-доступа" install_vpn_local_ssh_access
  start_stack
  ui_section "Системные службы"
  install_forwarder_service
  install_web_update_service
  install_shortcut_command
}


script_source_dir() {
  local src
  src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd
}

sync_current_installer_to_app() {
  local source_path target_path clean_file
  source_path="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
  target_path="$APP_DIR/install.sh"

  [ -f "$source_path" ] || return 0
  mkdir -p "$APP_DIR"

  if [ -f "$target_path" ]; then
    local resolved_target
    resolved_target="$(readlink -f "$target_path" 2>/dev/null || printf '%s' "$target_path")"
    [ "$source_path" != "$resolved_target" ] || return 0
  fi

  clean_file="$(mktemp)"
  sed 's/\r$//' "$source_path" > "$clean_file"
  if ! grep -q '^#!/usr/bin/env bash' "$clean_file"; then
    rm -f "$clean_file"
    err "Не удалось проверить свежую копию install.sh."
    return 1
  fi
  install -m 0755 "$clean_file" "$target_path"
  rm -f "$clean_file"
}

can_update_from_local_bundle() {
  local src_dir="$1"
  [ -n "$src_dir" ] || return 1
  [ "$src_dir" != "$APP_DIR" ] || return 1
  [ -f "$src_dir/app.js" ] || return 1
  [ -f "$src_dir/package.json" ] || return 1
  [ -d "$src_dir/views" ] || return 1
  [ -d "$src_dir/public" ] || return 1
  return 0
}

copy_project_files_from_local_bundle() {
  local src_dir="$1"
  local preserve_dir
  say "Обновляю файлы из локального архива: $src_dir"
  preserve_dir="$(mktemp -d)"
  preserve_runtime_files_if_needed "$preserve_dir"

  mkdir -p "$APP_DIR"
  find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name '.env' \
    ! -name '.install.conf' \
    ! -name '.source.conf' \
    ! -name 'data' \
    -exec rm -rf {} +

  tar -C "$src_dir" \
    --exclude='./data' \
    --exclude='./.env' \
    --exclude='./.install.conf' \
    --exclude='./.source.conf' \
    --exclude='./.git' \
    -cf - . | tar -C "$APP_DIR" -xf -

  restore_runtime_files_if_needed "$preserve_dir"
  rm -rf "$preserve_dir"
  save_source_config
}

update_files_only() {
  ui_section "Безопасное обновление"
  say "Обновляю файлы проекта без изменения настроек..."
  load_existing_config

  if [ -z "${ADMIN_PASS:-}" ]; then
    err "Не найден существующий .env с настройками. Для первого запуска выбери установку."
    exit 1
  fi

  local local_src
  local_src="$(script_source_dir)"
  if can_update_from_local_bundle "$local_src"; then
    # Архив уже скачан и проверен до этой точки, поэтому стек можно безопасно
    # остановить непосредственно перед заменой файлов.
    stop_existing_aggregator_stack
    copy_project_files_from_local_bundle "$local_src"
  else
    clone_or_update_repo "$REPO_URL" "$BRANCH"
  fi
  load_existing_config
  prepare_config_and_run
}

change_settings_and_update() {
  ui_section "Изменение параметров"
  say "Изменяю настройки и обновляю проект..."
  load_existing_config

  if [ -z "${ADMIN_PASS:-}" ]; then
    warn "Старые настройки не найдены, запускаю мастер первой установки."
    clone_or_update_repo "$REPO_URL" "$BRANCH"
    load_existing_config
    first_install_wizard
    prepare_config_and_run
    return
  fi

  prompt_panel_mode
  prompt_sub_mode
  prompt_bind_ip_if_needed
  prompt_port_change
  prompt_admin_change

  clone_or_update_repo "$REPO_URL" "$BRANCH"
  prepare_config_and_run
}

reinstall_full() {
  ui_section "Полная переустановка"
  warn "Полная переустановка..."
  load_source_config
  warn "Сначала скачиваю свежую версию проекта. Старые файлы будут удалены только если скачивание успешно."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  ui_run "Загрузка свежей версии Nexus Panel" env GIT_TERMINAL_PROMPT=0 \
    git -c credential.interactive=never clone -b "$BRANCH" "$REPO_URL" "$tmp_dir"

  stop_existing_aggregator_stack
  rm -rf "$APP_DIR"
  mv "$tmp_dir" "$APP_DIR"
  save_source_config

  load_existing_config
  first_install_wizard
  prepare_config_and_run
}

fresh_install_flow() {
  ui_section "Новая установка"
  prompt_instance_for_new_install
  load_source_config
  clone_or_update_repo "$REPO_URL" "$BRANCH"
  load_existing_config
  ui_section "Параметры панели"
  first_install_wizard
  prepare_config_and_run
  install_shortcut_command
}

print_result() {
  printf '\n'
  printf "${GREEN}  ╭────────────────────────────────────────────────────────────╮${NC}\n"
  printf "${GREEN}  │  ✓  NEXUS PANEL УСТАНОВЛЕНА                              │${NC}\n"
  printf "${GREEN}  ╰────────────────────────────────────────────────────────────╯${NC}\n"
  printf "${DIM}  Экземпляр${NC}       %s\n" "${INSTANCE_NAME}"
  printf "${DIM}  Адрес панели${NC}    %s\n" "${PANEL_PUBLIC_URL}"
  printf "${DIM}  Адрес входа${NC}     ${CYAN}%s/login${NC}\n" "${PANEL_PUBLIC_URL%/}"
  printf "${DIM}  Подписки${NC}        %s\n" "${SUB_PUBLIC_URL}"
  if [ -n "${BIND_IP:-}" ]; then
    printf "${DIM}  Caddy bind IP${NC}   %s\n" "${BIND_IP}"
  fi
  printf "${DIM}  Логин${NC}           %s\n" "${ADMIN_USER}"
  printf "${DIM}  Каталог${NC}         %s\n" "${APP_DIR}"
  printf "${DIM}  Журнал${NC}          %s\n" "${NEXUS_UI_LOG_FILE:-/root/nexus-panel-install.log}"
  echo
  warn "Адрес входа панели и публичный адрес подписок могут отличаться."
  warn "Админка защищена логином, паролем, сессией и ограничением попыток; дополнительного ключа в URL больше нет."
  warn "JSON/SUB-ссылки строятся от публичного адреса подписок."
  if [ "$PANEL_MODE" = "domain" ] || [ "$SUB_MODE" = "domain" ]; then
    warn "Для обычного доменного режима порты 80 и 443 должны быть свободны."
  fi
  if [ "$PANEL_MODE" = "domain_port" ] || [ "$SUB_MODE" = "domain_port" ]; then
    if [ "$PANEL_MODE" = "domain_port" ] && [ "$SUB_MODE" = "domain" ] && [ "${PANEL_DOMAIN:-}" = "${SUB_DOMAIN:-}" ]; then
      warn "Панель на порту и подписки без порта используют один домен. Caddy выдаёт обычный публичный SSL-сертификат для 443 и использует его же для порта панели."
    else
      warn "Если домен + порт используется без обычного 443 для этого же домена, Caddy применит локальный сертификат tls internal. Браузер может показать предупреждение о доверии."
    fi
  fi
  warn "Быстрый запуск меню: agg (или agg-${INSTANCE_NAME} для этого экземпляра)"
}


delete_project() {
  warn "Удаляю Nexus Panel..."

  if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" || true
    docker compose down -v --remove-orphans || true
  fi

  systemctl disable --now "${FORWARDER_SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${FORWARDER_SERVICE_NAME}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true

  docker stop "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker stop "$AGG_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$AGG_CONTAINER_NAME" >/dev/null 2>&1 || true

  cd /
  rm -rf "$APP_DIR"
  rm -f "/usr/local/bin/agg-${INSTANCE_NAME}"
  rm -f "$SOURCE_CONF"
  if [ -z "$(find /opt -maxdepth 1 -type d \( -name '3xui-aggregator' -o -name '3xui-aggregator-*' \) 2>/dev/null | head -n 1)" ]; then rm -f "$SHORTCUT_BIN"; fi

  say "Nexus Panel удалён."
  warn "Резервные копии в $BACKUP_DIR не удалены."
  warn "Команда agg-${INSTANCE_NAME} удалена. Общая команда agg останется, если есть другие экземпляры."
  exit 0
}


run_diagnostics_and_repair() {
  say "Диагностика и восстановление панели"
  warn "Проверяю контейнеры, Caddy, доступность приложения и опасные перенаправления."

  if [ ! -d "$APP_DIR" ]; then
    err "Каталог проекта не найден: $APP_DIR"
    return 1
  fi

  mkdir -p "$APP_DIR/data/backup"

  if [ -f "$APP_DIR/data/redirect_rules.json" ]; then
    cp -a "$APP_DIR/data/redirect_rules.json" "$APP_DIR/data/backup/redirect_rules.json.$(date +%F-%H%M%S).bak" 2>/dev/null || true
  fi

  say "1/6 Очищаю managed iptables-цепочки агрегатора, чтобы убрать случайный редирект 80/443..."
  systemctl stop "$FORWARDER_SERVICE_NAME" 2>/dev/null || true
  if [ -x "$APP_DIR/scripts/forwarder.sh" ]; then
    APP_DIR="$APP_DIR" bash "$APP_DIR/scripts/forwarder.sh" clear || true
  fi

  say "2/6 Удаляю из правил перенаправления опасные порты 80/443 и дубли портов..."
  python3 - "$APP_DIR/data/redirect_rules.json" <<'PYDIAG' || true
import json, sys, pathlib
path=pathlib.Path(sys.argv[1])
if not path.exists():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"rules":[]}', encoding='utf-8')
    raise SystemExit
try:
    data=json.loads(path.read_text(encoding='utf-8') or '{"rules":[]}')
except Exception:
    data={'rules':[]}
rules=[]
seen=set()
removed=[]
for r in data.get('rules',[]) or []:
    try:
        port=int(r.get('target_port') or 0)
    except Exception:
        port=0
    bind=str(r.get('bind_ip') or '')
    proto=str(r.get('protocol') or 'tcp')
    key=(bind, port, proto)
    if port in (80,443) or port <= 0 or key in seen:
        removed.append(r)
        continue
    seen.add(key)
    rules.append(r)
data['rules']=rules
path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"Удалено опасных/дублирующихся правил: {len(removed)}")
PYDIAG

  say "3/6 Перегенерирую compose/Caddy по текущим настройкам и запускаю контейнеры..."
  build_urls "$(get_public_server_ip)" || true
  write_runtime_files || true
  (cd "$APP_DIR" && docker compose up -d) || true

  say "4/6 Перезапускаю helper и updater..."
  install_forwarder_service || true
  install_web_update_service || true
  systemctl restart "$FORWARDER_SERVICE_NAME" 2>/dev/null || true
  systemctl restart "$UPDATER_SERVICE_NAME" 2>/dev/null || true

  say "5/6 Проверяю контейнеры и локальный порт приложения..."
  (cd "$APP_DIR" && docker compose ps) || true
  if command -v docker >/dev/null 2>&1; then
    docker logs --tail=50 "$AGG_CONTAINER_NAME" 2>/dev/null || true
    docker logs --tail=30 "$CADDY_CONTAINER_NAME" 2>/dev/null || true
  fi

  say "6/6 Адреса входа:"
  load_existing_config || true
  local public_url="${PANEL_PUBLIC_URL:-}"
  if [ -z "$public_url" ] && [ -f "$ENV_FILE" ]; then
    public_url="$(grep -E '^PANEL_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  fi
  [ -n "$public_url" ] || public_url="http://${PANEL_IP:-$(get_public_server_ip)}:${APP_PORT:-3000}"
  say "Панель: ${public_url%/}/login"
  warn "Дополнительный URL-ключ не используется. Старые ссылки с ?key= открывают обычную форму входа и больше не дают 404."
  warn "Если после диагностики всё ещё 502/404 — пришли вывод: cd $APP_DIR && docker compose ps && docker logs --tail=120 $AGG_CONTAINER_NAME"
}

client_transfer_database_path() {
  local default_db="$APP_DIR/data/app.db"
  local configured=""
  if [ -f "$ENV_FILE" ]; then
    configured="$(grep -E '^DATA_DIR=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    configured="${configured%\"}"
    configured="${configured#\"}"
    configured="${configured%\'}"
    configured="${configured#\'}"
  fi
  if [ -n "$configured" ]; then
    local candidate=""
    if [[ "$configured" = /* ]]; then candidate="${configured%/}/app.db"; else candidate="$APP_DIR/${configured%/}/app.db"; fi
    # DATA_DIR=/app/data is a path inside Docker and is mounted from
    # APP_DIR/data on the host. Use a configured host path only when it really
    # exists; otherwise keep the standard bind-mount source.
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  fi
  printf '%s\n' "$default_db"
}

client_transfer_help() {
  cat <<'EOF'
Перенос клиентов Nexus Panel напрямую через SQLite (веб-панель может быть остановлена).

Команды:
  agg clients export [FILE]
  agg clients inspect FILE
  agg clients import FILE [--mode skip|update|replace] [--node-mode none|match|selected]
                          [--target-node-ids 1,2] [--dry-run]

Примеры:
  agg clients export /root/nexus-clients.json
  agg clients inspect /root/nexus-clients.json
  agg clients import /root/nexus-clients.json --dry-run
  agg clients import /root/nexus-clients.json --mode update --node-mode match

Безопасный режим по умолчанию: mode=update, node-mode=none.
UUID и sub_slug сохраняются. Импорт не подключается к удалённым узлам и не меняет их.
EOF
}

client_transfer_cli() {
  require_root
  refresh_runtime_paths

  local tool="$APP_DIR/scripts/client-transfer.py"
  local action="${1:-help}"
  if [ "$action" = "help" ] || [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
    client_transfer_help
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    err "python3 не найден. Установи: apt-get update && apt-get install -y python3"
    return 1
  fi
  if [ ! -f "$tool" ]; then
    err "Утилита переноса не найдена: $tool"
    err "Скопируй scripts/client-transfer.py из патча или обнови файлы Nexus Panel."
    return 1
  fi

  case "$action" in
    export)
      shift || true
      local db_path output_path
      db_path="$(client_transfer_database_path)"
      output_path="${1:-/root/nexus-clients-$(date +%F-%H%M%S).json}"
      if [ ! -f "$db_path" ]; then err "База клиентов не найдена: $db_path"; return 1; fi
      say "Экспортирую клиентов из $db_path"
      python3 "$tool" export --db "$db_path" --output "$output_path"
      warn "Файл содержит UUID и идентификаторы подписок. Передавай его безопасно и удали после переноса."
      ;;
    inspect)
      shift || true
      local inspect_path="${1:-}"
      if [ -z "$inspect_path" ]; then err "Укажи файл: agg clients inspect FILE"; return 1; fi
      python3 "$tool" inspect --input "$inspect_path"
      ;;
    import)
      shift || true
      local import_path="${1:-}"
      if [ -z "$import_path" ]; then err "Укажи файл: agg clients import FILE [параметры]"; return 1; fi
      shift || true
      local db_path
      db_path="$(client_transfer_database_path)"
      if [ ! -f "$db_path" ]; then err "База новой панели не найдена: $db_path"; return 1; fi
      python3 "$tool" import --db "$db_path" --input "$import_path" "$@"
      ;;
    *)
      err "Неизвестная команда clients: $action"
      client_transfer_help
      return 1
      ;;
  esac
}

settings_transfer_help() {
  cat <<'EOF'
Зашифрованный перенос настроек Nexus Panel / 3xui-Aggregator.

Команды:
  agg settings export [FILE]
  agg settings inspect FILE
  agg settings import FILE [--dry-run]

Экспорт не содержит клиентов. Переносятся настройки панели, подписок, Happ,
маршрутизации, Telegram, узлы и их секреты, SNI, редиректы, VPN-хосты/сервисы.
Deployment IP/URL, ключ входа и администратор новой панели не заменяются.
Редиректы и VPN-сервисы импортируются отключёнными до ручной проверки.
EOF
}

read_settings_transfer_passphrase() {
  local confirm="${1:-0}"
  if [ -n "${NEXUS_SETTINGS_PASSPHRASE:-}" ]; then
    SETTINGS_TRANSFER_PASSPHRASE="$NEXUS_SETTINGS_PASSPHRASE"
  else
    local first second=""
    read -r -s -p "Парольная фраза файла настроек (минимум 12 символов): " first
    echo
    if [ "$confirm" = "1" ]; then
      read -r -s -p "Повтори парольную фразу: " second
      echo
      if [ "$first" != "$second" ]; then err "Парольные фразы не совпадают."; return 1; fi
    fi
    SETTINGS_TRANSFER_PASSPHRASE="$first"
  fi
  if [ "${#SETTINGS_TRANSFER_PASSPHRASE}" -lt 12 ]; then
    err "Парольная фраза должна содержать минимум 12 символов."
    return 1
  fi
}

run_settings_transfer_in_container() {
  local passphrase="$1"
  shift
  local tool="$APP_DIR/scripts/settings-transfer.js"
  if [ ! -f "$tool" ]; then err "Утилита настроек не найдена: $tool"; return 1; fi
  if ! command -v docker >/dev/null 2>&1; then err "Docker не найден."; return 1; fi

  if docker inspect -f '{{.State.Running}}' "$AGG_CONTAINER_NAME" 2>/dev/null | grep -qx true; then
    # Keep the helper under /app/scripts: it loads ../lib_crypto.js and the
    # container already has the native better-sqlite3 dependency for Node.
    # docker cp also makes this work immediately after applying a files-only
    # patch, before the image has been rebuilt.
    docker cp "$tool" "$AGG_CONTAINER_NAME:/app/scripts/settings-transfer.js" >/dev/null
    printf '%s' "$passphrase" | docker exec -i \
      -e NODE_PATH=/app/node_modules \
      -e NEXUS_SETTINGS_PASSPHRASE_STDIN=1 \
      "$AGG_CONTAINER_NAME" \
      node /app/scripts/settings-transfer.js "$@"
  else
    printf '%s' "$passphrase" | (cd "$APP_DIR" && docker compose run --rm --no-deps -T \
      -v "$tool:/app/scripts/settings-transfer-cli.js:ro" \
      -e NODE_PATH=/app/node_modules \
      -e NEXUS_SETTINGS_PASSPHRASE_STDIN=1 \
      aggregator node /app/scripts/settings-transfer-cli.js "$@")
  fi
}

settings_transfer_cli() {
  require_root
  refresh_runtime_paths
  local action="${1:-help}"
  if [ "$action" = "help" ] || [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
    settings_transfer_help
    return 0
  fi
  if [ ! -f "$APP_DIR/data/app.db" ]; then err "База не найдена: $APP_DIR/data/app.db"; return 1; fi

  case "$action" in
    export)
      shift || true
      local output_path="${1:-/root/nexus-settings-$(date +%F-%H%M%S).nxsettings}"
      local temp_name=".settings-export-$$-$(date +%s).nxsettings"
      read_settings_transfer_passphrase 1
      local command_status=0
      run_settings_transfer_in_container "$SETTINGS_TRANSFER_PASSPHRASE" export \
        --db /app/data/app.db --output "/app/data/$temp_name" || command_status=$?
      if [ "$command_status" -ne 0 ]; then
        [ ! -f "$APP_DIR/data/$temp_name" ] || unlink "$APP_DIR/data/$temp_name"
        return "$command_status"
      fi
      install -m 0600 "$APP_DIR/data/$temp_name" "$output_path"
      unlink "$APP_DIR/data/$temp_name"
      say "Зашифрованные настройки экспортированы: $output_path"
      warn "Не забудь парольную фразу: без неё файл восстановить невозможно."
      ;;
    inspect|import)
      shift || true
      local input_path="${1:-}"
      if [ -z "$input_path" ] || [ ! -f "$input_path" ]; then err "Файл настроек не найден: ${input_path:-не указан}"; return 1; fi
      shift || true
      local temp_name=".settings-input-$$-$(date +%s).nxsettings"
      read_settings_transfer_passphrase 0
      install -m 0600 "$input_path" "$APP_DIR/data/$temp_name"
      local command_status=0
      if [ "$action" = "inspect" ]; then
        run_settings_transfer_in_container "$SETTINGS_TRANSFER_PASSPHRASE" inspect --input "/app/data/$temp_name" || command_status=$?
      else
        run_settings_transfer_in_container "$SETTINGS_TRANSFER_PASSPHRASE" import \
          --db /app/data/app.db --input "/app/data/$temp_name" "$@" || command_status=$?
      fi
      unlink "$APP_DIR/data/$temp_name"
      [ "$command_status" -eq 0 ] || return "$command_status"
      ;;
    *)
      err "Неизвестная команда settings: $action"
      settings_transfer_help
      return 1
      ;;
  esac
}

main_menu() {
  local choice
  while true; do
    echo >&2
    printf "${CYAN}  ╭─ Управление Nexus Panel ──────────────────────────╮${NC}\n" >&2
    printf '  │  1  Установить ещё одну панель                   │\n' >&2
    printf '  │  2  Обновить проект, сохранив данные             │\n' >&2
    printf '  │  3  Изменить параметры панели                    │\n' >&2
    printf '  │  4  Переустановить панель                        │\n' >&2
    printf '  │  5  Создать резервную копию                      │\n' >&2
    printf '  │  6  Восстановить из копии                        │\n' >&2
    printf '  │  7  Удалить проект                               │\n' >&2
    printf '  │  8  Диагностика и автоматическое восстановление  │\n' >&2
    printf '  │  0  Выход                                        │\n' >&2
    printf "${CYAN}  ╰───────────────────────────────────────────────────╯${NC}\n" >&2
    choice="$(ask 'Выбери действие (Enter ничего не запускает)' '')"
    choice="$(trim "$choice")"
    case "$choice" in
      0|1|2|3|4|5|6|7|8) printf '%s\n' "$choice"; return 0 ;;
      '') warn "Действие не выбрано. Ничего не изменено." >&2 ;;
      *) err "Нет такого пункта: $choice" >&2 ;;
    esac
  done
}

confirm_action() {
  local text="$1" answer
  answer="$(ask "$text (введи ДА)" '')"
  answer="$(printf '%s' "$answer" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
  [ "$answer" = "ДА" ] || [ "$answer" = "YES" ]
}

prepare_server_for_deploy() {
  ui_section "Подготовка сервера"
  install_packages
  install_docker_if_needed
  ensure_dir
  load_existing_config
}

main() {
  maybe_clear_screen
  require_root
  ui_init
  ui_install_error_trap
  ui_banner

  refresh_runtime_paths
  load_source_config
  refresh_runtime_paths
  load_existing_config

  if [ -f "$ENV_FILE" ] || [ -f "$INSTALL_CONF" ]; then
    # Запуск свежего install.sh из /tmp или клона сразу чинит установленную
    # копию и ярлык agg — ещё до выбора пункта меню.
    sync_current_installer_to_app
    install_shortcut_command
    local action
    action="$(main_menu)"
    action="$(trim "$action")"

    case "$action" in
      1)
        prepare_server_for_deploy
        fresh_install_flow
        ;;
      2)
        prepare_server_for_deploy
        update_files_only
        ;;
      3)
        prepare_server_for_deploy
        change_settings_and_update
        ;;
      4)
        if ! confirm_action 'Текущие файлы панели будут заменены'; then warn "Переустановка отменена."; exit 0; fi
        prepare_server_for_deploy
        reinstall_full
        ;;
      5)
        create_backup
        exit 0
        ;;
      6)
        if ! confirm_action 'Текущие данные будут заменены данными из выбранной копии'; then warn "Восстановление отменено."; exit 0; fi
        restore_from_backup
        exit 0
        ;;
      7)
        if ! confirm_action 'Панель и её рабочие данные будут удалены'; then warn "Удаление отменено."; exit 0; fi
        delete_project
        ;;
      8)
        run_diagnostics_and_repair
        exit 0
        ;;
      0)
        say "Выход."
        exit 0
        ;;
      *)
        err "Неверный выбор."
        exit 1
        ;;
    esac
  else
    prepare_server_for_deploy
    fresh_install_flow
  fi

  # На всякий случай повторно ставим helper после любого сценария установки/обновления.
  # Это нужно, если обновление заменило файлы проекта или systemd-сервис был удалён.
  install_forwarder_service
  install_web_update_service

  print_result
}


# Test/helper mode is valid only when this file is sourced. Previously an
# exported NEXUS_INSTALLER_LIBRARY_ONLY=1 also suppressed a normal
# `bash install.sh` invocation and produced a completely silent exit.
if [ "${NEXUS_INSTALLER_LIBRARY_ONLY:-0}" = "1" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

if [ "${1:-}" = "clients" ]; then
  shift || true
  client_transfer_cli "$@"
  exit $?
fi

if [ "${1:-}" = "settings" ]; then
  shift || true
  settings_transfer_cli "$@"
  exit $?
fi

if [ "${1:-}" = "repair-shortcut" ]; then
  require_root
  refresh_runtime_paths
  load_source_config
  refresh_runtime_paths
  if [ ! -d "$APP_DIR" ]; then
    err "Установленная Nexus Panel не найдена: $APP_DIR"
    exit 1
  fi
  sync_current_installer_to_app
  install_shortcut_command
  say "Команды agg и agg-${INSTANCE_NAME} восстановлены."
  exit 0
fi

if [ "${1:-}" = "menu" ]; then
  shift || true
  main "$@"
  exit $?
fi

if [ "${1:-}" = "update" ] || [ "${1:-}" = "--update-files-only" ]; then
  maybe_clear_screen
  require_root
  ui_init
  ui_install_error_trap
  ui_banner
  refresh_runtime_paths
  load_source_config
  refresh_runtime_paths
  ui_section "Подготовка сервера"
  install_packages
  install_docker_if_needed
  ensure_dir
  load_existing_config
  update_files_only
  install_forwarder_service
  install_web_update_service
  install_shortcut_command
  print_result
  exit 0
fi

main "$@"
