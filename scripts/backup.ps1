# TalentLens AI — PowerShell Database Backup Controller (Windows PowerShell 5.1 Compatible)
[CmdletBinding()]
param (
    [string]$Database = "",
    [string]$User = "",
    [string]$BackupDir = "backups",
    [int]$RetentionDays = 7,
    [string]$ComposeFile = "docker-compose.prod.yml",
    [string]$ProjectName = "",
    [string]$TargetContainer = "",
    [ValidateSet("plain", "custom")]
    [string]$Format = "plain",
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
        [string]$StdinFilePath = "",
        [string]$StdoutFilePath = ""
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
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $stdoutTask = $null
        if ($StdoutFilePath.Length -eq 0) {
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        }

        if ($StdinFilePath.Length -gt 0) {
            $inFs = [System.IO.File]::OpenRead($StdinFilePath)
            try {
                $inFs.CopyTo($process.StandardInput.BaseStream)
            } finally {
                $inFs.Dispose()
                $process.StandardInput.BaseStream.Close()
            }
        }

        if ($StdoutFilePath.Length -gt 0) {
            $outFs = [System.IO.File]::Create($StdoutFilePath)
            try {
                $process.StandardOutput.BaseStream.CopyTo($outFs)
            } finally {
                $outFs.Dispose()
            }
        }

        $process.WaitForExit()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        $stdoutText = if ($null -ne $stdoutTask) { $stdoutTask.GetAwaiter().GetResult() } else { "" }

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

function Set-RestrictiveWindowsAcl {
    param ([string]$Path)
    try {
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
        if (Test-Path -LiteralPath $icacls) {
            [void](Invoke-NativeTool -FilePath $icacls -Arguments @(
                $Path,
                "/inheritance:r",
                "/grant:r", "*${currentSid}:F",
                "/grant:r", "*S-1-5-18:F",
                "/grant:r", "*S-1-5-32-544:F"
            ))
        }
    } catch {
        Write-Warning "Unable to tighten ACL on '$Path': $($_.Exception.Message)"
    }
}

$tmpRawFile = ""
$tmpArchiveFile = ""
$tmpChecksumFile = ""
$backupCommitted = $false

try {
    if ($RetentionDays -lt 1) {
        throw "Invalid RetentionDays '$RetentionDays'. Must be a positive integer (>= 1)."
    }

    $envUser = Resolve-EnvSetting -Key "POSTGRES_USER" -FilePath $EnvFile
    $envDb = Resolve-EnvSetting -Key "POSTGRES_DB" -FilePath $EnvFile
    $envProject = Resolve-EnvSetting -Key "COMPOSE_PROJECT_NAME" -FilePath $EnvFile

    $PostgresUser = if ($User.Trim()) { $User.Trim() } elseif ($env:POSTGRES_USER) { $env:POSTGRES_USER.Trim() } elseif ($envUser) { $envUser } else { "talentlens" }
    $PostgresDb = if ($Database.Trim()) { $Database.Trim() } elseif ($env:POSTGRES_DB) { $env:POSTGRES_DB.Trim() } elseif ($envDb) { $envDb } else { "talentlens" }
    $ResolvedProjectName = if ($ProjectName.Trim()) { $ProjectName.Trim() } elseif ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME.Trim() } elseif ($envProject) { $envProject } else { "" }

    Assert-PgIdentifier -Value $PostgresUser -Label "PostgreSQL user"
    Assert-PgIdentifier -Value $PostgresDb -Label "PostgreSQL database"
    if ($ResolvedProjectName.Length -gt 0 -and -not ($ResolvedProjectName -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$')) {
        throw "Invalid ProjectName '$ResolvedProjectName'. Must match ^[A-Za-z0-9][A-Za-z0-9_-]*$."
    }

    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "TALENTLENS AI - DATABASE BACKUP CONTROLLER (POWERSHELL)" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "Backup Format:    $Format" -ForegroundColor Cyan
    Write-Host "Target Database:  $PostgresDb (role: $PostgresUser)" -ForegroundColor Cyan
    Write-Host "Backup Directory: $BackupDir" -ForegroundColor Cyan
    Write-Host "Retention Policy: $RetentionDays days" -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $BackupDir)) {
        [void](New-Item -ItemType Directory -Path $BackupDir -Force)
    }
    $resolvedBackupDir = (Resolve-Path -LiteralPath $BackupDir).Path

    # Deterministic container resolution (no arbitrary multi-container selection)
    $execBinary = $DockerBin
    $dockerPrefix = $null
    $targetDesc = ""

    if ($TargetContainer.Trim().Length -gt 0) {
        $resolvedContainer = $TargetContainer.Trim()
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
            throw "Multiple PostgreSQL containers detected ($($containers -join ', ')). Specify -TargetContainer or matching -ComposeFile explicitly."
        } else {
            throw "No running PostgreSQL container found via '$ComposeFile' or '$DockerBin ps'."
        }
    }

    Write-Host "Resolved Target:  $targetDesc" -ForegroundColor Cyan

    # Verify PostgreSQL connectivity and target database existence before dumping
    $dbCheck = Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
        "psql", "-U", $PostgresUser, "-d", "postgres", "--no-psqlrc", "-v", "ON_ERROR_STOP=1",
        "-t", "-A", "-c", "SELECT 1 FROM pg_database WHERE datname = '$PostgresDb'"
    ))
    if ($dbCheck.Trim() -ne "1") {
        throw "Database '$PostgresDb' does not exist or is unreachable on $targetDesc."
    }

    $Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmssZ")
    $archiveName = if ($Format -eq "custom") { "talentlens_db_$Timestamp.dump" } else { "talentlens_db_$Timestamp.sql.gz" }
    $ArchiveFile = Join-Path $resolvedBackupDir $archiveName
    $ChecksumFile = "$ArchiveFile.sha256"

    $pidTag = $PID
    $tmpRawFile = Join-Path $resolvedBackupDir ".tmp_dump_${Timestamp}_${pidTag}.sql"
    $tmpArchiveFile = "$ArchiveFile.tmp.$pidTag"
    $tmpChecksumFile = "$ChecksumFile.tmp.$pidTag"

    Write-Host "Executing pg_dump for '$PostgresDb'..." -ForegroundColor Blue
    if ($Format -eq "custom") {
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
            "pg_dump", "-U", $PostgresUser, "-d", $PostgresDb,
            "--format=custom", "--no-owner", "--no-acl", "--clean", "--if-exists"
        )) -StdoutFilePath $tmpArchiveFile)

        if (-not (Test-Path -LiteralPath $tmpArchiveFile) -or (Get-Item -LiteralPath $tmpArchiveFile).Length -lt 5) {
            throw "pg_dump produced an empty or truncated custom archive."
        }
        $magicBytes = Read-FilePrefixBytes -Path $tmpArchiveFile -Count 5
        $magicText = [System.Text.Encoding]::ASCII.GetString($magicBytes)
        if ($magicText -cne "PGDMP") {
            throw "Generated custom backup is missing PGDMP header."
        }
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @("pg_restore", "--list")) -StdinFilePath $tmpArchiveFile)
    } else {
        [void](Invoke-NativeTool -FilePath $execBinary -Arguments ($dockerPrefix + @(
            "pg_dump", "-U", $PostgresUser, "-d", $PostgresDb,
            "--format=plain", "--no-owner", "--no-acl", "--clean", "--if-exists"
        )) -StdoutFilePath $tmpRawFile)

        if (-not (Test-Path -LiteralPath $tmpRawFile) -or (Get-Item -LiteralPath $tmpRawFile).Length -eq 0) {
            throw "pg_dump produced an empty SQL file."
        }

        Write-Host "Compressing dump archive..." -ForegroundColor Blue
        $inStream = [System.IO.File]::OpenRead($tmpRawFile)
        try {
            $outStream = [System.IO.File]::Create($tmpArchiveFile)
            try {
                $gzipStream = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionLevel]::Optimal)
                try {
                    $inStream.CopyTo($gzipStream)
                } finally {
                    $gzipStream.Dispose()
                }
            } finally {
                $outStream.Dispose()
            }
        } finally {
            $inStream.Dispose()
        }

        Remove-Item -LiteralPath $tmpRawFile -Force
        $tmpRawFile = ""

        # Verify gzip readability and non-zero decompressed payload
        Write-Host "Verifying compressed archive integrity..." -ForegroundColor Blue
        $totalDecompressed = [int64]0
        $verifyFs = [System.IO.File]::OpenRead($tmpArchiveFile)
        try {
            $verifyGzip = New-Object System.IO.Compression.GZipStream($verifyFs, [System.IO.Compression.CompressionMode]::Decompress)
            try {
                $buf = New-Object byte[] 65536
                while (($read = $verifyGzip.Read($buf, 0, $buf.Length)) -gt 0) {
                    $totalDecompressed += $read
                }
            } finally {
                $verifyGzip.Dispose()
            }
        } finally {
            $verifyFs.Dispose()
        }
        if ($totalDecompressed -le 0) {
            throw "Compressed archive decompresses to zero bytes."
        }
    }

    # Generate SHA-256 sidecar (UTF-8 no BOM for Bash/PowerShell compatibility)
    Write-Host "Generating and verifying SHA-256 checksum..." -ForegroundColor Blue
    $sha256Hash = (Get-FileHash -LiteralPath $tmpArchiveFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $leafName = Split-Path -Path $ArchiveFile -Leaf
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpChecksumFile, "$sha256Hash  $leafName`n", $utf8NoBom)

    Move-Item -LiteralPath $tmpArchiveFile -Destination $ArchiveFile -Force
    Move-Item -LiteralPath $tmpChecksumFile -Destination $ChecksumFile -Force
    $backupCommitted = $true
    $tmpArchiveFile = ""
    $tmpChecksumFile = ""

    Set-RestrictiveWindowsAcl -Path $ArchiveFile
    Set-RestrictiveWindowsAcl -Path $ChecksumFile

    # Re-read committed files from disk and verify checksum before declaring success or applying retention
    $recordedContent = ([System.IO.File]::ReadAllText($ChecksumFile)).Trim()
    if (-not ($recordedContent -match '^([0-9a-fA-F]{64})(\s+.+)?$')) {
        throw "Generated checksum file '$ChecksumFile' failed format verification."
    }
    $recordedHash = $Matches[1].ToLowerInvariant()
    $reverifiedHash = (Get-FileHash -LiteralPath $ArchiveFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($recordedHash -ne $reverifiedHash) {
        throw "Post-write SHA-256 self-verification failed for '$ArchiveFile'."
    }

    # Retention rotation: runs strictly AFTER verified backup creation
    Write-Host "Applying backup retention policy ($RetentionDays days)..." -ForegroundColor Blue
    $cutoffUtc = (Get-Date).ToUniversalTime().AddDays(-$RetentionDays)
    $matchingArchives = @(
        Get-ChildItem -LiteralPath $resolvedBackupDir -File |
            Where-Object { $_.Name -match '^talentlens_db_.*\.(sql\.gz|dump)$' } |
            Sort-Object -Property LastWriteTimeUtc -Descending
    )

    $newestArchiveFullPath = if ($matchingArchives.Count -gt 0) { $matchingArchives[0].FullName } else { "" }
    $deletedCount = 0

    foreach ($candidate in $matchingArchives) {
        if ($candidate.FullName -eq $ArchiveFile -or $candidate.FullName -eq $newestArchiveFullPath) {
            continue
        }
        if ($candidate.LastWriteTimeUtc -lt $cutoffUtc) {
            Write-Host "Removing expired backup: $($candidate.FullName)" -ForegroundColor Yellow
            Remove-Item -LiteralPath $candidate.FullName -Force
            $sidecarPath = "$($candidate.FullName).sha256"
            if (Test-Path -LiteralPath $sidecarPath -PathType Leaf) {
                Remove-Item -LiteralPath $sidecarPath -Force
            }
            $deletedCount++
        }
    }

    $sizeBytes = (Get-Item -LiteralPath $ArchiveFile).Length
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "BACKUP COMPLETED SUCCESSFULLY" -ForegroundColor Green
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "  * Database: $PostgresDb"
    Write-Host "  * Archive:  $ArchiveFile ($sizeBytes bytes)"
    Write-Host "  * Checksum: $ChecksumFile ($reverifiedHash)"
    Write-Host "  * Policy:   Retention $RetentionDays days ($deletedCount expired removed)"
    Write-Host "================================================================================" -ForegroundColor Green
} catch {
    Write-Host "BACKUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($tmpRawFile -and (Test-Path -LiteralPath $tmpRawFile -PathType Leaf)) {
        Remove-Item -LiteralPath $tmpRawFile -Force -ErrorAction SilentlyContinue
    }
    if (-not $backupCommitted) {
        if ($tmpArchiveFile -and (Test-Path -LiteralPath $tmpArchiveFile -PathType Leaf)) {
            Remove-Item -LiteralPath $tmpArchiveFile -Force -ErrorAction SilentlyContinue
        }
        if ($tmpChecksumFile -and (Test-Path -LiteralPath $tmpChecksumFile -PathType Leaf)) {
            Remove-Item -LiteralPath $tmpChecksumFile -Force -ErrorAction SilentlyContinue
        }
    }
}
