#!/usr/bin/env bash
# ==============================================================================
# TalentLens AI — Fail-Closed Production Deployment Controller
# Target Architecture: OCI Ubuntu 24.04 VM, Docker Compose, Host/Compose Caddy
# ==============================================================================

set -Eeuo pipefail

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

CURRENT_STAGE="initialization"

fail_deploy() {
    local dependency="$1"
    local reason="$2"
    log_error "Deployment FAILED at stage [${CURRENT_STAGE}] — failing dependency: ${dependency} — ${reason}"
    exit 1
}

on_unexpected_err() {
    local exit_code="$?"
    local line_no="${1:-unknown}"
    log_error "Deployment aborted unexpectedly at line ${line_no} during stage [${CURRENT_STAGE}] (exit=${exit_code})."
    exit "${exit_code}"
}
trap 'on_unexpected_err $LINENO' ERR

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-talentlens}"

DOCKER_BIN="${DOCKER_BIN:-docker}"
CADDY_BIN="${CADDY_BIN:-caddy}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CURL_BIN:-curl}"
NODE_BIN="${NODE_BIN:-node}"

CADDYFILE_PATH="${CADDYFILE_PATH:-/etc/caddy/Caddyfile}"
CADDY_CONF_D="${CADDY_CONF_D:-/etc/caddy/conf.d}"

DEPLOY_DB_RETRIES="${DEPLOY_DB_RETRIES:-30}"
DEPLOY_CLAMAV_RETRIES="${DEPLOY_CLAMAV_RETRIES:-100}"
DEPLOY_SERVICE_RETRIES="${DEPLOY_SERVICE_RETRIES:-30}"
DEPLOY_HTTPS_RETRIES="${DEPLOY_HTTPS_RETRIES:-5}"
DEPLOY_POLL_INTERVAL="${DEPLOY_POLL_INTERVAL:-2}"

# Isolated-test-only strict CA verification hook (NEVER disables TLS validation; -k is forbidden)
TALENTLENS_DEPLOY_TEST_MODE="${TALENTLENS_DEPLOY_TEST_MODE:-0}"
DEPLOY_HTTPS_CURL_CA="${DEPLOY_HTTPS_CURL_CA:-}"
DEPLOY_CURL_RESOLVE="${DEPLOY_CURL_RESOLVE:-}"

COMPOSE_CMD=("${DOCKER_BIN}" compose -p "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

read_env_value() {
    local key="$1"
    local line=""
    line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" 2>/dev/null | tail -n 1 || true)"
    line="${line#*=}"
    line="$(printf '%s' "${line}" | sed -E "s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^'(.*)'$/\1/; s/^\"(.*)\"$/\1/")"
    printf '%s' "${line}"
}

json_has_api_ready() {
    local body="$1"
    if printf '%s' "${body}" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ready"' &&
       printf '%s' "${body}" | grep -qE '"database"[[:space:]]*:[[:space:]]*"connected"'; then
        return 0
    fi
    return 1
}

check_host_caddy_config_and_domain() {
    local expected_host="$1"
    if ! command -v "${CADDY_BIN}" &>/dev/null; then
        fail_deploy "caddy" "Caddy binary (${CADDY_BIN}) is not installed or not in PATH."
    fi
    if ! command -v "${SYSTEMCTL_BIN}" &>/dev/null; then
        fail_deploy "caddy" "systemctl binary (${SYSTEMCTL_BIN}) is required to inspect host-managed Caddy service."
    fi
    if [ ! -f "${CADDYFILE_PATH}" ]; then
        fail_deploy "caddy" "Host Caddyfile does not exist at ${CADDYFILE_PATH}."
    fi
    if ! "${CADDY_BIN}" validate --config "${CADDYFILE_PATH}" >/dev/null 2>&1; then
        fail_deploy "caddy" "Host Caddyfile failed validation (${CADDY_BIN} validate --config ${CADDYFILE_PATH})."
    fi

    local adapted=""
    adapted="$("${CADDY_BIN}" adapt --config "${CADDYFILE_PATH}" 2>/dev/null || true)"
    local domain_found=0
    if [ -n "${adapted}" ] && printf '%s' "${adapted}" | grep -Fq "${expected_host}"; then
        domain_found=1
    elif grep -Fq "${expected_host}" "${CADDYFILE_PATH}" 2>/dev/null; then
        domain_found=1
    elif [ -d "${CADDY_CONF_D}" ] && grep -RFq "${expected_host}" "${CADDY_CONF_D}" 2>/dev/null; then
        domain_found=1
    fi

    if [ "${domain_found}" -ne 1 ]; then
        fail_deploy "caddy" "Configured domain '${expected_host}' was not found in effective Caddy configuration."
    fi

    if ! "${SYSTEMCTL_BIN}" is-active --quiet caddy; then
        fail_deploy "caddy" "Host Caddy systemd service is not active."
    fi
}

echo -e "${BOLD}================================================================================${RESET}"
echo -e "${BOLD}TALENTLENS AI — PRODUCTION DEPLOYMENT & LIFECYCLE CONTROLLER${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
log_info "Initiating deployment sequence at $(date -u '+%Y-%m-%dT%H:%M:%SZ')..."
log_info "Project name: ${COMPOSE_PROJECT_NAME}"
log_info "Environment:  ${ENV_FILE}"
log_info "Compose file: ${COMPOSE_FILE}"

# ------------------------------------------------------------------------------
# 1. Fail-Closed Pre-Deployment Validation (Before Any Service Mutation)
# ------------------------------------------------------------------------------
CURRENT_STAGE="preflight"
log_info "Running fail-closed pre-deployment checks..."

if ! command -v "${DOCKER_BIN}" &>/dev/null; then
    fail_deploy "docker" "Docker binary (${DOCKER_BIN}) is not installed or not in PATH."
fi

if ! "${DOCKER_BIN}" info &>/dev/null; then
    fail_deploy "docker" "Docker daemon is not running or current user lacks socket permissions."
fi

if ! "${DOCKER_BIN}" compose version &>/dev/null; then
    fail_deploy "docker-compose" "Docker Compose V2 ('${DOCKER_BIN} compose') is not available."
fi

if ! command -v "${CURL_BIN}" &>/dev/null; then
    fail_deploy "curl" "curl binary (${CURL_BIN}) is required for readiness probing."
fi

if [ ! -f "${ENV_FILE}" ]; then
    fail_deploy "env-file" "Missing environment file: ${ENV_FILE}"
fi

if [ ! -f "${COMPOSE_FILE}" ]; then
    fail_deploy "compose-file" "Missing Compose definition file: ${COMPOSE_FILE}"
fi

if [ "${TALENTLENS_DEPLOY_TEST_MODE}" != "1" ] && { [ -n "${DEPLOY_HTTPS_CURL_CA}" ] || [ -n "${DEPLOY_CURL_RESOLVE}" ]; }; then
    fail_deploy "tls-policy" "Test-only CA/resolve overrides are forbidden outside explicit isolated test mode."
fi

# Environment preflight (never warn-and-skip)
if command -v "${NODE_BIN}" &>/dev/null && [ -f "scripts/preflight-env.mjs" ]; then
    log_info "Executing configuration preflight audit..."
    if ! "${NODE_BIN}" scripts/preflight-env.mjs "${ENV_FILE}"; then
        fail_deploy "env-preflight" "scripts/preflight-env.mjs rejected ${ENV_FILE}."
    fi
    log_success "Environment configuration passed security preflight."
else
    log_info "Node not available for JS preflight; executing strict Bash env audit without printing secrets..."
    ENV_NODE_ENV="$(read_env_value NODE_ENV)"
    if [ "${ENV_NODE_ENV}" != "production" ]; then
        fail_deploy "env-preflight" "NODE_ENV must be set to 'production' in ${ENV_FILE}."
    fi
    for req_key in APP_ORIGIN DATABASE_URL POSTGRES_PASSWORD POSTGRES_USER POSTGRES_DB EMAIL_OUTBOX_ENCRYPTION_KEY EMAIL_OUTBOX_IDEMPOTENCY_SECRET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET SMTP_HOST SMTP_PORT EMAIL_FROM GEMINI_API_KEY; do
        if [ -z "$(read_env_value "${req_key}")" ]; then
            fail_deploy "env-preflight" "Required environment variable '${req_key}' is missing or empty in ${ENV_FILE}."
        fi
    done
fi

PUBLIC_ORIGIN="$(read_env_value APP_ORIGIN)"
if [[ ! "${PUBLIC_ORIGIN}" =~ ^https://([A-Za-z0-9.-]+)(:([0-9]+))?$ ]]; then
    fail_deploy "app-origin" "APP_ORIGIN must be a valid https://<domain>[:port] origin without a path or trailing slash."
fi
PUBLIC_HOST="${BASH_REMATCH[1]}"
PUBLIC_PORT="${BASH_REMATCH[3]:-443}"
log_info "Target public HTTPS origin: ${PUBLIC_ORIGIN}"

# Validate Compose syntax, required services, and persistent volumes without printing secrets
if ! "${COMPOSE_CMD[@]}" config --quiet; then
    fail_deploy "compose-config" "Docker Compose configuration validation failed for ${COMPOSE_FILE}."
fi

COMPOSE_SERVICES="$("${COMPOSE_CMD[@]}" config --services)"
for req_svc in postgres clamav migration api worker web; do
    if ! printf '%s\n' "${COMPOSE_SERVICES}" | grep -qx "${req_svc}"; then
        fail_deploy "compose-services" "Required service '${req_svc}' is missing from ${COMPOSE_FILE}."
    fi
done

COMPOSE_VOLUMES="$("${COMPOSE_CMD[@]}" config --volumes)"
for req_vol in pgdata clamav_db; do
    if ! printf '%s\n' "${COMPOSE_VOLUMES}" | grep -qx "${req_vol}"; then
        fail_deploy "compose-volumes" "Required persistent volume '${req_vol}' is missing from ${COMPOSE_FILE}."
    fi
done

if printf '%s\n' "${COMPOSE_SERVICES}" | grep -qx "caddy"; then
    CADDY_TOPOLOGY="compose"
else
    CADDY_TOPOLOGY="host"
fi
log_info "Detected Caddy ingress topology: ${CADDY_TOPOLOGY}"

if [ "${CADDY_TOPOLOGY}" = "host" ]; then
    check_host_caddy_config_and_domain "${PUBLIC_HOST}"
    log_success "Pre-deployment host Caddy validation passed for domain '${PUBLIC_HOST}'."
fi

# ------------------------------------------------------------------------------
# 2. Build Production Application Containers
# ------------------------------------------------------------------------------
CURRENT_STAGE="build"
log_info "Building production application container images (web, api, worker)..."
if ! "${COMPOSE_CMD[@]}" build web api worker; then
    fail_deploy "docker-build" "Failed to build one or more application container images."
fi
log_success "Container images built successfully."

# ------------------------------------------------------------------------------
# 3. Start PostgreSQL 17 Database & Verify Connectivity
# ------------------------------------------------------------------------------
CURRENT_STAGE="postgres-readiness"
log_info "Starting PostgreSQL 17 database container..."
if ! "${COMPOSE_CMD[@]}" up -d postgres; then
    fail_deploy "postgres" "Failed to start postgres service."
fi

log_info "Waiting for PostgreSQL container health..."
DB_HEALTHY=0
for _ in $(seq 1 "${DEPLOY_DB_RETRIES}"); do
    STATUS="$("${COMPOSE_CMD[@]}" ps postgres --format "{{.Health}}" 2>/dev/null || echo "")"
    if [ "${STATUS}" = "healthy" ]; then
        DB_HEALTHY=1
        break
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${DB_HEALTHY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs postgres --tail 30 >&2 || true
    fail_deploy "postgres" "PostgreSQL did not reach healthy state."
fi

PG_USER="$(read_env_value POSTGRES_USER)"
PG_DB="$(read_env_value POSTGRES_DB)"
PG_USER="${PG_USER:-talentlens}"
PG_DB="${PG_DB:-talentlens}"
if ! "${COMPOSE_CMD[@]}" exec -T postgres pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
    "${COMPOSE_CMD[@]}" logs postgres --tail 30 >&2 || true
    fail_deploy "postgres" "PostgreSQL failed pg_isready connectivity verification."
fi
log_success "PostgreSQL 17 is healthy and accepting connections."

# ------------------------------------------------------------------------------
# 4. Execute Atomic Database Migrations
# ------------------------------------------------------------------------------
CURRENT_STAGE="migration"
log_info "Applying pending Prisma database migrations..."
if ! "${COMPOSE_CMD[@]}" run --rm migration; then
    fail_deploy "migration" "Prisma database migration container exited non-zero."
fi
log_success "Prisma database migrations applied successfully."

# ------------------------------------------------------------------------------
# 5. Start ClamAV Antivirus Daemon & Wait for Health
# ------------------------------------------------------------------------------
CURRENT_STAGE="clamav-readiness"
log_info "Starting ClamAV antivirus daemon container..."
if ! "${COMPOSE_CMD[@]}" up -d clamav; then
    fail_deploy "clamav" "Failed to start clamav service."
fi

log_info "Waiting for ClamAV daemon readiness..."
CLAMAV_HEALTHY=0
for _ in $(seq 1 "${DEPLOY_CLAMAV_RETRIES}"); do
    STATUS="$("${COMPOSE_CMD[@]}" ps clamav --format "{{.Health}}" 2>/dev/null || echo "")"
    if [ "${STATUS}" = "healthy" ]; then
        CLAMAV_HEALTHY=1
        break
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${CLAMAV_HEALTHY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs clamav --tail 30 >&2 || true
    fail_deploy "clamav" "ClamAV antivirus daemon did not reach healthy state."
fi
log_success "ClamAV daemon is healthy and accepting stream scans."

# ------------------------------------------------------------------------------
# 6. Start API, Background Worker, Web (and Compose Caddy if applicable)
# ------------------------------------------------------------------------------
CURRENT_STAGE="compose-up"
SERVICES_TO_START=(api worker web)
if [ "${CADDY_TOPOLOGY}" = "compose" ]; then
    SERVICES_TO_START+=(caddy)
fi

log_info "Starting application services (${SERVICES_TO_START[*]})..."
if ! "${COMPOSE_CMD[@]}" up -d "${SERVICES_TO_START[@]}"; then
    fail_deploy "compose-up" "Failed to start application services (${SERVICES_TO_START[*]})."
fi

WEB_PORT="$(read_env_value WEB_PORT)"
WEB_PORT="${WEB_PORT:-8080}"

# ------------------------------------------------------------------------------
# 7. API & Web Readiness Verification
# ------------------------------------------------------------------------------
CURRENT_STAGE="api-readiness"
log_info "Waiting for API container health..."
API_HEALTHY=0
for _ in $(seq 1 "${DEPLOY_SERVICE_RETRIES}"); do
    STATUS="$("${COMPOSE_CMD[@]}" ps api --format "{{.Health}}" 2>/dev/null || echo "")"
    if [ "${STATUS}" = "healthy" ]; then
        API_HEALTHY=1
        break
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${API_HEALTHY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs api --tail 40 >&2 || true
    fail_deploy "api" "TalentLens API container did not report healthy status."
fi
log_success "TalentLens API container healthcheck passed."

CURRENT_STAGE="web-readiness"
WEB_READY=0
for _ in $(seq 1 "${DEPLOY_SERVICE_RETRIES}"); do
    HTTP_CODE="$("${CURL_BIN}" -sS -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || echo "000")"
    if [ "${HTTP_CODE}" = "200" ]; then
        WEB_READY=1
        break
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${WEB_READY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs web --tail 30 >&2 || true
    fail_deploy "web" "TalentLens Web container failed to return HTTP 200 on 127.0.0.1:${WEB_PORT}/."
fi
log_success "TalentLens Web container is serving on 127.0.0.1:${WEB_PORT}."

CURRENT_STAGE="api-db-readiness"
PROXY_READY=0
API_READY_BODY=""
for _ in $(seq 1 "${DEPLOY_SERVICE_RETRIES}"); do
    if API_READY_BODY="$("${CURL_BIN}" -sS -f --connect-timeout 3 --max-time 5 "http://127.0.0.1:${WEB_PORT}/api/v1/health/ready" 2>/dev/null)"; then
        if json_has_api_ready "${API_READY_BODY}"; then
            PROXY_READY=1
            break
        fi
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${PROXY_READY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs web --tail 30 >&2 || true
    "${COMPOSE_CMD[@]}" logs api --tail 40 >&2 || true
    fail_deploy "api" "API readiness endpoint (/api/v1/health/ready) did not report ready with database connected."
fi
log_success "API DB readiness verified through Nginx proxy (/api/v1/health/ready)."

# ------------------------------------------------------------------------------
# 8. Worker Readiness Verification (Fail-Closed)
# ------------------------------------------------------------------------------
CURRENT_STAGE="worker-readiness"
log_info "Waiting for Background Worker readiness verification (loop heartbeat + database)..."
WORKER_HEALTHY=0
for _ in $(seq 1 "${DEPLOY_SERVICE_RETRIES}"); do
    WORKER_STATUS="$("${COMPOSE_CMD[@]}" ps worker --format "{{.Health}}" 2>/dev/null || echo "")"
    WORKER_STATE="$("${COMPOSE_CMD[@]}" ps worker --format "{{.State}}" 2>/dev/null || echo "")"
    if [ "${WORKER_STATUS}" = "healthy" ] && printf '%s' "${WORKER_STATE}" | grep -qiE "running|up"; then
        WORKER_HEALTHY=1
        break
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${WORKER_HEALTHY}" -ne 1 ]; then
    "${COMPOSE_CMD[@]}" logs worker --tail 40 >&2 || true
    fail_deploy "worker" "Background worker failed health/readiness verification."
fi
log_success "Background Worker is healthy and actively polling PostgreSQL."

# ------------------------------------------------------------------------------
# 9. Caddy Ingress Validation & Non-Destructive Reload
# ------------------------------------------------------------------------------
CURRENT_STAGE="caddy-validation"
if [ "${CADDY_TOPOLOGY}" = "compose" ]; then
    log_info "Validating Compose-managed Caddy service..."
    CADDY_READY=0
    for _ in $(seq 1 "${DEPLOY_SERVICE_RETRIES}"); do
        CADDY_HEALTH="$("${COMPOSE_CMD[@]}" ps caddy --format "{{.Health}}" 2>/dev/null || echo "")"
        CADDY_STATE="$("${COMPOSE_CMD[@]}" ps caddy --format "{{.State}}" 2>/dev/null || echo "")"
        if { [ "${CADDY_HEALTH}" = "healthy" ] || { [ -z "${CADDY_HEALTH}" ] && printf '%s' "${CADDY_STATE}" | grep -qiE "running|up"; }; }; then
            CADDY_READY=1
            break
        fi
        sleep "${DEPLOY_POLL_INTERVAL}"
    done
    if [ "${CADDY_READY}" -ne 1 ]; then
        "${COMPOSE_CMD[@]}" logs caddy --tail 40 >&2 || true
        fail_deploy "caddy" "Compose-managed Caddy service failed to become healthy."
    fi
    if ! "${COMPOSE_CMD[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        fail_deploy "caddy" "Compose Caddy configuration validation failed."
    fi
    if ! "${COMPOSE_CMD[@]}" exec -T caddy caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null | grep -Fq "${PUBLIC_HOST}"; then
        fail_deploy "caddy" "Compose Caddy effective configuration does not include site '${PUBLIC_HOST}'."
    fi
    log_success "Compose-managed Caddy verified for site '${PUBLIC_HOST}'."
else
    log_info "Validating and reloading host-managed Caddy service..."
    check_host_caddy_config_and_domain "${PUBLIC_HOST}"
    if ! "${SYSTEMCTL_BIN}" reload caddy; then
        fail_deploy "caddy" "Failed to reload active host Caddy service."
    fi
    if ! "${SYSTEMCTL_BIN}" is-active --quiet caddy; then
        fail_deploy "caddy" "Host Caddy service became inactive after reload."
    fi
    log_success "Host Caddy validated and reloaded without altering unrelated configuration."
fi

# ------------------------------------------------------------------------------
# 10. Public HTTPS Endpoint & Strict TLS Certificate Verification
# ------------------------------------------------------------------------------
CURRENT_STAGE="https-readiness"
HTTPS_HEALTH_URL="${PUBLIC_ORIGIN}/api/v1/health/ready"
log_info "Verifying public HTTPS ingress & strict TLS validation: ${HTTPS_HEALTH_URL}"

CURL_HTTPS_ARGS=(-sS -f --connect-timeout 5 --max-time 15)
if [ "${TALENTLENS_DEPLOY_TEST_MODE}" = "1" ] && [ -n "${DEPLOY_HTTPS_CURL_CA}" ]; then
    if [ ! -f "${DEPLOY_HTTPS_CURL_CA}" ]; then
        fail_deploy "https" "Test CA certificate bundle does not exist: ${DEPLOY_HTTPS_CURL_CA}"
    fi
    CURL_HTTPS_ARGS+=(--cacert "${DEPLOY_HTTPS_CURL_CA}")
fi
if [ "${TALENTLENS_DEPLOY_TEST_MODE}" = "1" ] && [ -n "${DEPLOY_CURL_RESOLVE}" ]; then
    CURL_HTTPS_ARGS+=(--resolve "${DEPLOY_CURL_RESOLVE}")
fi

HTTPS_OK=0
HTTPS_BODY=""
for _ in $(seq 1 "${DEPLOY_HTTPS_RETRIES}"); do
    if HTTPS_BODY="$("${CURL_BIN}" "${CURL_HTTPS_ARGS[@]}" "${HTTPS_HEALTH_URL}" 2>/dev/null)"; then
        if json_has_api_ready "${HTTPS_BODY}"; then
            HTTPS_OK=1
            break
        fi
    fi
    sleep "${DEPLOY_POLL_INTERVAL}"
done

if [ "${HTTPS_OK}" -ne 1 ]; then
    # Capture non-secret diagnostic curl error cleanly without -k
    "${CURL_BIN}" "${CURL_HTTPS_ARGS[@]}" "${HTTPS_HEALTH_URL}" >/dev/null || true
    fail_deploy "https" "Public HTTPS endpoint verification failed (DNS, TLS certificate, HTTP status, or API readiness payload mismatch) for ${HTTPS_HEALTH_URL}."
fi
log_success "Public HTTPS ingress and strict TLS verification succeeded for ${HTTPS_HEALTH_URL}."

# ------------------------------------------------------------------------------
# 11. Deployment Summary (Printed ONLY After Every Gate Passed)
# ------------------------------------------------------------------------------
CURRENT_STAGE="completed"
echo -e "\n${BOLD}================================================================================${RESET}"
echo -e "${GREEN}${BOLD}TALENTLENS AI — PRODUCTION DEPLOYMENT COMPLETE${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
echo -e "  • PostgreSQL 17:     Healthy (Container: ${COMPOSE_PROJECT_NAME}-postgres)"
echo -e "  • ClamAV Antivirus:  Healthy (Container: ${COMPOSE_PROJECT_NAME}-clamav)"
echo -e "  • Express API:       Ready   (Container: ${COMPOSE_PROJECT_NAME}-api, DB connected)"
echo -e "  • Background Worker: Healthy (Container: ${COMPOSE_PROJECT_NAME}-worker, loop & DB verified)"
echo -e "  • React/Nginx Web:   Serving (Container: ${COMPOSE_PROJECT_NAME}-web -> 127.0.0.1:${WEB_PORT})"
echo -e "  • Ingress (${CADDY_TOPOLOGY}):    Validated & Active (${PUBLIC_ORIGIN})"
echo -e "================================================================================\n"
log_info "To bootstrap your initial recruiter organization account, execute:"
echo -e "  ${BOLD}${COMPOSE_CMD[*]} exec api node apps/api/dist/scripts/bootstrap.js \"Your Org Name\" \"recruiter@yourdomain.com\"${RESET}\n"
