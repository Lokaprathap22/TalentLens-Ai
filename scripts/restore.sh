#!/usr/bin/env bash
# ==============================================================================
# TalentLens AI — Production Database Restore & Disaster Recovery Automation
# Fail-closed PostgreSQL restore supporting .sql.gz, .dump (custom), and .sql
# with mandatory SHA-256 verification, explicit target confirmation,
# single-transaction restoration, and strict post-restore verification.
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
Usage: ./scripts/restore.sh [options] <backup_archive> <target_database>

Options:
      --confirm-replace-existing  Explicit confirmation required to restore into an existing database
      --create-target             Create target database if it does not already exist (recommended for staging recovery)
  -c, --container <name>          Explicit PostgreSQL container name
  -f, --compose-file <file>       Compose file path (default: docker-compose.prod.yml)
  -p, --project-name <name>       Optional Compose project name (default: COMPOSE_PROJECT_NAME)
  -u, --user <name>               PostgreSQL role name (default: POSTGRES_USER or talentlens)
      --env-file <file>           Optional env file for safe variable lookup (default: .env)
  -h, --help                      Show this help text

Supported archive formats:
  *.sql.gz   Gzip-compressed plain SQL dump (requires <archive>.sha256 sidecar)
  *.dump     PostgreSQL custom-format pg_dump archive (requires <archive>.sha256 sidecar)
  *.sql      Plain SQL dump (requires <archive>.sha256 sidecar)
EOF
}

DOCKER_BIN="${DOCKER_BIN:-docker}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
ENV_FILE="${ENV_FILE:-.env}"
TARGET_CONTAINER="${TARGET_CONTAINER:-}"
EXPLICIT_USER=""
EXPLICIT_PROJECT_NAME=""
CONFIRM_REPLACE_EXISTING=false
CREATE_TARGET=false
POSITIONAL=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --confirm-replace-existing)
            CONFIRM_REPLACE_EXISTING=true
            shift
            ;;
        --create-target)
            CREATE_TARGET=true
            shift
            ;;
        -c|--container)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            TARGET_CONTAINER="$2"
            shift 2
            ;;
        -f|--compose-file)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            COMPOSE_FILE="$2"
            shift 2
            ;;
        -p|--project-name)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            EXPLICIT_PROJECT_NAME="$2"
            shift 2
            ;;
        -u|--user)
            [ "$#" -ge 2 ] || { log_error "Missing value for $1"; exit 1; }
            EXPLICIT_USER="$2"
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
        --)
            shift
            while [ "$#" -gt 0 ]; do
                POSITIONAL+=("$1")
                shift
            done
            ;;
        -*)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

ARCHIVE="${POSITIONAL[0]:-}"
TARGET_DB="${POSITIONAL[1]:-}"

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
        log_error "No SHA-256 verification tool available (sha256sum, shasum, or openssl required)."
        exit 1
    fi
}

ENV_POSTGRES_USER="$(read_env_var "POSTGRES_USER" "${ENV_FILE}")"
ENV_COMPOSE_PROJECT_NAME="$(read_env_var "COMPOSE_PROJECT_NAME" "${ENV_FILE}")"
POSTGRES_USER="${EXPLICIT_USER:-${POSTGRES_USER:-${ENV_POSTGRES_USER:-talentlens}}}"
COMPOSE_PROJECT_NAME="${EXPLICIT_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-${ENV_COMPOSE_PROJECT_NAME:-}}}"
if [ -n "${COMPOSE_PROJECT_NAME}" ] && [[ ! "${COMPOSE_PROJECT_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    log_error "Invalid Compose project name: '${COMPOSE_PROJECT_NAME}'. Must match ^[A-Za-z0-9][A-Za-z0-9_-]*$."
    exit 1
fi

CREATED_BY_SCRIPT=false
RESTORE_COMPLETED=false
DOCKER_EXEC_PREFIX=()

run_in_pg() {
    MSYS_NO_PATHCONV=1 "${DOCKER_EXEC_PREFIX[@]}" "$@"
}

cleanup_on_exit() {
    local exit_code=$?
    if [ "${RESTORE_COMPLETED}" != "true" ] && [ "${CREATED_BY_SCRIPT}" = "true" ] && [ "${#DOCKER_EXEC_PREFIX[@]}" -gt 0 ]; then
        log_warn "Cleaning up failed staging database '${TARGET_DB}' created by this run..."
        run_in_pg psql -U "${POSTGRES_USER}" -d postgres --no-psqlrc -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";" >/dev/null 2>&1 || true
    fi
    return "${exit_code}"
}

on_err() {
    local line="$1"
    log_error "Restore failed at line ${line}. Aborting without success confirmation."
}

trap cleanup_on_exit EXIT
trap 'on_err $LINENO' ERR

echo -e "${BOLD}================================================================================${RESET}"
echo -e "${BOLD}TALENTLENS AI — DATABASE RESTORE CONTROLLER${RESET}"
echo -e "${BOLD}================================================================================${RESET}"

if [ -z "${ARCHIVE}" ]; then
    log_error "Missing backup archive argument."
    usage
    exit 1
fi

if [ -z "${TARGET_DB}" ]; then
    log_error "Missing explicit target database argument. Refusing to infer a default target."
    usage
    exit 1
fi

if [ "${#POSITIONAL[@]}" -gt 2 ]; then
    log_error "Unexpected extra arguments provided."
    usage
    exit 1
fi

validate_pg_identifier "${POSTGRES_USER}" "PostgreSQL user"
validate_pg_identifier "${TARGET_DB}" "target database"

if [ ! -f "${ARCHIVE}" ] || [ ! -s "${ARCHIVE}" ]; then
    log_error "Backup archive missing or empty: ${ARCHIVE}"
    exit 1
fi

# 1. Mandatory SHA-256 Checksum Sidecar Verification
CHECKSUM_FILE="${ARCHIVE}.sha256"
if [ ! -f "${CHECKSUM_FILE}" ] || [ ! -s "${CHECKSUM_FILE}" ]; then
    log_error "Mandatory checksum sidecar missing or empty: ${CHECKSUM_FILE}"
    exit 1
fi

mapfile -t CHECKSUM_LINES < <(tr -d '\r' < "${CHECKSUM_FILE}" | sed '/^[[:space:]]*$/d')
if [ "${#CHECKSUM_LINES[@]}" -ne 1 ]; then
    log_error "Malformed checksum sidecar '${CHECKSUM_FILE}': expected exactly 1 checksum entry."
    exit 1
fi

CHECKSUM_ENTRY="${CHECKSUM_LINES[0]}"
if [[ ! "${CHECKSUM_ENTRY}" =~ ^([0-9a-fA-F]{64})([[:space:]]+(.+))?$ ]]; then
    log_error "Malformed SHA-256 format in '${CHECKSUM_FILE}'. Expected 64 hex characters."
    exit 1
fi

EXPECTED_HASH="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
ACTUAL_HASH="$(compute_sha256 "${ARCHIVE}")"
if [ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]; then
    log_error "SHA-256 checksum MISMATCH for '${ARCHIVE}'!"
    log_error "  Expected: ${EXPECTED_HASH}"
    log_error "  Actual:   ${ACTUAL_HASH}"
    exit 1
fi
log_success "Mandatory SHA-256 checksum verified: ${ACTUAL_HASH}"

# 2. Explicit Format Detection & Structural Integrity Verification
ARCHIVE_LOWER="$(printf '%s' "${ARCHIVE}" | tr '[:upper:]' '[:lower:]')"
ARCHIVE_FORMAT=""

if [[ "${ARCHIVE_LOWER}" == *.sql.gz ]]; then
    ARCHIVE_FORMAT="sql_gz"
    if ! gzip -t "${ARCHIVE}"; then
        log_error "Compressed archive failed gzip integrity check: ${ARCHIVE}"
        exit 1
    fi
    DECOMP_BYTES="$(gzip -dc "${ARCHIVE}" | wc -c | tr -d '[:space:]')"
    if [ "${DECOMP_BYTES}" -le 0 ]; then
        log_error "Compressed archive decompresses to zero bytes: ${ARCHIVE}"
        exit 1
    fi
    DECOMP_MAGIC_HEX="$(gzip -dc "${ARCHIVE}" | (dd bs=5 count=1 2>/dev/null | od -An -tx1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'; cat >/dev/null))"
    if [ "${DECOMP_MAGIC_HEX}" = "5047444d50" ]; then
        log_error "Format mismatch: '${ARCHIVE}' uses .sql.gz extension but contains a PostgreSQL custom dump (PGDMP)."
        exit 1
    fi
elif [[ "${ARCHIVE_LOWER}" == *.dump ]] || [[ "${ARCHIVE_LOWER}" == *.pgdump ]] || [[ "${ARCHIVE_LOWER}" == *.custom ]]; then
    ARCHIVE_FORMAT="custom"
    ARCHIVE_MAGIC_HEX="$(od -An -tx1 -N5 "${ARCHIVE}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [ "${ARCHIVE_MAGIC_HEX}" != "5047444d50" ]; then
        log_error "Invalid custom PostgreSQL dump '${ARCHIVE}': missing PGDMP header."
        exit 1
    fi
elif [[ "${ARCHIVE_LOWER}" == *.sql ]]; then
    ARCHIVE_FORMAT="sql"
    MAGIC_HEX="$(od -An -tx1 -N2 "${ARCHIVE}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [ "${MAGIC_HEX}" = "1f8b" ]; then
        log_error "Format mismatch: '${ARCHIVE}' is gzip-compressed but named .sql."
        exit 1
    fi
    ARCHIVE_MAGIC_HEX="$(od -An -tx1 -N5 "${ARCHIVE}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [ "${ARCHIVE_MAGIC_HEX}" = "5047444d50" ]; then
        log_error "Format mismatch: '${ARCHIVE}' is a custom PGDMP archive but named .sql."
        exit 1
    fi
else
    log_error "Unsupported backup archive extension/format: ${ARCHIVE}. Supported: .sql.gz, .dump, .sql"
    exit 1
fi
log_success "Archive format validated: ${ARCHIVE_FORMAT}"

# 3. Deterministic Target Container Resolution (zero ambiguous guessing)
TARGET_DESC=""
if [ -n "${TARGET_CONTAINER}" ]; then
    DOCKER_EXEC_PREFIX=("${DOCKER_BIN}" exec -i "${TARGET_CONTAINER}")
    TARGET_DESC="container:${TARGET_CONTAINER}"
else
    if [ -f "${COMPOSE_FILE}" ]; then
        COMPOSE_BASE_CMD=()
        if "${DOCKER_BIN}" compose version >/dev/null 2>&1; then
            COMPOSE_BASE_CMD=("${DOCKER_BIN}" compose)
        elif command -v docker-compose >/dev/null 2>&1; then
            COMPOSE_BASE_CMD=("docker-compose")
        fi

        if [ "${#COMPOSE_BASE_CMD[@]}" -gt 0 ]; then
            if [ -n "${COMPOSE_PROJECT_NAME}" ]; then
                COMPOSE_BASE_CMD+=(-p "${COMPOSE_PROJECT_NAME}")
            fi
            if [ -n "${ENV_FILE}" ] && [ -f "${ENV_FILE}" ]; then
                COMPOSE_BASE_CMD+=(--env-file "${ENV_FILE}")
            fi
            COMPOSE_BASE_CMD+=(-f "${COMPOSE_FILE}")

            for svc in postgres db; do
                if "${COMPOSE_BASE_CMD[@]}" ps -q "${svc}" 2>/dev/null | grep -q .; then
                    DOCKER_EXEC_PREFIX=("${COMPOSE_BASE_CMD[@]}" exec -T "${svc}")
                    TARGET_DESC="compose:${COMPOSE_FILE}#${svc}"
                    break
                fi
            done
        fi
    fi

    if [ "${#DOCKER_EXEC_PREFIX[@]}" -eq 0 ]; then
        mapfile -t MATCHING_CONTAINERS < <("${DOCKER_BIN}" ps --filter "name=postgres" --filter "name=db" --format "{{.Names}}" | awk 'NF' | sort -u)
        if [ "${#MATCHING_CONTAINERS[@]}" -eq 1 ]; then
            TARGET_CONTAINER="${MATCHING_CONTAINERS[0]}"
            DOCKER_EXEC_PREFIX=("${DOCKER_BIN}" exec -i "${TARGET_CONTAINER}")
            TARGET_DESC="container:${TARGET_CONTAINER}"
        elif [ "${#MATCHING_CONTAINERS[@]}" -gt 1 ]; then
            log_error "Multiple PostgreSQL containers detected (${MATCHING_CONTAINERS[*]}). Specify -c/--container explicitly."
            exit 1
        else
            log_error "No running PostgreSQL container found in ${COMPOSE_FILE} or Docker daemon."
            exit 1
        fi
    fi
fi

log_info "Resolved target:   ${TARGET_DESC}"
log_info "Target database:   ${TARGET_DB} (role: ${POSTGRES_USER})"
log_info "Source archive:    ${ARCHIVE}"

if [ "${ARCHIVE_FORMAT}" = "custom" ]; then
    log_info "Verifying custom archive table of contents via pg_restore --list..."
    if ! run_in_pg pg_restore --list < "${ARCHIVE}" > /dev/null; then
        log_error "pg_restore --list failed; custom archive is corrupt or unreadable."
        exit 1
    fi
fi

# 4. Target Database Safety & Existence Validation
run_in_pg psql -U "${POSTGRES_USER}" -d postgres --no-psqlrc -v ON_ERROR_STOP=1 -c "SELECT 1;" > /dev/null

DB_EXISTS="$(run_in_pg psql -U "${POSTGRES_USER}" -d postgres --no-psqlrc -v ON_ERROR_STOP=1 -t -A -c "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'")"

if [ "${DB_EXISTS}" = "1" ]; then
    if [ "${CONFIRM_REPLACE_EXISTING}" != "true" ]; then
        log_error "Target database '${TARGET_DB}' already exists on ${TARGET_DESC}."
        log_error "Refusing destructive restore without explicit --confirm-replace-existing."
        log_error "Recommended: restore into a new staging database with --create-target first."
        exit 1
    fi
    log_warn "Confirmed destructive replacement inside existing database '${TARGET_DB}'."
else
    if [ "${CREATE_TARGET}" != "true" ]; then
        log_error "Target database '${TARGET_DB}' does not exist on ${TARGET_DESC}."
        log_error "Verify the database name or pass --create-target to create a fresh staging database."
        exit 1
    fi
    log_info "Creating fresh staging database '${TARGET_DB}'..."
    run_in_pg createdb -U "${POSTGRES_USER}" "${TARGET_DB}"
    CREATED_BY_SCRIPT=true
    log_success "Created staging database '${TARGET_DB}'."
fi

# 5. Fail-Closed Transactional Restore (NO silent non-transactional fallback)
log_info "Restoring schema and data transactionally into '${TARGET_DB}'..."
if [ "${ARCHIVE_FORMAT}" = "sql_gz" ]; then
    gzip -dc "${ARCHIVE}" | run_in_pg psql \
        -U "${POSTGRES_USER}" \
        -d "${TARGET_DB}" \
        --no-psqlrc \
        --single-transaction \
        -v ON_ERROR_STOP=1 \
        -q
elif [ "${ARCHIVE_FORMAT}" = "sql" ]; then
    run_in_pg psql \
        -U "${POSTGRES_USER}" \
        -d "${TARGET_DB}" \
        --no-psqlrc \
        --single-transaction \
        -v ON_ERROR_STOP=1 \
        -q < "${ARCHIVE}"
elif [ "${ARCHIVE_FORMAT}" = "custom" ]; then
    run_in_pg pg_restore \
        -U "${POSTGRES_USER}" \
        -d "${TARGET_DB}" \
        --single-transaction \
        --exit-on-error \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists < "${ARCHIVE}"
fi
log_success "Database restore transaction committed cleanly."

# 6. Mandatory Post-Restore Integrity Verification (never suppress SQL errors)
log_info "Running strict post-restore schema, migration, and data verification..."

run_in_pg psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" --no-psqlrc -v ON_ERROR_STOP=1 -c "SELECT 1;" > /dev/null

PUBLIC_SCHEMA_OK="$(run_in_pg psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" --no-psqlrc -v ON_ERROR_STOP=1 -t -A -c "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public'")"
if [ "${PUBLIC_SCHEMA_OK}" != "1" ]; then
    log_error "Verification failed: 'public' schema missing in '${TARGET_DB}'."
    exit 1
fi

MIGRATIONS_OK="$(run_in_pg psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" --no-psqlrc -v ON_ERROR_STOP=1 -t -A -c "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NOT NULL THEN (SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) ELSE 0 END")"
if [ "${MIGRATIONS_OK}" != "1" ]; then
    log_error "Verification failed: '_prisma_migrations' is missing or contains no completed migrations in '${TARGET_DB}'."
    exit 1
fi

REQUIRED_TABLES=(
    organizations
    users
    clients
    requisitions
    scorecard_versions
    candidates
    candidate_consents
    email_outbox
    resume_documents
    candidate_assessments
)

for tbl in "${REQUIRED_TABLES[@]}"; do
    TBL_OK="$(run_in_pg psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" --no-psqlrc -v ON_ERROR_STOP=1 -t -A -c "SELECT CASE WHEN to_regclass('public.${tbl}') IS NOT NULL THEN 1 ELSE 0 END")"
    if [ "${TBL_OK}" != "1" ]; then
        log_error "Verification failed: required table 'public.${tbl}' is missing in '${TARGET_DB}'."
        exit 1
    fi
done

ROW_COUNTS="$(run_in_pg psql -U "${POSTGRES_USER}" -d "${TARGET_DB}" --no-psqlrc -v ON_ERROR_STOP=1 -t -A -c "
SELECT 'migrations_applied: ' || count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'organizations: ' || count(*) FROM public.organizations
UNION ALL SELECT 'users: ' || count(*) FROM public.users
UNION ALL SELECT 'clients: ' || count(*) FROM public.clients
UNION ALL SELECT 'requisitions: ' || count(*) FROM public.requisitions
UNION ALL SELECT 'scorecard_versions: ' || count(*) FROM public.scorecard_versions
UNION ALL SELECT 'candidates: ' || count(*) FROM public.candidates
UNION ALL SELECT 'candidate_consents: ' || count(*) FROM public.candidate_consents
UNION ALL SELECT 'email_outbox: ' || count(*) FROM public.email_outbox
UNION ALL SELECT 'resume_documents: ' || count(*) FROM public.resume_documents
UNION ALL SELECT 'candidate_assessments: ' || count(*) FROM public.candidate_assessments;
")"

if [ -z "${ROW_COUNTS}" ]; then
    log_error "Post-restore verification query returned empty output."
    exit 1
fi

RESTORE_COMPLETED=true

echo -e "\n${BOLD}================================================================================${RESET}"
echo -e "${GREEN}${BOLD}RESTORE VERIFICATION SUCCESSFUL${RESET}"
echo -e "${BOLD}================================================================================${RESET}"
echo -e "Target Database: ${BOLD}${TARGET_DB}${RESET} (${TARGET_DESC})"
echo -e "Verified Schema & Row Counts:"
printf '%s\n' "${ROW_COUNTS}" | while IFS= read -r line; do
    [ -n "${line}" ] && echo -e "  * ${line}"
done
echo -e "================================================================================\n"
