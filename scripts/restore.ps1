# TalentLens AI — PowerShell Database Restore Controller (Windows PowerShell 5.1 Compatible)
[CmdletBinding()]
param (
    [Parameter(Position = 0)]
    [string]$Archive = "",

    [Parameter(Position = 1)]
    [string]$TargetDb = "",

    [switch]$ConfirmReplaceExisting,
    [switch]$CreateTarget,
    [string]$User = "",
    [string]$TargetContainer = "",
    [string]$ComposeFile = "docker-compose.prod.yml",
    [string]$ProjectName = "",
    [string]$EnvFile = ".env",
    [string]$DockerBin = "docker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-EnvSetting {
    param (
        [string]$Key,
        [string]$FilePath
    )
    if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return ""
    }
    $lines = Get-Content -LiteralPath $FilePath
    foreach ($line in $lines) {
        if ($line -match ("^\s*" + [regex]::Escape($Key) + "=(.*)$")) {
            $val = $Matches[1].Trim()
            if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                if ($val.Length -ge 2) {
                    $val = $val.Substring(1, $val.Length - 2)
                }
            }
            return $val
        }
    }
    return ""
}

function Assert-PgIdentifier {
    param (
        [string]$Value,
        [string]$Label
    )
    if (-not ($Value -cmatch '^[A-Za-z_][A-Za-z0-9_-]*$')) {
        throw "Invalid $Label '$Value'. Must match ^[A-Za-z_][A-Za-z0-9_-]*$."
    }
}

function Join-ProcessArguments {
    param (
        [string[]]$Arguments
    )
    $escaped = New-Object System.Collections.Generic.List[string]
    foreach ($arg in $Arguments) {
        if ($null -eq $arg -or $arg.Length -eq 0) {
            $escaped.Add('""')
            continue
        }
        if ($arg -notmatch '[\s"]') {
            $escaped.Add($arg)
            continue
        }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $backslashes = 0
        for ($i = 0; $i -lt $arg.Length; $i++) {
            $ch = $arg[$i]
            if ($ch -eq '\') {
                $backslashes++
            } elseif ($ch -eq '"') {
                if ($backslashes -gt 0) {
                    [void]$sb.Append('\', $backslashes * 2)
                    $backslashes = 0
                }
                [void]$sb.Append('\"')
            } else {
                if ($backslashes -gt 0) {
                    [void]$sb.Append('\', $backslashes)
                    $backslashes = 0
                }
                [void]$sb.Append($ch)
            }
        }
        if ($backslashes -gt 0) {
            [void]$sb.Append('\', $backslashes * 2)
        }
        [void]$sb.Append('"')
        $escaped.Add($sb.ToString())
    }
    return ($escaped -join ' ')
}

function Invoke-NativeTool {
    param (
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$StdinFilePath = ""
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (Join-ProcessArguments -Arguments $Arguments)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = [bool]($StdinFilePath.Length -gt 0)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::Start($psi)
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if ($StdinFilePath.Length -gt 0) {
            $inFs = [System.IO.File]::OpenRead($StdinFilePath)
            try {
                $inFs.CopyTo($process.StandardInput.BaseStream)
            } finally {
                $inFs.Dispose()
                $process.StandardInput.BaseStream.Close()
            }
        }

        $process.WaitForExit()
        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()

        $exitCode = $process.ExitCode
        if ($exitCode -ne 0) {
            $errDetail = $stderrText.Trim()
            if ($errDetail) {
                throw "Command '$FilePath' failed with exit code $($exitCode): $errDetail"
            }
            throw "Command '$FilePath' failed with exit code $exitCode."
        }

        return $stdoutText
    } finally {
        $process.Dispose()
    }
}

function Read-FilePrefixBytes {
    param (
        [string]$Path,
        [int]$Count
    )
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $buf = New-Object byte[] $Count
        $read = $fs.Read($buf, 0, $Count)
        if ($read -le 0) {
            return ,(New-Object byte[] 0)
        }
        if ($read -lt $Count) {
            $trimmed = New-Object byte[] $read
            [Array]::Copy($buf, $trimmed, $read)
            return ,$trimmed
        }
        return ,$buf
    } finally {
        $fs.Dispose()
    }
}

$tempSql = ""
$createdByScript = $false
$restoreCompleted = $false
$execBinary = $DockerBin
$dockerPrefix = $null
$PostgresUser = "talentlens"

try {
    if (-not $Archive.Trim()) {
        throw "Backup archive argument cannot be empty."
    }
    if (-not $TargetDb.Trim()) {
        throw "TargetDb argument is mandatory."
    }

    $envUser = Resolve-EnvSetting -Key "POSTGRES_USER" -FilePath $EnvFile
    $envProject = Resolve-EnvSetting -Key "COMPOSE_PROJECT_NAME" -FilePath $EnvFile
    $PostgresUser = if ($User.Trim()) { $User.Trim() } elseif ($env:POSTGRES_USER) { $env:POSTGRES_USER.Trim() } elseif ($envUser) { $envUser } else { "talentlens" }
    $ResolvedProjectName = if ($ProjectName.Trim()) { $ProjectName.Trim() } elseif ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME.Trim() } elseif ($envProject) { $envProject } else { "" }

    Assert-PgIdentifier -Value $PostgresUser -Label "PostgreSQL user"
    Assert-PgIdentifier -Value $TargetDb.Trim() -Label "target database"
    if ($ResolvedProjectName.Length -gt 0 -and -not ($ResolvedProjectName -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$')) {
        throw "Invalid ProjectName '$ResolvedProjectName'. Must match ^[A-Za-z0-9][A-Za-z0-9_-]*$."
    }
    $TargetDb = $TargetDb.Trim()

    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "TALENTLENS AI - DATABASE RESTORE CONTROLLER (POWERSHELL)" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
        throw "Backup archive not found: $Archive"
    }
    $resolvedArchive = (Resolve-Path -LiteralPath $Archive).Path
    if ((Get-Item -LiteralPath $resolvedArchive).Length -eq 0) {
        throw "Backup archive is empty: $resolvedArchive"
    }

    # 1. Mandatory SHA-256 Sidecar Verification
    $ChecksumFile = "$resolvedArchive.sha256"
    if (-not (Test-Path -LiteralPath $ChecksumFile -PathType Leaf)) {
        throw "Mandatory SHA-256 checksum sidecar not found: $ChecksumFile"
    }

    $checksumLines = @([System.IO.File]::ReadAllLines($ChecksumFile) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    if ($checksumLines.Count -ne 1) {
        throw "Malformed checksum sidecar '$ChecksumFile': expected exactly 1 checksum line."
    }
    if (-not ($checksumLines[0] -match '^([0-9a-fA-F]{64})(\s+(.+))?$')) {
        throw "Malformed SHA-256 checksum format in '$ChecksumFile'."
    }
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -ne $actualHash) {
        throw "SHA-256 checksum mismatch! Expected $expectedHash, got $actualHash"
    }
    Write-Host "SUCCESS: Mandatory SHA-256 checksum verified: $actualHash" -ForegroundColor Green

    # 2. Explicit Format Validation & Decompression Check
    $lowerPath = $resolvedArchive.ToLowerInvariant()
    $archiveFormat = ""
    $streamFile = ""

    if ($lowerPath.EndsWith(".sql.gz")) {
        $archiveFormat = "sql_gz"
        $tempSql = [System.IO.Path]::GetTempFileName()
        Write-Host "Validating and decompressing .sql.gz archive..." -ForegroundColor Blue
        $totalDecompressed = [int64]0
        $inStream = [System.IO.File]::OpenRead($resolvedArchive)
        try {
            $gzipStream = New-Object System.IO.Compression.GZipStream($inStream, [System.IO.Compression.CompressionMode]::Decompress)
            try {
                $outStream = [System.IO.File]::Create($tempSql)
                try {
                    $buf = New-Object byte[] 65536
                    while (($read = $gzipStream.Read($buf, 0, $buf.Length)) -gt 0) {
                        $outStream.Write($buf, 0, $read)
                        $totalDecompressed += $read
                    }
                } finally {
                    $outStream.Dispose()
                }
            } finally {
                $gzipStream.Dispose()
            }
        } finally {
            $inStream.Dispose()
        }
        if ($totalDecompressed -le 0) {
            throw "Compressed archive decompresses to zero bytes: $resolvedArchive"
        }
        if ((Get-Item -LiteralPath $tempSql).Length -ge 5) {
            $headBytes = Read-FilePrefixBytes -Path $tempSql -Count 5
            if ([System.Text.Encoding]::ASCII.GetString($headBytes) -ceq "PGDMP") {
                throw "Format mismatch: '$resolvedArchive' is a .sql.gz file containing a custom PGDMP dump."
            }
        }
        $streamFile = $tempSql
    } elseif ($lowerPath.EndsWith(".dump") -or $lowerPath.EndsWith(".pgdump") -or $lowerPath.EndsWith(".custom")) {
        $archiveFormat = "custom"
        if ((Get-Item -LiteralPath $resolvedArchive).Length -lt 5) {
            throw "Invalid custom PostgreSQL dump '$resolvedArchive': file too small."
        }
        $magicBytes = Read-FilePrefixBytes -Path $resolvedArchive -Count 5
        if ([System.Text.Encoding]::ASCII.GetString($magicBytes) -cne "PGDMP") {
            throw "Invalid custom PostgreSQL dump '$resolvedArchive': missing PGDMP header."
        }
        $streamFile = $resolvedArchive
    } elseif ($lowerPath.EndsWith(".sql")) {
        $archiveFormat = "sql"
        $magic2 = Read-FilePrefixBytes -Path $resolvedArchive -Count 2
        if ($magic2.Count -ge 2 -and $magic2[0] -eq 0x1F -and $magic2[1] -eq 0x8B) {
            throw "Format mismatch: '$resolvedArchive' is gzip-compressed but uses .sql extension."
        }
        if ((Get-Item -LiteralPath $resolvedArchive).Length -ge 5) {
            $magic5 = Read-FilePrefixBytes -Path $resolvedArchive -Count 5
            if ([System.Text.Encoding]::ASCII.GetString($magic5) -ceq "PGDMP") {
                throw "Format mismatch: '$resolvedArchive' is a custom PGDMP archive but uses .sql extension."
            }
        }
        $streamFile = $resolvedArchive
    } else {
        throw "Unsupported backup archive extension/format: $resolvedArchive. Supported: .sql.gz, .dump, .sql"
    }
    Write-Host "SUCCESS: Archive format validated: $archiveFormat" -ForegroundColor Green

    # 3. Deterministic Container Resolution
    $targetDesc = ""
    if ($TargetContainer.Trim().Length -gt 0) {
        $resolvedContainer = $TargetContainer.Trim()
        $execBinary = $DockerBin
        $dockerPrefix = @("exec", "-i", $resolvedContainer)
        $targetDesc = "container:$resolvedContainer"
    } elseif (Test-Path -LiteralPath $ComposeFile -PathType Leaf) {
        $composeBinary = ""
        $composeBaseArgs = New-Object System.Collections.Generic.List[string]
        $hasDockerComposeSub = $false
        try {
            [void](Invoke-NativeTool -FilePath $DockerBin -Arguments @("compose", "version"))
            $hasDockerComposeSub = $true
        } catch {
            $hasDockerComposeSub = $false
        }

        if ($hasDockerComposeSub) {
            $composeBinary = $DockerBin
            $composeBaseArgs.Add("compose")
        } elseif ($null -ne (Get-Command "docker-compose" -ErrorAction SilentlyContinue)) {
            $composeBinary = "docker-compose"
        }

        if ($composeBinary.Length -gt 0) {
            if ($ResolvedProjectName.Length -gt 0) {
                $composeBaseArgs.Add("-p")
                $composeBaseArgs.Add($ResolvedProjectName)
            }
            if ($EnvFile.Trim().Length -gt 0 -and (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
                $composeBaseArgs.Add("--env-file")
                $composeBaseArgs.Add($EnvFile)
            }
            $composeBaseArgs.Add("-f")
            $composeBaseArgs.Add($ComposeFile)

            foreach ($svc in @("postgres", "db")) {
                $composeIdsRaw = ""
                try {
                    $composeIdsRaw = Invoke-NativeTool -FilePath $composeBinary -Arguments ($composeBaseArgs.ToArray() + @("ps", "-q", $svc))
                } catch {
                    $composeIdsRaw = ""
                }
                if ($composeIdsRaw.Trim().Length -gt 0) {
                    $execBinary = $composeBinary
                    $dockerPrefix = $composeBaseArgs.ToArray() + @("exec", "-T", $svc)
                    $targetDesc = "compose:$ComposeFile#$svc"
                    break
                }
            }
        }
    }

    if ($null -eq $dockerPrefix) {
        $psOut = Invoke-NativeTool -FilePath $DockerBin -Arguments @("ps", "--filter", "name=postgres", "--filter", "name=db", "--format", "{{.Names}}")
        $containers = @($psOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 } | Sort-Object -Unique)
        if ($containers.Count -eq 1) {
            $resolvedContainer = $containers[0]
            $execBinary = $DockerBin
            $dockerPrefix = @("exec", "-i", $resolvedContainer)
            $targetDesc = "container:$resolvedContainer"
        } elseif ($containers.Count -gt 1) {
            throw "Multiple PostgreSQL containers detected ($($containers -join ', ')). Specify -TargetContainer explicitly."
        } else {
            throw "No running PostgreSQL container found via '$ComposeFile' or '$DockerBin ps'."
        }
    }

    Write-Host "Resolved Target:  $targetDesc" -ForegroundColor Cyan
    Write-Host "Target Database:  $TargetDb (role: $PostgresUser)" -ForegroundColor Cyan
    Write-Host "Source Archive:   $resolvedArchive" -ForegroundColor Cyan

    if ($archiveFormat -eq "custom") {
        Write-Host "Validating custom archive table of contents via pg_restore --list..." -ForegroundColor Blue
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @("pg_restore", "--list")) -StdinFilePath $resolvedArchive)
    }

    # 4. Target Database Safety Checks
    [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", "postgres", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;"
    )))

    $dbExistsRaw = Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", "postgres", "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
        "-t", "-A", "-c", "SELECT 1 FROM pg_database WHERE datname = '$TargetDb'"
    ))
    $dbExists = ($dbExistsRaw.Trim() -eq "1")

    if ($dbExists) {
        if (-not $ConfirmReplaceExisting) {
            throw "Target database '$TargetDb' already exists on $targetDesc. Refusing destructive restore without explicit -ConfirmReplaceExisting."
        }
        Write-Warning "Confirmed destructive replacement inside existing database '$TargetDb'."
    } else {
        if (-not $CreateTarget) {
            throw "Target database '$TargetDb' does not exist on $targetDesc. Verify the target name or pass -CreateTarget for a fresh staging database."
        }
        Write-Host "Creating fresh staging database '$TargetDb'..." -ForegroundColor Blue
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @("createdb", "-U", $PostgresUser, $TargetDb)))
        $createdByScript = $true
    }

    # 5. Transactional Fail-Closed Restore
    Write-Host "Restoring schema and data transactionally into '$TargetDb'..." -ForegroundColor Blue
    if ($archiveFormat -eq "custom") {
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
            "pg_restore", "-U", $PostgresUser, "-d", $TargetDb,
            "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "--clean", "--if-exists"
        )) -StdinFilePath $streamFile)
    } else {
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
            "psql", "-U", $PostgresUser, "-d", $TargetDb,
            "--no-psqlrc", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-q"
        )) -StdinFilePath $streamFile)
    }

    # 6. Strict Post-Restore Integrity Verification
    Write-Host "Running post-restore schema, migration, and data verification..." -ForegroundColor Blue
    [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", $TargetDb, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;"
    )))

    $schemaOk = (Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", $TargetDb, "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
        "-t", "-A", "-c", "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public'"
    ))).Trim()
    if ($schemaOk -ne "1") {
        throw "Verification failed: 'public' schema missing in '$TargetDb'."
    }

    $migOk = (Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", $TargetDb, "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
        "-t", "-A", "-c", "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NOT NULL THEN (SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) ELSE 0 END"
    ))).Trim()
    if ($migOk -ne "1") {
        throw "Verification failed: '_prisma_migrations' is missing or has no completed migrations in '$TargetDb'."
    }

    $requiredTables = @(
        "organizations",
        "users",
        "clients",
        "requisitions",
        "scorecard_versions",
        "candidates",
        "candidate_consents",
        "email_outbox",
        "resume_documents",
        "candidate_assessments"
    )
    foreach ($tbl in $requiredTables) {
        $tblOk = (Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
            "psql", "-U", $PostgresUser, "-d", $TargetDb, "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
            "-t", "-A", "-c", "SELECT CASE WHEN to_regclass('public.$tbl') IS NOT NULL THEN 1 ELSE 0 END"
        ))).Trim()
        if ($tblOk -ne "1") {
            throw "Verification failed: required table 'public.$tbl' missing in '$TargetDb'."
        }
    }

    $verifyQuery = "SELECT 'migrations_applied: ' || count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL UNION ALL SELECT 'organizations: ' || count(*) FROM public.organizations UNION ALL SELECT 'users: ' || count(*) FROM public.users UNION ALL SELECT 'clients: ' || count(*) FROM public.clients UNION ALL SELECT 'requisitions: ' || count(*) FROM public.requisitions UNION ALL SELECT 'scorecard_versions: ' || count(*) FROM public.scorecard_versions UNION ALL SELECT 'candidates: ' || count(*) FROM public.candidates UNION ALL SELECT 'candidate_consents: ' || count(*) FROM public.candidate_consents UNION ALL SELECT 'email_outbox: ' || count(*) FROM public.email_outbox UNION ALL SELECT 'resume_documents: ' || count(*) FROM public.resume_documents UNION ALL SELECT 'candidate_assessments: ' || count(*) FROM public.candidate_assessments;"
    $counts = Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", $TargetDb, "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
        "-t", "-A", "-c", $verifyQuery
    ))
    if (-not $counts.Trim()) {
        throw "Post-restore verification query returned empty output."
    }

    $restoreCompleted = $true

    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "RESTORE VERIFICATION SUCCESSFUL" -ForegroundColor Green
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "Target Database: $TargetDb ($targetDesc)"
    $counts -split "`r?`n" | ForEach-Object {
        if ($_.Trim()) {
            Write-Host "  * $($_.Trim())"
        }
    }
    Write-Host "================================================================================" -ForegroundColor Green
} catch {
    Write-Host "RESTORE FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if (-not $restoreCompleted -and $createdByScript -and $null -ne $dockerPrefix) {
        try {
            Write-Warning "Cleaning up failed staging database '$TargetDb' created by this run..."
            [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
                "psql", "-U", $PostgresUser, "-d", "postgres", "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
                "-c", "DROP DATABASE IF EXISTS `"$TargetDb`";"
            )))
        } catch {
            Write-Warning "Failed to clean up staging database '$TargetDb': $($_.Exception.Message)"
        }
    }
    exit 1
} finally {
    if ($tempSql -and (Test-Path -LiteralPath $tempSql -PathType Leaf)) {
        Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue
    }
}
