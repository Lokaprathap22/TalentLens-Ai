#!/usr/bin/env bash
# ==============================================================================
# TalentLens AI — Production PostgreSQL Database Backup Automation
# Backs up a PostgreSQL database with explicit targeting, format validation,
# SHA-256 verification, restrictive permissions, and safe retention rotation.
# ==============================================================================

set -Eeuo pipefail

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

usage() {
    cat <<'EOF'
Usage: ./scripts/backup.sh [options]

Options:
  -d, --database <name>       Target PostgreSQL database name (default: POSTGRES_DB or talentlens)
  -u, --user <name>           PostgreSQL role name (default: POSTGRES_USER or talentlens)
  -o, --backup-dir <dir>      Output backup directory (default: /var/backups/talentlens)
  -r, --retention-days <days> Positive integer retention days (default: 7)
  -f, --compose-file <file>   Compose file path (default: docker-compose.prod.yml)
  -c, --container <name>      Explicit PostgreSQL container name
      --format <plain|custom> Archive format: plain (.sql.gz, default) or custom (.dump)
      --env-file <file>       Optional env file for safe variable lookup (default: .env)
  -h, --help                  Show this help text
EOF
}

DOCKER_BIN="${DOCKER_BIN:-docker}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/talentlens}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TARGET_CONTAINER="${TARGET_CONTAINER:-}"
BACKUP_FORMAT="${BACKUP_FORMAT:-plain}"
EXPLICIT_DB=""
EXPLICIT_USER=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        -d|--database)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            EXPLICIT_DB="$2"
            shift 2
            ;;
        -u|--user)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            EXPLICIT_USER="$2"
            shift 2
            ;;
        -o|--backup-dir)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            BACKUP_DIR="$2"
            shift 2
            ;;
        -r|--retention-days)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            RETENTION_DAYS="$2"
            shift 2
            ;;
        -f|--compose-file)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            COMPOSE_FILE="$2"
            shift 2
            ;;
        -c|--container)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            TARGET_CONTAINER="$2"
            shift 2
            ;;
        --format)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            BACKUP_FORMAT="$2"
            shift 2
            ;;
        --env-file)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            ENV_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            usage
            exit 1
            ;;
    esac
done

read_env_var() {
    local key="$1"
    local file="$2"
    [ -f "${file}" ] || return 0
    local line
    line=$(grep -E "^${key}=" "${file}" | tail -n 1 || true)
    if [ -n "${line}" ]; then
        line="${line#*=}"
        line="${line%$'\r'}"
        line="${line#\"}"
        line="${line%\"}"
        line="${line#\'}"
        line="${line%\'}"
        printf '%s' "${line}"
    fi
}

validate_pg_identifier() {
    local val="$1"
    local label="$2"
    if [[ ! "${val}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
        log_error "Invalid ${label}: '${val}'. Must match ^[A-Za-z_][A-Za-z0-9_-]*$."
        exit 1
    fi
}

compute_sha256() {
    local target="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "${target}" | awk '{print tolower($1)}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "${target}" | awk '{print tolower($1)}'
    elif command -v openssl &>/dev/null; then
        openssl dgst -sha256 "${target}" | awk '{print tolower($NF)}'
    else
        log_error "No SHA-256 tool available (sha256sum, shasum, or openssl required)."
        exit 1
    fi
}

get_mtime_epoch() {
    local target="$1"
    if stat -c %Y "${target}" 2>/dev/null; then
        return 0
    elif stat -f %m "${target}" 2>/dev/null; then
        return 0
    else
        log_error "Unable to read modification time for ${target}."
        return 1
    fi
}

if [[ ! "${RETENTION_DAYS}" =~ ^[1-9][0-9]*$ ]]; then
    log_error "Invalid RETENTION_DAYS '${RETENTION_DAYS}'. Must be a positive integer (>= 1)."
    exit 1
fi

case "${BACKUP_FORMAT}" in
    plain|custom) ;;
    *)
        log_error "Unsupported backup format '${BACKUP_FORMAT}'. Supported values: plain, custom."
        exit 1
        ;;
esac

ENV_POSTGRES_USER="$(read_env_var "POSTGRES_USER" "${ENV_FILE}")"
ENV_POSTGRES_DB="$(read_env_var "POSTGRES_DB" "${ENV_FILE}")"

POSTGRES_USER="${EXPLICIT_USER:-${POSTGRES_USER:-${ENV_POSTGRES_USER:-talentlens}}}"
POSTGRES_DB="${EXPLICIT_DB:-${POSTGRES_DB:-${ENV_POSTGRES_DB:-talentlens}}}"

validate_pg_identifier "${POSTGRES_USER}" "PostgreSQL user"
validate_pg_identifier "${POSTGRES_DB}" "PostgreSQL database"

TIMESTAMP="$(date -u '+%Y%m%d_%H%M%SZ')"
if [ "${BACKUP_FORMAT}" = "custom" ]; then
    BACKUP_FILE="${BACKUP_DIR}/talentlens_db_${TIMESTAMP}.dump"
else
    BACKUP_FILE="${BACKUP_DIR}/talentlens_db_${TIMESTAMP}.sql.gz"
fi
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

TMP_RAW_FILE=""
TMP_ARCHIVE_FILE=""
TMP_CHECKSUM_FILE=""
BACKUP_COMMITTED=false

cleanup_on_exit() {
    local exit_code=$?
    if [ -n "${TMP_RAW_FILE}" ] && [ -f "${TMP_RAW_FILE}" ]; then
        rm -f "${TMP_RAW_FILE}" || true
    fi
    if [ "${BACKUP_COMMITTED}" != "true" ]; then
        if [ -n "${TMP_ARCHIVE_FILE}" ] && [ -f "${TMP_ARCHIVE_FILE}" ]; then
            rm -f "${TMP_ARCHIVE_FILE}" || true
        fi
        if [ -n "${TMP_CHECKSUM_FILE}" ] && [ -f "${TMP_CHECKSUM_FILE}" ]; then
            rm -f "${TMP_CHECKSUM_FILE}" || true
        fi
    fi
    return "${exit_code}"
}

on_err() {
    local line="$1"
    log_error "Backup aborted at line ${line}. Existing backups and retention state preserved."
}

trap cleanup_on_exit EXIT
trap 'on_err $LINENO' ERR

echo -e "${BOLD}================================================================================${RESET}"
echo -e "${BOLD}TALENTLENS AI — DATABASE BACKUP CONTROLLER${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
log_info "Backup format:    ${BACKUP_FORMAT}"
log_info "Target database:  ${POSTGRES_DB} (role: ${POSTGRES_USER})"
log_info "Backup directory: ${BACKUP_DIR}"
log_info "Retention policy: ${RETENTION_DAYS} days"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# 1. Resolve target PostgreSQL container deterministically
DOCKER_EXEC_PREFIX=()
TARGET_DESC=""

if [ -n "${TARGET_CONTAINER}" ]; then
    DOCKER_EXEC_PREFIX=("${DOCKER_BIN}" exec -i "${TARGET_CONTAINER}")
    TARGET_DESC="container:${TARGET_CONTAINER}"
elif [ -f "${COMPOSE_FILE}" ] && "${DOCKER_BIN}" compose -f "${COMPOSE_FILE}" ps -q postgres 2>/dev/null | grep -q .; then
    DOCKER_EXEC_PREFIX=("${DOCKER_BIN}" compose -f "${COMPOSE_FILE}" exec -T postgres)
    TARGET_DESC="compose:${COMPOSE_FILE}#postgres"
else
    mapfile -t MATCHING_CONTAINERS < <("${DOCKER_BIN}" ps --filter "name=postgres" --filter "name=db" --format "{{.Names}}" | awk 'NF' | sort -u)
    if [ "${#MATCHING_CONTAINERS[@]}" -eq 1 ]; then
        TARGET_CONTAINER="${MATCHING_CONTAINERS[0]}"
        DOCKER_EXEC_PREFIX=("${DOCKER_BIN}" exec -i "${TARGET_CONTAINER}")
        TARGET_DESC="container:${TARGET_CONTAINER}"
    elif [ "${#MATCHING_CONTAINERS[@]}" -gt 1 ]; then
        log_error "Multiple PostgreSQL containers detected (${MATCHING_CONTAINERS[*]}). Specify -c/--container or TARGET_CONTAINER explicitly."
        exit 1
    else
        log_error "No running PostgreSQL container found in ${COMPOSE_FILE} or Docker daemon."
        exit 1
    fi
fi

run_in_pg() {
    MSYS_NO_PATHCONV=1 "${DOCKER_EXEC_PREFIX[@]}" "$@"
}

log_info "Resolved target:  ${TARGET_DESC}"

# 2. Verify PostgreSQL connectivity and database existence before dumping
if ! run_in_pg psql -U "${POSTGRES_USER}" -d postgres --no-psqlrc -t -A -c "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -qx "1"; then
    log_error "Database '${POSTGRES_DB}' does not exist or is unreachable on ${TARGET_DESC}."
    exit 1
fi

TMP_RAW_FILE="${BACKUP_DIR}/.tmp_dump_${TIMESTAMP}_$$"
TMP_ARCHIVE_FILE="${BACKUP_FILE}.tmp.$$"
TMP_CHECKSUM_FILE="${CHECKSUM_FILE}.tmp.$$"

# 3. Execute pg_dump cleanly with explicit exit-code checks
log_info "Executing pg_dump for '${POSTGRES_DB}'..."
if [ "${BACKUP_FORMAT}" = "custom" ]; then
    run_in_pg pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=custom --no-owner --no-acl --clean --if-exists > "${TMP_ARCHIVE_FILE}"
    if [ ! -s "${TMP_ARCHIVE_FILE}" ]; then
        log_error "pg_dump produced an empty custom archive."
        exit 1
    fi
    if [ "$(od -An -tx1 -N5 "${TMP_ARCHIVE_FILE}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" != "5047444d50" ]; then
        log_error "Generated custom backup is missing PGDMP header."
        exit 1
    fi
    if ! run_in_pg pg_restore --list < "${TMP_ARCHIVE_FILE}" > /dev/null; then
        log_error "pg_restore --list failed to validate generated custom archive."
        exit 1
    fi
else
    run_in_pg pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=plain --no-owner --no-acl --clean --if-exists > "${TMP_RAW_FILE}"
    if [ ! -s "${TMP_RAW_FILE}" ]; then
        log_error "pg_dump produced an empty SQL dump."
        exit 1
    fi
    gzip -9 -c "${TMP_RAW_FILE}" > "${TMP_ARCHIVE_FILE}"
    rm -f "${TMP_RAW_FILE}"
    TMP_RAW_FILE=""

    log_info "Verifying compressed archive integrity..."
    gzip -t "${TMP_ARCHIVE_FILE}"
    UNCOMPRESSED_BYTES="$(gzip -dc "${TMP_ARCHIVE_FILE}" | wc -c | tr -d '[:space:]')"
    if [ "${UNCOMPRESSED_BYTES}" -le 0 ]; then
        log_error "Compressed backup decompresses to zero bytes."
        exit 1
    fi
fi

# 4. Generate and self-verify SHA-256 sidecar before atomic commit
log_info "Generating and verifying SHA-256 checksum..."
ARCHIVE_BASENAME="$(basename "${BACKUP_FILE}")"
GENERATED_HASH="$(compute_sha256 "${TMP_ARCHIVE_FILE}")"
if [[ ! "${GENERATED_HASH}" =~ ^[0-9a-f]{64}$ ]]; then
    log_error "Computed SHA-256 checksum had invalid format: ${GENERATED_HASH}"
    exit 1
fi

printf '%s  %s\n' "${GENERATED_HASH}" "${ARCHIVE_BASENAME}" > "${TMP_CHECKSUM_FILE}"

mv -f "${TMP_ARCHIVE_FILE}" "${BACKUP_FILE}"
mv -f "${TMP_CHECKSUM_FILE}" "${CHECKSUM_FILE}"
BACKUP_COMMITTED=true
TMP_ARCHIVE_FILE=""
TMP_CHECKSUM_FILE=""

chmod 600 "${BACKUP_FILE}" "${CHECKSUM_FILE}"

# Re-read committed files from disk to verify checksum
RECORDED_HASH="$(awk '{print tolower($1)}' "${CHECKSUM_FILE}" | tr -d '\r')"
VERIFIED_HASH="$(compute_sha256 "${BACKUP_FILE}")"
if [ -z "${RECORDED_HASH}" ] || [ "${RECORDED_HASH}" != "${VERIFIED_HASH}" ]; then
    log_error "Post-write SHA-256 self-verification failed for ${BACKUP_FILE}."
    exit 1
fi
log_success "Backup created and verified: ${BACKUP_FILE}"
log_success "SHA-256 verified: ${VERIFIED_HASH}"

# 5. Apply retention rotation ONLY after new backup and checksum are verified
log_info "Applying retention policy (${RETENTION_DAYS} days)..."
mapfile -t ALL_BACKUPS < <(
    find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name "talentlens_db_*.sql.gz" -o -name "talentlens_db_*.dump" \) | sort -r
)

# Determine newest valid archive overall by modification timestamp (never delete the newest valid backup)
NEWEST_ARCHIVE=""
NEWEST_MTIME=0
for candidate in "${ALL_BACKUPS[@]}"; do
    [ -f "${candidate}" ] || continue
    mtime="$(get_mtime_epoch "${candidate}")"
    if [ "${mtime}" -gt "${NEWEST_MTIME}" ]; then
        NEWEST_MTIME="${mtime}"
        NEWEST_ARCHIVE="${candidate}"
    fi
done

NOW_EPOCH="$(date -u +%s)"
RETENTION_SECONDS=$(( RETENTION_DAYS * 86400 ))
DELETED_COUNT=0

for candidate in "${ALL_BACKUPS[@]}"; do
    [ -f "${candidate}" ] || continue
    if [ "${candidate}" = "${BACKUP_FILE}" ] || [ "${candidate}" = "${NEWEST_ARCHIVE}" ]; then
        continue
    fi
    mtime="$(get_mtime_epoch "${candidate}")"
    age=$(( NOW_EPOCH - mtime ))
    if [ "${age}" -gt "${RETENTION_SECONDS}" ]; then
        log_info "Removing expired backup: ${candidate}"
        rm -f "${candidate}"
        if [ -f "${candidate}.sha256" ]; then
            rm -f "${candidate}.sha256"
        fi
        DELETED_COUNT=$(( DELETED_COUNT + 1 ))
    fi
done

log_info "Retention complete: removed ${DELETED_COUNT} expired archive(s)."

BACKUP_SIZE="$(wc -c < "${BACKUP_FILE}" | tr -d '[:space:]')"
echo -e "\n${BOLD}================================================================================${RESET}"
echo -e "${GREEN}${BOLD}BACKUP COMPLETED SUCCESSFULLY${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
echo -e "  * Database: ${POSTGRES_DB}"
echo -e "  * Archive:  ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"
echo -e "  * Checksum: ${CHECKSUM_FILE}"
echo -e "  * Policy:   Retention ${RETENTION_DAYS} days (${DELETED_COUNT} expired removed)"
echo -e "================================================================================\n"
