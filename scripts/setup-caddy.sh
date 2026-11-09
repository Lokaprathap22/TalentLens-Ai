#!/usr/bin/env bash
# ==============================================================================
# TalentLens AI — Host Caddy Setup & Automatic TLS Provisioning
# Target OS: OCI Ubuntu 24.04 VM
# ==============================================================================

set -euo pipefail

# ANSI Color codes
BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

log_info() {
    echo -e "${BLUE}[INFO]${RESET} ${1}"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${RESET} ${1}"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${RESET} ${1}"
}

log_error() {
    echo -e "${RED}[ERROR]${RESET} ${1}" >&2
}

FORCE_OVERWRITE=false
DOMAIN=""
for ARG in "$@"; do
    case "${ARG}" in
        --force)
            FORCE_OVERWRITE=true
            ;;
        --help|-h)
            echo "Usage: sudo ./scripts/setup-caddy.sh [--force] [yourdomain.com]"
            exit 0
            ;;
        -*)
            log_error "Unknown option: ${ARG}"
            echo "Usage: sudo ./scripts/setup-caddy.sh [--force] [yourdomain.com]"
            exit 1
            ;;
        *)
            if [ -z "${DOMAIN}" ]; then
                DOMAIN="${ARG}"
            else
                log_error "Unexpected positional argument: ${ARG}"
                echo "Usage: sudo ./scripts/setup-caddy.sh [--force] [yourdomain.com]"
                exit 1
            fi
            ;;
    esac
done

DOMAIN="${DOMAIN:-${APP_DOMAIN:-}}"
CADDYFILE_PATH="${CADDYFILE_PATH:-/etc/caddy/Caddyfile}"
CONF_D="${CONF_D:-/etc/caddy/conf.d}"
LOG_DIR="${LOG_DIR:-/var/log/caddy}"

echo -e "${BOLD}================================================================================${RESET}"
echo -e "${BOLD}TALENTLENS AI — HOST CADDY REVERSE PROXY & TLS AUTOMATION${RESET}"
echo -e "${BOLD}================================================================================${RESET}"

# ------------------------------------------------------------------------------
# 1. Root / Sudo Check
# ------------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    log_error "This script must be executed as root (or with sudo)."
    echo "Usage: sudo ./scripts/setup-caddy.sh [yourdomain.com]"
    exit 1
fi

# ------------------------------------------------------------------------------
# 2. OS Verification (Ubuntu 22.04 or 24.04)
# ------------------------------------------------------------------------------
log_info "Verifying host operating system..."
if [ -f "/etc/os-release" ]; then
    . /etc/os-release
    if [ "${ID:-}" != "ubuntu" ]; then
        log_warn "Host OS is ${NAME:-unknown}. This script is optimized for Ubuntu 24.04 / 22.04."
    else
        log_success "Verified OS: ${PRETTY_NAME}"
    fi
else
    log_warn "Cannot determine operating system from /etc/os-release."
fi

# ------------------------------------------------------------------------------
# 3. Domain Resolution & Validation
# ------------------------------------------------------------------------------
if [ -z "${DOMAIN}" ]; then
    if [ -f ".env" ]; then
        # Attempt to read APP_ORIGIN from .env
        APP_ORIGIN=$(grep -E '^APP_ORIGIN=' .env | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "")
        if [ -n "${APP_ORIGIN}" ]; then
            DOMAIN=$(echo "${APP_ORIGIN}" | sed -E 's|^https?://||; s|:[0-9]+$||; s|/.*$||')
        fi
    fi
fi

if [ -z "${DOMAIN}" ]; then
    echo -e "\n${YELLOW}No public domain provided as argument or found in APP_ORIGIN.${RESET}"
    read -r -p "Enter your public production domain (e.g. app.talentlens.ai): " DOMAIN
fi

if [ -z "${DOMAIN}" ]; then
    log_error "A valid domain name is required for automatic HTTPS provisioning."
    exit 1
fi

if [[ ! "${DOMAIN}" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    log_error "Invalid domain format: ${DOMAIN}"
    exit 1
fi

log_info "Configuring Caddy reverse proxy for domain: ${BOLD}${DOMAIN}${RESET}"

# ------------------------------------------------------------------------------
# 4. Port Availability Checks (80 and 443)
# ------------------------------------------------------------------------------
log_info "Checking port 80 and 443 availability on host..."
if command -v ss &>/dev/null; then
    for PORT in 80 443; do
        if ss -tuln | grep -q ":${PORT} "; then
            OCCUPANT=$(ss -tulpn | grep ":${PORT} " || echo "")
            if echo "${OCCUPANT}" | grep -q "caddy"; then
                log_info "Port ${PORT} is currently managed by Caddy (expected)."
            else
                log_warn "Port ${PORT} is currently in use by another process:"
                echo "  ${OCCUPANT}"
                log_warn "Caddy requires port 80 and 443 for automatic Let's Encrypt / ZeroSSL TLS certificate issuance."
            fi
        fi
    done
else
    log_warn "ss utility not found; skipping port occupancy check."
fi

# ------------------------------------------------------------------------------
# 5. Install Official Caddy if Missing
# ------------------------------------------------------------------------------
if ! command -v caddy &>/dev/null; then
    log_info "Installing official Caddy web server from official apt repository..."
    apt-get update -y
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg

    curl -1sLF 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLF 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list

    apt-get update -y
    apt-get install -y caddy
    log_success "Caddy installed successfully: $(caddy version)"
else
    log_success "Caddy is already installed: $(caddy version)"
fi

# ------------------------------------------------------------------------------
# 6. Non-Destructive Production Caddyfile Configuration
# ------------------------------------------------------------------------------
TALENTLENS_SNIPPET="${CONF_D}/talentlens.caddy"
CHECKSUM_FILE="${CONF_D}/.talentlens.caddy.sha256"
CADDYFILE_DIR="$(dirname "${CADDYFILE_PATH}")"

compute_sha256() {
    local target="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "${target}" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "${target}" | awk '{print $1}'
    else
        openssl dgst -sha256 "${target}" | awk '{print $NF}'
    fi
}

TMP_SNIPPET=""
cleanup_tmp() {
    if [ -n "${TMP_SNIPPET}" ] && [ -f "${TMP_SNIPPET}" ]; then
        rm -f "${TMP_SNIPPET}"
    fi
}
trap cleanup_tmp EXIT

log_info "Configuring non-destructive Caddy reverse proxy for ${DOMAIN}..."

mkdir -p "${CADDYFILE_DIR}" "${CONF_D}" "${LOG_DIR}"
chown -R caddy:caddy "${LOG_DIR}" 2>/dev/null || true

# Render deterministic snippet (no volatile timestamp) so drift detection is exact
TMP_SNIPPET="$(mktemp)"
cat <<EOF > "${TMP_SNIPPET}"
# ==============================================================================
# TalentLens AI — Host Caddyfile Reverse Proxy
# Managed by setup-caddy.sh (checksum tracked; use --force to overwrite edits)
# ==============================================================================

${DOMAIN} {
    encode gzip zstd

    # Strict Production Security Headers
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        -Server
    }

    # Reverse proxy to the local Nginx web container serving the frontend SPA
    # and routing /api/ internally to the Express API container
    reverse_proxy 127.0.0.1:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }

    # Access logging with retention rotation
    log {
        output file ${LOG_DIR}/talentlens_access.log {
            roll_size 50mb
            roll_keep 7
        }
    }
}
EOF

DESIRED_HASH="$(compute_sha256 "${TMP_SNIPPET}")"

# Drift detection: refuse to overwrite modified/unmanaged snippet unless --force is supplied
if [ -f "${TALENTLENS_SNIPPET}" ]; then
    EXISTING_HASH="$(compute_sha256 "${TALENTLENS_SNIPPET}")"
    DRIFT_DETECTED=false
    if [ -f "${CHECKSUM_FILE}" ]; then
        RECORDED_HASH="$(tr -d '[:space:]' < "${CHECKSUM_FILE}")"
        if [ "${EXISTING_HASH}" != "${RECORDED_HASH}" ]; then
            DRIFT_DETECTED=true
        fi
    elif [ "${EXISTING_HASH}" != "${DESIRED_HASH}" ]; then
        DRIFT_DETECTED=true
    fi

    if [ "${DRIFT_DETECTED}" = "true" ] && [ "${FORCE_OVERWRITE}" != "true" ]; then
        log_error "Manual modifications or drift detected in ${TALENTLENS_SNIPPET}."
        log_error "Refusing to overwrite custom configuration. Re-run with --force to replace it."
        exit 1
    fi

    if [ "${DRIFT_DETECTED}" = "true" ] && [ "${FORCE_OVERWRITE}" = "true" ]; then
        log_warn "Overwriting modified ${TALENTLENS_SNIPPET} because --force was provided."
    fi
fi

# Create timestamped backups of Caddyfile, snippet, and checksum before writing
BACKUP_TS="$(date +%s)"
CADDYFILE_EXISTED=false
SNIPPET_EXISTED=false
CHECKSUM_EXISTED=false
BACKUP_PATH="${CADDYFILE_PATH}.backup.${BACKUP_TS}"
SNIPPET_BACKUP="${CADDYFILE_DIR}/talentlens.caddy.backup.${BACKUP_TS}"
CHECKSUM_BACKUP="${CADDYFILE_DIR}/talentlens.caddy.sha256.backup.${BACKUP_TS}"

if [ -f "${CADDYFILE_PATH}" ]; then
    CADDYFILE_EXISTED=true
    cp "${CADDYFILE_PATH}" "${BACKUP_PATH}"
    log_info "Backed up existing Caddyfile to ${BACKUP_PATH}"
fi

if [ -f "${TALENTLENS_SNIPPET}" ]; then
    SNIPPET_EXISTED=true
    cp "${TALENTLENS_SNIPPET}" "${SNIPPET_BACKUP}"
    log_info "Backed up existing Caddy snippet to ${SNIPPET_BACKUP}"
fi

if [ -f "${CHECKSUM_FILE}" ]; then
    CHECKSUM_EXISTED=true
    cp "${CHECKSUM_FILE}" "${CHECKSUM_BACKUP}"
fi

rollback_caddy_config() {
    if [ "${SNIPPET_EXISTED}" = "true" ] && [ -f "${SNIPPET_BACKUP}" ]; then
        cp "${SNIPPET_BACKUP}" "${TALENTLENS_SNIPPET}"
    else
        rm -f "${TALENTLENS_SNIPPET}"
    fi

    if [ "${CHECKSUM_EXISTED}" = "true" ] && [ -f "${CHECKSUM_BACKUP}" ]; then
        cp "${CHECKSUM_BACKUP}" "${CHECKSUM_FILE}"
    else
        rm -f "${CHECKSUM_FILE}"
    fi

    if [ "${CADDYFILE_EXISTED}" = "true" ] && [ -f "${BACKUP_PATH}" ]; then
        cp "${BACKUP_PATH}" "${CADDYFILE_PATH}"
    else
        rm -f "${CADDYFILE_PATH}"
    fi
}

# Ensure main Caddyfile exists and imports CONF_D/*.caddy
if [ ! -f "${CADDYFILE_PATH}" ]; then
    log_info "Creating default Caddyfile importing conf.d directory..."
    cat <<EOF > "${CADDYFILE_PATH}"
# ==============================================================================
# TalentLens AI — Host Caddyfile
# ==============================================================================
import ${CONF_D}/*.caddy
EOF
elif ! grep -qE "import[[:space:]]+((/etc/caddy/|${CONF_D}/)?conf\.d/\*\.caddy|${CONF_D}/\*\.caddy)" "${CADDYFILE_PATH}"; then
    log_info "Safely adding conf.d import directive to existing Caddyfile without modifying existing host sites..."
    cat <<EOF >> "${CADDYFILE_PATH}"

# TalentLens conf.d import
import ${CONF_D}/*.caddy
EOF
fi

cp "${TMP_SNIPPET}" "${TALENTLENS_SNIPPET}"
printf '%s\n' "${DESIRED_HASH}" > "${CHECKSUM_FILE}"

log_success "TalentLens Caddy snippet configured at ${TALENTLENS_SNIPPET}."

# ------------------------------------------------------------------------------
# 7. Validate and Reload Caddy (Fail-Safe with Rollback)
# ------------------------------------------------------------------------------
log_info "Validating Caddyfile syntax..."
if ! caddy validate --config "${CADDYFILE_PATH}"; then
    log_error "Caddy validation failed. Rolling back configuration..."
    rollback_caddy_config
    exit 1
fi

log_info "Enabling and reloading Caddy systemd service..."
if ! systemctl enable caddy; then
    log_error "Failed to enable Caddy systemd unit. Rolling back configuration..."
    rollback_caddy_config
    exit 1
fi

if systemctl is-active --quiet caddy; then
    if ! systemctl reload caddy; then
        log_warn "Caddy reload failed; attempting restart before deciding rollback..."
        if ! systemctl restart caddy; then
            log_error "Caddy reload and restart both failed. Rolling back configuration..."
            rollback_caddy_config
            systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
            exit 1
        fi
    fi
else
    if ! systemctl start caddy; then
        log_error "Caddy failed to start. Rolling back configuration..."
        rollback_caddy_config
        exit 1
    fi
fi

if systemctl is-active --quiet caddy; then
    log_success "Caddy service is active and running."
else
    log_error "Caddy service failed health check after reload. Rolling back configuration..."
    rollback_caddy_config
    systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
    log_error "Inspect logs with: journalctl -u caddy --no-pager -n 50"
    exit 1
fi

# ------------------------------------------------------------------------------
# 8. OCI Security List Firewall Guidance
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}================================================================================${RESET}"
echo -e "${GREEN}${BOLD}CADDY REVERSE PROXY CONFIGURED SUCCESSFULLY${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
echo -e "  • Domain:          ${DOMAIN}"
echo -e "  • Upstream Proxy:  http://127.0.0.1:8080 (Docker web container)"
echo -e "  • TLS:             Automatic ACME certificates (Let's Encrypt / ZeroSSL)"
echo -e "  • Caddyfile:       ${CADDYFILE_PATH}"
echo -e "  • Access Logs:     ${LOG_DIR}/talentlens_access.log"
echo -e "================================================================================\n"

log_info "OCI Security List & Firewall Checklist:"
echo -e "  1. In your OCI Console VCN Security List, ensure the following INGRESS rules are open:"
echo -e "     - ${BOLD}Port 80 TCP${RESET}  (HTTP redirect & ACME HTTP-01 challenge) from 0.0.0.0/0"
echo -e "     - ${BOLD}Port 443 TCP${RESET} (HTTPS encrypted traffic) from 0.0.0.0/0"
echo -e "  2. Ensure internal ports (${BOLD}3000, 5432, 8080, 3310${RESET}) are NOT exposed to the public internet."
echo -e "  3. If Ubuntu ufw is enabled on the VM, allow traffic:"
echo -e "     ${BOLD}sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw reload${RESET}\n"

