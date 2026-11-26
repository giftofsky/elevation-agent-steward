import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR, LOCK_DIR, WRAPPER_DIR, STALE_LOCK_MAX_AGE_MS, sanitizeName } from "../types.js";
import type { ScheduleGateSpec } from "./schedule-v2.js";
import type { TaskGuards } from "./guard.js";
import { inspectPromptSafety } from "./guard.js";
import { createGateSnapshot } from "./gate-integrity.js";

/**
 * Путь к единому generic-обёртке PowerShell, которая реализует запуск opencode run
 * с таймаутом и lock-логикой.
 */
const WRAPPER_FILENAME = "run-task.ps1";

/**
 * Текст PowerShell-обёртки.
 *
 * Параметры:
 *   TaskName       — имя задачи (для логов)
 *   PromptFile     — путь к файлу с промптом (читается через Get-Content -Raw)
 *   TimeoutSeconds — таймаут в секундах
 *   Model          — LLM-модель для `opencode run --model` (опционально)
 *   Workdir        — рабочая директория (опционально)
 *   WorkspaceName  — имя multi-repo workspace для git-контекста в логе
 *   LockFile       — путь к lock-файлу (удаляется в finally)
 *   BeforeScript   — pre-flight команда (ненулевой код отменяет задачу)
 *   AfterScript    — post-flight команда (выполняется даже при ошибке)
 *
 * Логика:
 *   1. Выполняет pre-flight (если задан); при ошибке задача не запускается.
 *   2. Читает промпт из файла.
 *   3. Запускает opencode run <промпт> через Start-Process (без окна консоли).
 *   4. Ждёт завершения с таймаутом.
 *   5. При таймауте — убивает процесс и дочерние процессы.
 *   6. В finally выполняет post-flight и удаляет lock-файл.
 */

/**
 * B6: разбор PID из lock-файла для PowerShell-обёртки.
 *
 * Формат общий с Node: `<pid>-<iso>`. Legacy-файлы тоже читаются:
 * `<iso>|<pid>` (прошлый PS) и голый `<pid>` (pid-файл bash-обёртки).
 * Обратные слэши в regex удвоены — так же, как в остальном WRAPPER_SCRIPT.
 */
export const PS_LOCK_PID_FUNCTION = `# B6: PID владельца lock-файла в любом формате (Node/PS/bash).
function Get-LockOwnerPid {
    param([string]$Content)
    $text = "$Content".Trim()
    if (-not $text) { return 0 }
    # Legacy PS: <iso>|<pid>. Проверяем ДО разбора по дефису, иначе год
    # из ISO (2026) был бы принят за PID.
    if ($text.Contains("|")) {
        $parts = $text.Split([char]124)
        $parsed = 0
        if ($parts.Count -ge 2 -and [int]::TryParse($parts[1].Trim(), [ref]$parsed) -and $parsed -gt 0) {
            return $parsed
        }
        return 0
    }
    # Голый ISO без PID (старый чужой lock) не должен давать год как PID:
    # для свежего файла это означало бы вытеснение активной блокировки.
    if ($text -match '^\\d{4}-\\d{2}-\\d{2}T') { return 0 }
    # Единый формат <pid>-<iso> и старый Node <pid>-<epoch>-<uuid>.
    if ($text -match '^(\\d+)-') { return [int]$matches[1] }
    # Голый PID (pid-файл bash-обёртки).
    if ($text -match '^\\d+$') {
        $parsed = 0
        if ([int]::TryParse($text, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
        return 0
    }
    return 0
}`;

export const WRAPPER_SCRIPT = `param(
    [string]$TaskName,
    [string]$PromptFile,
    [int]$TimeoutSeconds,
    [string]$Model,
    [string]$Workdir,
    [string]$WorkspaceName,
    [string]$AllowedTools,
    [string]$DeniedTools,
    [string]$LockFile,
    [string]$LogFile,
    [string]$RecorderFile,
    [string]$QualityGate,
    # G-1.2: snapshot входов гейта, снятый при создании обёртки.
    [string]$GateSnapshotFile = "",
    # PL-47: пути, которые задача вправе изменить (из -Files afterScript).
    [string]$GateAllowPaths = "",
    [string]$BeforeScript,
    [string]$AfterScript,
    [string]$EnvFile,
    [string]$SessionMode,
    [string]$SessionId,
    [string]$SessionFile,
    # B2: параметры оставлены только для совместимости со старыми .cmd.
    # Ретраи принадлежат recorder'у — обёртка делает ровно одну попытку.
    [int]$RetryCount = 0,
    [int]$RetryDelaySeconds = 0,
    [int]$GateTimeoutSeconds = 300,
    [int]$StaleLockMaxAgeMs = 86400000,
    [string]$PermissionsB64 = "",
    [string]$PolicyB64 = "",
    [string]$ModelB64 = "",
    [string]$WorkspaceNameB64 = "",
    [string]$AllowedToolsB64 = "",
    [string]$DeniedToolsB64 = "",
    # P-3.2: запечённые харнесс-дефолты (деградируют в opencode при пустом значении).
    [string]$HarnessCommandB64 = "",
    [string]$HarnessArgsB64 = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# PL-86/87: old .cmd files may not pass -Workdir. Fall back to the current
# directory so quota partial-diff never fails with a Path binding error.
if (-not $Workdir) { $Workdir = (Get-Location).Path }

# W-1 (0.0.6): .cmd создаёт одноразовый worktree и переходит в него, но
# PowerShell получает -Workdir исходного репозитория. Без этой подмены
# opencode run, snapshot, quota-diff и git status работали в основном дереве.
# Исходный репозиторий нужен для checkout-lock (общий на все worktree) и для
# сохранения quota-diff: worktree удаляется после прогона.
$script:checkoutRoot = if ($env:AGENT_STEWARD_WORKTREE_REPO) { $env:AGENT_STEWARD_WORKTREE_REPO } else { $Workdir }
if ($env:AGENT_STEWARD_WORKTREE) { $Workdir = $env:AGENT_STEWARD_WORKTREE }

$ErrorActionPreference = "Continue"

# QW-7: смещение в append-логе, с которого начинается текущий прогон.
# Выставляется сразу после маркера «=== Run started ===» и используется
# классификатором квоты, чтобы старые строки не портили новый запуск.
$script:quotaScanStart = 0

# P2-11: свободный текст (модель, имя workspace, списки инструментов) приходит
# в base64, чтобы символы подстановки PowerShell/cmd не разворачивались.
function ConvertFrom-B64Text {
    param([string]$Value)
    if (-not $Value) { return "" }
    try {
        return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
    } catch {
        return ""
    }
}

if ($ModelB64) { $Model = ConvertFrom-B64Text $ModelB64 }
if ($WorkspaceNameB64) { $WorkspaceName = ConvertFrom-B64Text $WorkspaceNameB64 }
if ($AllowedToolsB64) { $AllowedTools = ConvertFrom-B64Text $AllowedToolsB64 }
if ($DeniedToolsB64) { $DeniedTools = ConvertFrom-B64Text $DeniedToolsB64 }

# P-3.2: запечённый дефолт харнесса (env AGENT_* всё равно имеет приоритет).
$HarnessCommandPath = ""
$HarnessArgsBaked = ""
if ($HarnessCommandB64) { $HarnessCommandPath = ConvertFrom-B64Text $HarnessCommandB64 }
if ($HarnessArgsB64) { $HarnessArgsBaked = ConvertFrom-B64Text $HarnessArgsB64 }

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    if ($LogFile) {
        try {
            Add-Content -Path $LogFile -Value $line -Encoding utf8
        } catch {}
    }
    Write-Host $line
}

# IM-3 / D03: machine-readable метка этапа в обычной строке лога.
# Старые парсеры продолжают видеть обычный текст; новые — префикс [stage:*].
function Write-Stage {
    param([string]$Stage, [string]$Message)
    # D13/IM-12: сквозной runId во всех этапах, когда он уже известен.
    if ($script:runId) { Write-Log "[stage:$Stage][run:$script:runId] $Message" }
    else { Write-Log "[stage:$Stage] $Message" }
}

# BN-3: лог задачи дописывается между прогонами. Без границы размер растёт
# бесконечно, а get_task_logs/recorder читают весь файл. Перед новым запуском
# оставляем только хвост — маркер Run started нового прогона будет в начале.
function Invoke-TaskLogRotation {
    param([string]$Path, [int]$MaxBytes = 10485760, [int]$KeepBytes = 2097152)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    try {
        $info = New-Object System.IO.FileInfo($Path)
        if ($info.Length -le $MaxBytes) { return }
        $keep = [Math]::Min([int]$KeepBytes, [int]$info.Length)
        if ($keep -le 0) { return }
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            [void]$stream.Seek([long](-$keep), [System.IO.SeekOrigin]::End)
            $buffer = New-Object byte[] $keep
            $read = $stream.Read($buffer, 0, $keep)
        } finally {
            $stream.Dispose()
        }
        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $nl = $text.IndexOf([string][char]10)
        if ($nl -ge 0 -and $nl -lt ($text.Length - 1)) { $text = $text.Substring($nl + 1) }
        $rotated = "[agent-steward] === Log rotated (size limit) ===" + [string][char]13 + [string][char]10 + $text
        [System.IO.File]::WriteAllText($Path, $rotated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Log "[agent-steward] Log exceeded size limit; kept last $keep bytes"
    } catch {}
}


# Проверяет, что процесс с указанным PID ещё существует. Нужно для stale-lock:
# возраст файла сам по себе не говорит, что владелец мёртв (задача может идти долго).
function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

${PS_LOCK_PID_FUNCTION}

# Гарантируем существование папки для лога (на случай прямого вызова обёртки).
if ($LogFile) {
    try {
        $logDir = Split-Path -Parent $LogFile
        if ($logDir -and -not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
    } catch {}
}

# BN-3: ротация перед маркером Run started, чтобы новый прогон начинался с
# компактного файла, а потребитель лога видел корректную границу прогона.
if ($LogFile) { Invoke-TaskLogRotation -Path $LogFile -MaxBytes 10485760 -KeepBytes 2097152 }

Write-Log "[agent-steward] Запуск задачи '$TaskName'..."

$startTime = Get-Date
$script:exitCode = 0
$script:errorMessage = ""
$script:preFlightStatus = "skipped"
$script:postFlightStatus = "skipped"
$script:skipMainTask = $false
$script:lockAcquired = $false
$script:timedOut = $false
$script:attemptExitCode = 0
$startedAtIso = $startTime.ToUniversalTime().ToString("o")
$script:runId = ""
# PL-7.2: разделённые потоки последнего хука для структурированного журнала.
$script:lastHookStdout = ""
$script:lastHookStderr = ""
# PL-25: помощник целостности гейта и файл snapshot'а рабочего дерева.
$gateIntegrityFile = ""
if ($RecorderFile) {
    $gateIntegrityFile = Join-Path (Split-Path $RecorderFile -Parent) "gate-integrity.js"
}
$worktreeSnapshotFile = ""

# Hotfix 1.5.3.1: блокировка ДО записи в историю. Раньше lock существовал только
# в in-process пути (LockManager/withLock), а schtasks-запуск обёртки его не
# проверял: два одновременных запуска дублировали задачу и дрались за лог.
# Атомарное создание файла (CreateNew) даёт ту же гарантию, что и Node-лок.
if ($LockFile) {
    try {
        $lockDir = Split-Path -Parent $LockFile
        if ($lockDir -and -not (Test-Path -LiteralPath $lockDir)) {
            New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
        }
        $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            # B6: единый формат <pid>-<iso> — его читают Node и bash.
            # По PID отличаем живой долгий запуск от осиротевшего после kill -9.
            $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
            $lockStream.Write($lockBytes, 0, $lockBytes.Length)
        } finally {
            $lockStream.Dispose()
        }
        $script:lockAcquired = $true
    } catch [System.IO.IOException] {
        # Зависший lock снимаем только если владелец мёртв (или файл старше
        # StaleLockMaxAgeMs и PID в нём отсутствует — lock от старой версии).
        $stale = $false
        $holderPid = 0
        try {
            $holderRaw = "$(Get-Content -LiteralPath $LockFile -Raw -ErrorAction Stop)".Trim()
            # B6: понимаем и новый <pid>-<iso>, и legacy <iso>|<pid>,
            # и голый PID — иначе живой чужой lock вытеснялся по возрасту.
            $holderPid = Get-LockOwnerPid -Content $holderRaw
        } catch {}
        if ($holderPid -gt 0) {
            $stale = -not (Test-ProcessAlive -ProcessId $holderPid)
        } else {
            try {
                $ageMs = ((Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime).TotalMilliseconds
                if ($ageMs -gt $StaleLockMaxAgeMs) { $stale = $true }
            } catch {}
        }
        if ($stale) {
            # T-03: не удаляем lock напрямую. Remove-Item + CreateNew давал
            # гонку: второй воркер мог снести lock, который первый только что
            # создал, и запустить ту же задачу повторно. Атомарно уводим старый
            # файл в уникальное имя; если rename не удался — чужой lock не трогаем.
            $staleLockPath = "$LockFile.stale-$PID-$([DateTime]::UtcNow.Ticks)"
            $staleMoved = $false
            try {
                Move-Item -LiteralPath $LockFile -Destination $staleLockPath -Force -ErrorAction Stop
                $staleMoved = $true
            } catch {}
            if ($staleMoved) {
                try {
                    $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                    try {
                        $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
                        $lockStream.Write($lockBytes, 0, $lockBytes.Length)
                    } finally {
                        $lockStream.Dispose()
                    }
                    $script:lockAcquired = $true
                } catch {}
                try { Remove-Item -LiteralPath $staleLockPath -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
        if (-not $script:lockAcquired) {
            Write-Log "[agent-steward] Запуск задачи '$TaskName' пропущен: удерживается активная блокировка."
            exit 0
        }
    } catch {
        Write-Log "[agent-steward] Не удалось захватить блокировку задачи '$TaskName': $_"
        exit 0
    }
}

# PL-121: кросс-процессная блокировка НА ЧЕК-АУТ. Блокировка задачи выше
# уникальна для задачи, а in-process planRuntimeIsolation не защищает OS-запуски:
# параллельные задачи с одним -Workdir видят чужой diff, гейт падает с общим
# сообщением, а afterScript коммитит чужие правки. Ключ — первые 16 hex SHA256
# от $script:checkoutRoot (исходный репозиторий, не одноразовый worktree), поэтому
# все задачи одного чек-аута делят один и тот же lock.
$script:checkoutLockAcquired = $false
$script:checkoutLockFile = ""
$checkoutHash = ""
try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:checkoutRoot))
        $checkoutHash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").Substring(0, 16).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
} catch {
    $checkoutHash = ""
}
if (-not $checkoutHash) {
    # Не можем посчитать ключ — не запускаем задачу без защиты чек-аута.
    Write-Log "[agent-steward] PL-121: не удалось вычислить checkout-lock по Workdir — запуск пропущен."
    if ($script:lockAcquired -and $LockFile -and (Test-Path $LockFile)) {
        try { Remove-Item $LockFile -Force } catch {}
    }
    exit 0
}
$checkoutLocksDir = Split-Path -Parent $LockFile
$script:checkoutLockFile = Join-Path $checkoutLocksDir "checkout-$checkoutHash.lock"
try {
    if ($checkoutLocksDir -and -not (Test-Path -LiteralPath $checkoutLocksDir)) {
        New-Item -ItemType Directory -Force -Path $checkoutLocksDir | Out-Null
    }
    $checkoutStream = [System.IO.File]::Open($script:checkoutLockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $checkoutBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
        $checkoutStream.Write($checkoutBytes, 0, $checkoutBytes.Length)
    } finally {
        $checkoutStream.Dispose()
    }
    $script:checkoutLockAcquired = $true
} catch [System.IO.IOException] {
    $checkoutStale = $false
    $checkoutHolderPid = 0
    try {
        $checkoutHolderRaw = "$(Get-Content -LiteralPath $script:checkoutLockFile -Raw -ErrorAction Stop)".Trim()
        $checkoutHolderPid = Get-LockOwnerPid -Content $checkoutHolderRaw
    } catch {}
    if ($checkoutHolderPid -gt 0) {
        $checkoutStale = -not (Test-ProcessAlive -ProcessId $checkoutHolderPid)
    } else {
        try {
            $checkoutAgeMs = ((Get-Date) - (Get-Item -LiteralPath $script:checkoutLockFile).LastWriteTime).TotalMilliseconds
            if ($checkoutAgeMs -gt $StaleLockMaxAgeMs) { $checkoutStale = $true }
        } catch {}
    }
    if ($checkoutStale) {
        # Атомарно уводим мёртвый lock в уникальное имя: чужой живой lock не трогаем.
        $checkoutStalePath = "$($script:checkoutLockFile).stale-$PID-$([DateTime]::UtcNow.Ticks)"
        $checkoutMoved = $false
        try {
            Move-Item -LiteralPath $script:checkoutLockFile -Destination $checkoutStalePath -Force -ErrorAction Stop
            $checkoutMoved = $true
        } catch {}
        if ($checkoutMoved) {
            try {
                $checkoutStream = [System.IO.File]::Open($script:checkoutLockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $checkoutBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
                    $checkoutStream.Write($checkoutBytes, 0, $checkoutBytes.Length)
                } finally {
                    $checkoutStream.Dispose()
                }
                $script:checkoutLockAcquired = $true
            } catch {}
            try { Remove-Item -LiteralPath $checkoutStalePath -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    if (-not $script:checkoutLockAcquired) {
        $checkoutSkipReason = "PL-121: в чек-ауте $script:checkoutRoot уже идёт другая задача — запуск пропущен"
        Write-Log "[agent-steward] $checkoutSkipReason"
        # PL-146: пропуск должен остаться в истории, иначе файловый триггер
        # теряет событие бесследно (get_history пуст, повторный touch нужен).
        if ($RecorderFile) {
            try {
                $checkoutSkipB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($checkoutSkipReason))
                & node "$RecorderFile" --skip "$TaskName" "$checkoutSkipB64" "$LogFile" 2>$null | Out-Null
            } catch {}
        }
        $script:skipMainTask = $true
        $script:exitCode = 0
        # afterScript не запускаем: иначе коммитим чужой diff. Снимаем свой lock задачи.
        if ($script:lockAcquired -and $LockFile -and (Test-Path $LockFile)) {
            try { Remove-Item $LockFile -Force } catch {}
        }
        exit 0
    }
} catch {
    Write-Log "[agent-steward] PL-121: не удалось захватить checkout-блокировку: $_"
    if ($script:lockAcquired -and $LockFile -and (Test-Path $LockFile)) {
        try { Remove-Item $LockFile -Force } catch {}
    }
    exit 0
}

# Crash recovery: фиксируем начало ДО pre-flight и основной задачи.
# Если процесс убьют (таймаут/KILL/перезагрузка), останется finished_at = NULL,
# и при следующем старте плагина recovery пометит запись как error.
if ($RecorderFile) {
    try {
        $startOutput = & node "$RecorderFile" --start "$TaskName" "$startedAtIso" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $candidate = @($startOutput) | Select-Object -Last 1
            if ($candidate) { $script:runId = "$candidate".Trim() }
        }
    } catch {}
}

# QA-D316-4: маркеры PowerShell-тела те же, что в writeHookFile() на Node-стороне.
# Сюда попадает уже сгенерированный .cmd-шим (обратная совместимость), но если
# raw PS-тело пришло напрямую, временный .cmd не должен разбираться cmd.exe.
function Test-PowerShellHookBody {
    param([string]$Text)
    return ($Text -match '\\$[A-Za-z_]' -or $Text -match '&\\s')
}

# Выполняет команду оболочки и построчно пишет её вывод в лог.
# GateTimeoutSeconds ограничивает время хука: зависший pre-flight/Quality Gate
# раньше держал lock до истечения общего таймаута задачи (до 24 ч).
function Invoke-HookScript {
    # PL-107: список файлов задачи из afterScript приходит сюда и экспортируется
    # в хук, чтобы qualityGate мог линтить только свои файлы, а не весь src/.
    param([string]$Command, [string]$AllowPaths = "")
    # QA-PORT-1: TimeoutSeconds — жёсткий бюджет ВСЕЙ задачи, а не только
    # запуска агента. Раньше хуки жили по GateTimeoutSeconds (300 с по
    # умолчанию): задача с timeoutSeconds=8 висела в pre-flight 90 с,
    # статус оставался running, а durationMs в истории был 0.
    $taskRemaining = [int]$TimeoutSeconds
    if ($taskRemaining -gt 0) {
        $elapsedSeconds = [Math]::Max(0, [int]((Get-Date) - $startTime).TotalSeconds)
        $taskRemaining = [Math]::Max(0, $taskRemaining - $elapsedSeconds)
        if ($taskRemaining -eq 0) {
            $script:timedOut = $true
            $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с до выполнения хука"
            Write-Log "[agent-steward] Таймаут задачи ($TimeoutSeconds с) до выполнения хука: $Command"
            return 124
        }
    }
    $timeout = $GateTimeoutSeconds
    if ($taskRemaining -gt 0 -and ($timeout -le 0 -or $taskRemaining -lt $timeout)) {
        $timeout = $taskRemaining
    }
    $previousAllowPaths = $env:AGENT_STEWARD_GATE_ALLOW_PATHS
    if ($AllowPaths) { $env:AGENT_STEWARD_GATE_ALLOW_PATHS = $AllowPaths }

    if (-not $timeout -or $timeout -le 0) {
        $output = & cmd.exe /c $Command 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $previousAllowPaths) {
            Remove-Item Env:\AGENT_STEWARD_GATE_ALLOW_PATHS -ErrorAction SilentlyContinue
        } else {
            $env:AGENT_STEWARD_GATE_ALLOW_PATHS = $previousAllowPaths
        }
        # Без таймаута потоки.cmd объединены — сохраняем как stdout, stderr пуст.
        $script:lastHookStdout = (@($output) -join "\`n")
        $script:lastHookStderr = ""
        foreach ($line in @($output)) {
            Write-Log "[hook] $line"
        }
        return $code
    }

    # ВАЖНО: расширение должно быть .cmd. GetTempFileName() даёт .tmp, а
    # запуск файла .tmp через cmd.exe /c может зависнуть вместо быстрого выполнения.
    $hookFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-" + [guid]::NewGuid().ToString("N") + ".cmd")
    $ps1File = $null
    try {
        # QA-D316-4: для PowerShell-тела пишем .ps1 и делаем .cmd тонким шимом —
        # cmd.exe не разбирает '$r = ...' и '& ...'.
        # Обычная команда остаётся в старом формате (обратная совместимость).
        $lines = @('@echo off', 'chcp 65001 >nul', $Command)
        if (Test-PowerShellHookBody -Text $Command) {
            $ps1File = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-" + [guid]::NewGuid().ToString("N") + ".ps1")
            Set-Content -LiteralPath $ps1File -Value $Command -Encoding UTF8
            $escapedPs1 = $ps1File.Replace('"', '""')
            $lines = @('@echo off', "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \`"$escapedPs1\`" %*")
        }
        Set-Content -LiteralPath $hookFile -Value $lines -Encoding Default
        # Не используем Start-Process с -RedirectStandardOutput/-RedirectStandardError:
        # в Windows PowerShell 5.1 такой вызов может зависнуть на закрытии потоков,
        # даже если сам хук уже завершился. Запускаем процесс напрямую и читаем
        # stdout/stderr асинхронно — это не блокирует WaitForExit(timeout).
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = '/c "' + $hookFile + '"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        # Ребёнок наследует окружение в момент Start(), поэтому возвращаем
        # предыдущее значение сразу после запуска хука.
        try {
            if ($AllowPaths) { $env:AGENT_STEWARD_GATE_ALLOW_PATHS = $AllowPaths }
            $null = $proc.Start()
        } finally {
            if ($null -eq $previousAllowPaths) {
                Remove-Item Env:\AGENT_STEWARD_GATE_ALLOW_PATHS -ErrorAction SilentlyContinue
            } else {
                $env:AGENT_STEWARD_GATE_ALLOW_PATHS = $previousAllowPaths
            }
        }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $finished = $proc.WaitForExit([int]($timeout * 1000))
        if (-not $finished) {
            try { & taskkill.exe /F /T /PID $proc.Id 2>$null | Out-Null } catch {}
            try { $proc.WaitForExit(5000) | Out-Null } catch {}
            $code = 124
            Write-Log "[agent-steward] Таймаут хука ($timeout с): $Command"
            # QA-PORT-1: если лимит хука равен остатку бюджета задачи — это
            # не gate-timeout, а настоящий таймаут задачи. Отмечаем его, чтобы
            # Get-RecordVerdict записал status=timeout с понятной причиной.
            if ($taskRemaining -gt 0 -and $timeout -eq $taskRemaining) {
                $script:timedOut = $true
                $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с в хуке"
                Write-Log "[agent-steward] Таймаут задачи ($TimeoutSeconds с) в хуке: $Command"
            }
        } else {
            try { $proc.WaitForExit() } catch {}
            $code = $proc.ExitCode
        }
        $outText = ""
        $errText = ""
        if ($outTask.Wait(5000)) { try { $outText = $outTask.Result } catch {} }
        if ($errTask.Wait(5000)) { try { $errText = $errTask.Result } catch {} }
        $script:lastHookStdout = $outText
        $script:lastHookStderr = $errText
        foreach ($text in @($outText, $errText)) {
            foreach ($line in @($text -split "\r?\n")) {
                if ($line -ne "") {
                    Write-Log "[hook] $line"
                }
            }
        }
        return $code
    } catch {
        Write-Log "[agent-steward] Не удалось выполнить хук: $_"
        return 1
    } finally {
        Remove-Item -LiteralPath $hookFile -Force -ErrorAction SilentlyContinue
        # QA-D316-4: временный .ps1 живет ровно столько же, сколько и .cmd-шим.
        if ($ps1File) { Remove-Item -LiteralPath $ps1File -Force -ErrorAction SilentlyContinue }
    }
}

# PL-7.2: пишет отдельное событие hook.output с реальным exit code и
# разделёнными stdout/stderr. Наблюдаемость не должна ломать задачу.
function Write-HookStructuredOutput {
    param([string]$Phase, [int]$ExitCode)
    if (-not $RecorderFile) { return }
    $helper = Join-Path (Split-Path $RecorderFile -Parent) "hook-output.js"
    if (-not (Test-Path -LiteralPath $helper)) { return }
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-out-" + [guid]::NewGuid().ToString("N") + ".txt")
    $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-err-" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
        Set-Content -LiteralPath $outFile -Value ([string]$script:lastHookStdout) -Encoding UTF8
        Set-Content -LiteralPath $errFile -Value ([string]$script:lastHookStderr) -Encoding UTF8
        & node "$helper" $Phase $TaskName $ExitCode $outFile $errFile "$script:runId" 2>$null | Out-Null
    } catch {
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

# Hotfix 1.5.3.1: запуск opencode с реальным таймаутом.
# Раньше TimeoutSeconds принимался, но нигде не использовался — задача работала
# до конца, а статус 'timeout' не выставлялся никогда. Теперь параллельно
# стартует сторожевой job: по истечении лимита он помечает маркер и убивает
# дерево процессов задачи (taskkill /T), а обёртка переводит статус в 'timeout'.
# B8: снимок дерева процессов. CIM — основной источник; при его сбое
# пробуем старый WMI, а если и он недоступен — Get-Process/tasklist.
# Иерархию Get-Process и tasklist не отдают, поэтому при отсутствии данных
# сторож переходит в fail-closed и убивает дерево по корневому PID.
# PL-113: аргументы дочернего powershell.exe (особенно промпт с кавычками и
# многоточием) больше не передаются в командной строке. Сериализуем массив в
# JSON-файл, а сам вызов - в EncodedCommand: дочерний процесс разворачивает
# аргументы из JSON через @a и не переразбирает cmdline оболочки.
# PL-118: ребёнок сливает свой stderr в stdout ДО выхода из процесса (2>&1).
# Иначе родительский PowerShell 5.1 видит в потоке Error CLIXML и пытается его
# десериализовать; ANSI ESC (0x1B) в этом XML ломает разбор и в лог задачи
# падает «Не удалось обработать XML ... 0x1B ... недопустимым знаком».
function Invoke-ChildWithArgs {
    param([string]$CommandPath, [string[]]$Arguments, [string]$LogFile)
    $argsFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "sched-args-" + [guid]::NewGuid().ToString("N") + ".json")
    try {
        ConvertTo-Json -InputObject @($Arguments) -Compress -Depth 32 | Set-Content -LiteralPath $argsFile -Encoding UTF8
        $childCode = '$a = Get-Content -LiteralPath ''{0}'' -Raw -Encoding UTF8 | ConvertFrom-Json; & ''{1}'' @a 2>&1; exit $LASTEXITCODE' -f $argsFile.Replace("'", "''"), $CommandPath.Replace("'", "''")
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode))
        if ($LogFile) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand *>&1 | ForEach-Object { Format-LogLine $_ } | Out-File -FilePath $LogFile -Append -Encoding utf8
        } else {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand *>&1 | ForEach-Object { Format-LogLine $_ } | Out-Host
        }
        return $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $argsFile -Force -ErrorAction SilentlyContinue
    }
}
# PL-128: единое место вердикта записи (эквивалент resolveWrapperRecordVerdict()
# в TypeScript). Статус и причина history-записи определяются только здесь.
function Get-RecordVerdict {
    param(
        [bool]$TimedOut,
        [int]$ExitCode,
        [bool]$GatePassed,
        [bool]$GateEvaluated = $true,
        [int]$WatchdogExitCode = 124,
        [int]$AgentExitCode = 0,
        [bool]$IdleCompleted = $false,
        [bool]$WorkCompleted = $false
    )
    $killedByWatchdog = $TimedOut -or ($ExitCode -eq $WatchdogExitCode)
    # P1-C / PL-160: снятие сторожем простоя — НИКОГДА не success: с артефактами
    # или без, с гейтом или без. Обёртка возвращает 0 после idle (PL-124), поэтому
    # AgentExitCode=0 не должен маскировать прерванный прогон, а тривиальный
    # гейт (echo OK>файл) не подтверждает запуск, остановленный сторожем.
    # Таймаут по watchdog сохраняет свой вердикт (PL-128/timeout).
    if ($IdleCompleted -and -not $WorkCompleted -and -not $killedByWatchdog) {
        $idleExit = $AgentExitCode
        if ($idleExit -eq 0) { $idleExit = 1 }
        return [pscustomobject]@{
            Status = "error"
            Reason = "PL-160: агент завершён сторожем простоя без изменений"
            NormalizedExitCode = $idleExit
        }
    }
    # QA-D316-5 / QA-D316-10: агент снят completion/idle-сторожем на
    # финализации, артефакты уже записаны — это частичный успех независимо
    # от гейта. PL-134 мог прервать агента ПОСЛЕ пройденного гейта, который
    # проверял не все ожидаемые правки (например, не удалил строку ROADMAP).
    # Артефакты остаются на диске, прогон не помечается жёсткой ошибкой.
    if ($IdleCompleted -and $WorkCompleted) {
        return [pscustomobject]@{
            Status = "partial"
            Reason = "PL-134: артефакты сохранены, финализация прервана сторожем простоя"
            NormalizedExitCode = 0
        }
    }
    if ($GatePassed -and $killedByWatchdog) {
        return [pscustomobject]@{
            Status = "success"
            Reason = "PL-128: завершено watchdog по таймауту, gate=pass"
            NormalizedExitCode = 0
        }
    }
    if ($GatePassed) {
        return [pscustomobject]@{
            Status = "success"
            Reason = "PL-81: quality gate passed"
            NormalizedExitCode = 0
        }
    }
    if (-not $GateEvaluated -and $ExitCode -eq 0) {
        return [pscustomobject]@{
            Status = "success"
            Reason = "PL-81: успешное завершение без quality gate"
            NormalizedExitCode = 0
        }
    }
    if ($killedByWatchdog) {
        return [pscustomobject]@{
            Status = "timeout"
            Reason = "Таймаут: превышен лимит времени, quality gate не пройден"
            NormalizedExitCode = $ExitCode
        }
    }
    return [pscustomobject]@{
        Status = "error"
        Reason = "Код возврата $ExitCode"
        NormalizedExitCode = $ExitCode
    }
}

function Invoke-OpenCodeOnce {
    param([string]$CommandPath, [string[]]$Arguments)

    $watch = $null
    $timeoutMarker = ""
    # PL-51: состояние health-check лога (отдельный сторожевой job).
    $healthWatch = $null
    $healthMarker = ""
    $healthFailure = ""
    # PL-124: completion/idle-watcher — снимает дерево, когда агент записал
    # отчёт, но держит конвейер открытым и перестал потреблять CPU.
    $idleWatch = $null
    $completionMarker = ""
    $script:childIdleCompleted = $false
    $script:idleReason = ""
    if ($TimeoutSeconds -gt 0) {
        $timeoutMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-timeout-" + [guid]::NewGuid().ToString("N") + ".flag")
        $watch = Start-Job -ScriptBlock {
            param([int]$RootId, [int]$Seconds, [string]$Marker)
            Start-Sleep -Seconds $Seconds
            $selfId = $PID
            $all = @()
            try { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { $all = @() }
            if ($all.Count -eq 0) {
                try { $all = @(Get-WmiObject Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { $all = @() }
            }
            $dataAvailable = $all.Count -gt 0
            $targets = New-Object System.Collections.Generic.List[int]
            if ($dataAvailable) {
                $queue = New-Object System.Collections.Generic.Queue[int]
                $queue.Enqueue($RootId)
                $guard = 0
                while ($queue.Count -gt 0 -and $guard -lt 2000) {
                    $guard++
                    $current = $queue.Dequeue()
                    foreach ($p in $all) {
                        $childId = [int]$p.ProcessId
                        if ([int]$p.ParentProcessId -eq $current -and $childId -ne $selfId -and -not $targets.Contains($childId)) {
                            $targets.Add($childId)
                            $queue.Enqueue($childId)
                        }
                    }
                }
            }
            if ($targets.Count -gt 0) {
                try { Set-Content -Path $Marker -Value "timeout" -Encoding UTF8 } catch {}
                foreach ($targetId in @($targets)) {
                    try { & taskkill.exe /F /T /PID $targetId 2>$null | Out-Null } catch {}
                }
            } elseif (-not $dataAvailable) {
                # Fail-closed: дерево построить нельзя (CIM/WMI упали, Get-Process
                # и tasklist не дают родительских связей). Помечаем таймаут и
                # убиваем всё дерево от корня, иначе задача переживёт лимит.
                try { Set-Content -Path $Marker -Value "timeout" -Encoding UTF8 } catch {}
                $listing = $false
                try {
                    if (@(tasklist.exe /FO CSV /NH 2>$null).Count -gt 0) { $listing = $true }
                } catch {}
                if (-not $listing) {
                    try {
                        if (@(Get-Process -ErrorAction Stop).Count -gt 0) { $listing = $true }
                    } catch {}
                }
                try {
                    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/F", "/T", "/PID", [string]$RootId) -WindowStyle Hidden -ErrorAction Stop
                } catch {
                    if ($listing) {
                        try { & taskkill.exe /F /T /PID $RootId 2>$null | Out-Null } catch {}
                    }
                }
            }
        } -ArgumentList $PID, $TimeoutSeconds, $timeoutMarker
    }

    # PL-51: health-check лога. Некоторые модели уходят в бесконечный retry
    # (ECONNRESET / Free usage limit reached / Insufficient Balance) и висят
    # до самого TimeoutSeconds, не делая полезной работы. Сторожевой job читает
    # хвост лога и при повторяющейся ошибке пишет причину в лог, маркер и
    # завершает дерево процесса задачи — как сторож таймаута.
    # Пороги настраиваются env, по умолчанию: 15 с, 3 повтора, 40 строк.
    if ($env:AGENT_STEWARD_HEALTH_CHECK -ne "0" -and $LogFile) {
        $healthInterval = 15
        $healthThreshold = 3
        $healthTail = 40
        try {
            if ($env:AGENT_STEWARD_HEALTH_INTERVAL_SEC -match '^\\d+$') { $healthInterval = [Math]::Max(2, [int]$env:AGENT_STEWARD_HEALTH_INTERVAL_SEC) }
            if ($env:AGENT_STEWARD_HEALTH_REPEAT_THRESHOLD -match '^\\d+$') { $healthThreshold = [Math]::Max(1, [int]$env:AGENT_STEWARD_HEALTH_REPEAT_THRESHOLD) }
            if ($env:AGENT_STEWARD_HEALTH_TAIL_LINES -match '^\\d+$') { $healthTail = [Math]::Max(5, [int]$env:AGENT_STEWARD_HEALTH_TAIL_LINES) }
        } catch {}
        $healthMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-health-" + [guid]::NewGuid().ToString("N") + ".flag")
        $healthWatch = Start-Job -ScriptBlock {
            param([int]$RootId, [string]$Marker, [string]$LogPath, [int]$IntervalSec, [int]$Threshold, [int]$TailLines)
            $pattern = 'ECONNRESET|Free usage limit reached|Insufficient Balance|ECONNREFUSED|ETIMEDOUT'
            # Базовая линия: старые ошибки из предыдущих попыток не должны
            # убивать здоровый запуск — реагируем только на рост числа ошибок.
            $baseline = -1
            while ($true) {
                Start-Sleep -Seconds $IntervalSec
                if (-not $LogPath -or -not (Test-Path -LiteralPath $LogPath)) { continue }
                try { $tail = @(Get-Content -LiteralPath $LogPath -Tail $TailLines -ErrorAction Stop) } catch { continue }
                $bad = @($tail | Where-Object { $_ -match $pattern })
                if ($baseline -lt 0 -or $bad.Count -lt $baseline) { $baseline = $bad.Count; continue }
                if ($bad.Count -ge $baseline + $Threshold) {
                    $reason = "PL-51: модель повторяет ошибку ($($bad.Count) за последние $TailLines строк): $($bad[-1])"
                    try { Add-Content -LiteralPath $LogPath -Value "[agent-steward] $reason" -Encoding UTF8 } catch {}
                    try { Set-Content -LiteralPath $Marker -Value $reason -Encoding UTF8 } catch {}
                    try { & taskkill.exe /F /T /PID $RootId 2>$null | Out-Null } catch {}
                    break
                }
            }
        } -ArgumentList $PID, $healthMarker, $LogFile, $healthInterval, $healthThreshold, $healthTail
    }

    # PL-124: консервативный сторож простоя. Watchdog (124) и health-check (125)
    # сохраняют приоритет: окно простоя по умолчанию 60 с, опрос каждые 5 с,
    # поэтому короткие timeout-прогоны (например, 2 с в регрессии) не затрагиваются.
    # Окно настраивается через AGENT_STEWARD_COMPLETION_IDLE_SEC / _POLL_SEC.
    # QA-D316-5: AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC — дополнительное окно
    # (по умолчанию 0 с, минимум 0 с), которое добавляется к окну простоя, когда
    # за последнее время изменились артефакты задачи (git status/diff и файлы
    # reports в рабочей папке). Финализация после записи отчёта не считается
    # QA-D316-11: после PL-134 конвейер разблокируется раньше, чем агент
    # дозаписывает финальные правки (ROADMAP/CHANGELOG/тесты). Ждём
    # стабилизации дерева ДО quality gate и afterScript, чтобы снимок и коммит
    # видели полный манифест задачи. 0 отключает ожидание.
    function Wait-FinalizationSettle {
        param([string]$Dir)
        if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return }
        $max = 5
        try {
            if ($env:AGENT_STEWARD_FINALIZE_SETTLE_SEC -match '^\d+$') {
                $max = [Math]::Min(60, [int]$env:AGENT_STEWARD_FINALIZE_SETTLE_SEC)
            }
        } catch {}
        if ($max -le 0) { return }
        function Get-FinalizationStamp {
            param([string]$D)
            $stamp = ""
            $oldPref = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $stamp = [string]::Join([Environment]::NewLine, @(git -C $D status --porcelain --untracked-files=all 2>$null))
            } catch {}
            finally { $ErrorActionPreference = $oldPref }
            try {
                $reportDir = Join-Path $D "reports"
                if (Test-Path -LiteralPath $reportDir) {
                    foreach ($file in @(Get-ChildItem -LiteralPath $reportDir -File -ErrorAction Stop | Sort-Object Name)) {
                        $stamp = $stamp + "|" + $file.Name + ":" + $file.LastWriteTimeUtc.Ticks + ":" + $file.Length
                    }
                }
            } catch {}
            return $stamp
        }
        $stable = 0
        $previous = Get-FinalizationStamp -D $Dir
        for ($i = 0; $i -lt $max; $i++) {
            Start-Sleep -Seconds 1
            $current = Get-FinalizationStamp -D $Dir
            if ($current -eq $previous) { $stable++ } else { $stable = 0; $previous = $current }
            if ($stable -ge 2) {
                Write-Log "[agent-steward] QA-D316-11: артефакты финализации стабильны — гейт и afterScript видят полный манифест."
                return
            }
        }
        Write-Log "[agent-steward] QA-D316-11: артефакты менялись все $max с — полноту манифеста проверит afterScript."
    }

    # P1-SC1: сторож простоя снимает снимок потомков один раз. Дочерний агент,
    # который пережил taskkill (или породил новый процесс уже после снимка),
    # продолжал писать файлы ПОСЛЕ финализации истории обёрткой. Перед
    # финализацией повторно перечисляем дерево процессов, добиваем его и ждём
    # выхода. Окно ожидания настраивается AGENT_STEWARD_IDLE_KILL_WAIT_SEC.
    function Stop-RemainingChildProcesses {
        $waitSec = 5
        try {
            if ($env:AGENT_STEWARD_IDLE_KILL_WAIT_SEC -match '^\\d+$') {
                $waitSec = [Math]::Min(60, [int]$env:AGENT_STEWARD_IDLE_KILL_WAIT_SEC)
            }
        } catch {}
        $oldPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            for ($i = 0; $i -lt $waitSec; $i++) {
                $all = @()
                try { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { return }
                $targets = New-Object System.Collections.Generic.List[int]
                $queue = New-Object System.Collections.Generic.Queue[int]
                $queue.Enqueue([int]$PID)
                $guard = 0
                while ($queue.Count -gt 0 -and $guard -lt 2000) {
                    $guard++
                    $current = $queue.Dequeue()
                    foreach ($p in $all) {
                        $childId = [int]$p.ProcessId
                        if ([int]$p.ParentProcessId -eq $current -and $childId -ne [int]$PID -and -not $targets.Contains($childId)) {
                            $targets.Add($childId)
                            $queue.Enqueue($childId)
                        }
                    }
                }
                if ($targets.Count -eq 0) {
                    Write-Log "[agent-steward] P1-SC1: процесс-потомок остановлен до финализации истории."
                    return
                }
                foreach ($targetId in @($targets)) {
                    try { & taskkill.exe /F /T /PID $targetId 2>$null | Out-Null } catch {}
                }
                Start-Sleep -Seconds 1
            }
        } finally { $ErrorActionPreference = $oldPref }
    }

    # простоем. При grace=0 поведение и накладные расходы прежние (git не вызывается).
    if ($env:AGENT_STEWARD_COMPLETION_WATCH -ne "0") {
        $idlePoll = 5
        $idleWindow = 60
        $idleGrace = 0
        try {
            if ($env:AGENT_STEWARD_COMPLETION_POLL_SEC -match '^\d+$') { $idlePoll = [Math]::Max(1, [int]$env:AGENT_STEWARD_COMPLETION_POLL_SEC) }
            if ($env:AGENT_STEWARD_COMPLETION_IDLE_SEC -match '^\d+$') { $idleWindow = [Math]::Max(30, [int]$env:AGENT_STEWARD_COMPLETION_IDLE_SEC) }
            if ($env:AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC -match '^\d+$') { $idleGrace = [Math]::Max(0, [int]$env:AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC) }
        } catch {}
        $completionMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-idle-" + [guid]::NewGuid().ToString("N") + ".flag")
        $idleWatch = Start-Job -ScriptBlock {
            param([int]$RootId, [string]$Marker, [int]$PollSec, [int]$IdleSec, [int]$GraceSec, [string]$Workdir)
            # QA-D316-5: отпечаток артефактов — git status/diff плюс mtime и размер
            # файлов reports. Сравниваем со снимком, снятым до запуска агента.
            function Get-CompletionArtifactStamp {
                param([string]$Dir)
                $stamp = ""
                if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return $stamp }
                try {
                    $gitStatus = & git -C $Dir status --porcelain --untracked-files=all 2>$null
                    $gitDiff = & git -C $Dir diff --stat 2>$null
                    $stamp = [string]::Join([Environment]::NewLine, @($gitStatus)) + "#" +
                        [string]::Join([Environment]::NewLine, @($gitDiff))
                } catch {}
                try {
                    $reportDir = Join-Path $Dir "reports"
                    if (Test-Path -LiteralPath $reportDir) {
                        foreach ($file in @(Get-ChildItem -LiteralPath $reportDir -File -ErrorAction Stop | Sort-Object Name)) {
                            $stamp = $stamp + "|" + $file.Name + ":" + $file.LastWriteTimeUtc.Ticks + ":" + $file.Length
                        }
                    }
                } catch {}
                return $stamp
            }
            $lastCpu = -1.0
            $idleTicks = 0
            $tick = 0
            $baseMaxIdle = [Math]::Ceiling($IdleSec / [double]$PollSec)
            $graceTicks = [Math]::Ceiling($GraceSec / [double]$PollSec)
            $artifactStamp = $null
            $lastChangeTick = -1
            if ($GraceSec -gt 0) { $artifactStamp = Get-CompletionArtifactStamp -Dir $Workdir }
            while ($true) {
                Start-Sleep -Seconds $PollSec
                $tick++
                # QA-D316-5: grace действует, только когда артефакты менялись
                # в последние GraceSec секунд (graceTicks опросов).
                $recentArtifacts = $false
                if ($GraceSec -gt 0) {
                    $currentStamp = Get-CompletionArtifactStamp -Dir $Workdir
                    if ($currentStamp -ne $artifactStamp) {
                        $artifactStamp = $currentStamp
                        $lastChangeTick = $tick
                    }
                    $recentArtifacts = ($lastChangeTick -ge 0) -and (($tick - $lastChangeTick) -le $graceTicks)
                }
                $all = @()
                try { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, KernelModeTime, UserModeTime -ErrorAction Stop) } catch { continue }
                $targets = New-Object System.Collections.Generic.List[int]
                $queue = New-Object System.Collections.Generic.Queue[int]
                $queue.Enqueue($RootId)
                $guard = 0
                while ($queue.Count -gt 0 -and $guard -lt 2000) {
                    $guard++
                    $current = $queue.Dequeue()
                    foreach ($p in $all) {
                        $childId = [int]$p.ProcessId
                        if ([int]$p.ParentProcessId -eq $current -and $childId -ne $PID -and -not $targets.Contains($childId)) {
                            $targets.Add($childId)
                            $queue.Enqueue($childId)
                        }
                    }
                }
                if ($targets.Count -eq 0) { continue }
                $cpu = 0.0
                foreach ($targetId in @($targets)) {
                    foreach ($p in $all) {
                        if ([int]$p.ProcessId -eq $targetId) {
                            $cpu += ([double]$p.KernelModeTime) + ([double]$p.UserModeTime)
                            break
                        }
                    }
                }
                # QA-D316-5: пока артефакты менялись недавно, счётчик простоя
                # замораживается, а окно увеличивается на grace — финализация
                # агента после записи отчёта не прерывается сторожем.
                if ($recentArtifacts) {
                    $idleTicks = 0
                } elseif ($lastCpu -ge 0 -and $cpu -le $lastCpu) { $idleTicks++ } else { $idleTicks = 0 }
                $lastCpu = $cpu
                $maxIdle = $baseMaxIdle + $(if ($recentArtifacts) { $graceTicks } else { 0 })
                if ($idleTicks -ge $maxIdle) {
                    # PL-134: маркер несёт понятную причину, а не безликое "idle" —
                    # она попадёт в лог при финализации обёртки.
                    $reason = "PL-134: агент не отвечает (простой $IdleSec с, лог и CPU без изменений)"
                    try { Set-Content -Path $Marker -Value $reason -Encoding UTF8 } catch {}
                    foreach ($targetId in @($targets)) {
                        try { & taskkill.exe /F /T /PID $targetId 2>$null | Out-Null } catch {}
                    }
                    break
                }
            }
        } -ArgumentList $PID, $completionMarker, $idlePoll, $idleWindow, $idleGrace, $Workdir
    }

    # QV-8: дочерний opencode run не должен загружать инструменты планировщика
    # (иначе ребёнок видит все 32 инструмента и может рекурсивно создавать задачи).
    # Маркер живёт только время запуска ИИ и восстанавливается в finally.
    $previousChildRun = $env:AGENT_STEWARD_CHILD_RUN
    $env:AGENT_STEWARD_CHILD_RUN = "1"

    $script:timedOut = $false
    $script:attemptExitCode = 0
    # Состояние фильтра лога сбрасываем на каждой попытке: иначе незакрытый
    # служебный блок из упавшего запуска «съедал» бы весь лог следующей попытки.
    $script:inServiceBlock = $false
    $script:inComment = $false
    try {
        # Живой стриминг: вывод opencode проходит через конвейер и пишется в лог
        # (Out-File -Append) или консоль (Out-Host) построчно, по мере поступления.
        # Раньше вывод сначала копился в $output и сбрасывался одним куском только
        # после завершения процесса: дашборд/get_task_logs были слепы во время
        # долгих запусков, росла память, а при kill обёртки лог терялся целиком.
        # $LASTEXITCODE после конвейера сохраняет код последней нативной команды.
        if ($CommandPath -like "*.ps1") {
            # PL-113: больше не вызываем дочерний powershell с -File и массивом
            # аргументов в cmdline - он переразбирал её и ломал кавычки/многоточие.
            $script:attemptExitCode = Invoke-ChildWithArgs -CommandPath $CommandPath -Arguments $Arguments -LogFile $LogFile
        } elseif ($LogFile) {
            & $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-File -FilePath $LogFile -Append -Encoding utf8
            $script:attemptExitCode = $LASTEXITCODE
        } else {
            & $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-Host
            $script:attemptExitCode = $LASTEXITCODE
        }
    } finally {
        if ($null -eq $previousChildRun) {
            Remove-Item Env:\AGENT_STEWARD_CHILD_RUN -ErrorAction SilentlyContinue
        } else {
            $env:AGENT_STEWARD_CHILD_RUN = $previousChildRun
        }
        if ($timeoutMarker -and (Test-Path -LiteralPath $timeoutMarker)) {
            $script:timedOut = $true
        }
        if ($healthMarker -and (Test-Path -LiteralPath $healthMarker)) {
            try { $healthFailure = (Get-Content -LiteralPath $healthMarker -Raw -ErrorAction Stop).Trim() } catch { $healthFailure = "модель повторяет ошибку подряд" }
        }
        if ($completionMarker -and (Test-Path -LiteralPath $completionMarker)) {
            $script:childIdleCompleted = $true
            try { $script:idleReason = (Get-Content -LiteralPath $completionMarker -Raw -ErrorAction Stop).Trim() } catch { $script:idleReason = "" }
            if ($script:idleReason) {
                Write-Log "[agent-steward] PL-134: причина завершения по простою: $script:idleReason"
            }
            # P1-SC1: добиваем уцелевших потомков и ждём их выхода ДО финализации
            # истории и quality gate — иначе агент продолжает менять файлы уже
            # после закрытия прогона.
            Stop-RemainingChildProcesses
            # QA-D316-11: дожидаемся последних правок агента до гейта/afterScript.
            Wait-FinalizationSettle -Dir $Workdir
        }
        if ($watch) {
            Stop-Job -Job $watch -ErrorAction SilentlyContinue
            Remove-Job -Job $watch -Force -ErrorAction SilentlyContinue
        }
        if ($healthWatch) {
            Stop-Job -Job $healthWatch -ErrorAction SilentlyContinue
            Remove-Job -Job $healthWatch -Force -ErrorAction SilentlyContinue
        }
        if ($idleWatch) {
            Stop-Job -Job $idleWatch -ErrorAction SilentlyContinue
            Remove-Job -Job $idleWatch -Force -ErrorAction SilentlyContinue
        }
        if ($timeoutMarker) {
            Remove-Item -LiteralPath $timeoutMarker -Force -ErrorAction SilentlyContinue
        }
        if ($healthMarker) {
            Remove-Item -LiteralPath $healthMarker -Force -ErrorAction SilentlyContinue
        }
        if ($completionMarker) {
            Remove-Item -LiteralPath $completionMarker -Force -ErrorAction SilentlyContinue
        }
    }

    if ($script:timedOut) {
        Write-Log "[agent-steward] Таймаут: задача '$TaskName' превысила лимит $TimeoutSeconds с — процесс остановлен."
        $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с"
        return 124
    }
    if ($healthFailure) {
        Write-Log "[agent-steward] PL-51: задача '$TaskName' остановлена health-check: $healthFailure"
        $script:errorMessage = "Ошибка модели при запуске: $healthFailure"
        return 125
    }
    if ($script:childIdleCompleted) {
        # PL-124: отчёт уже записан, дерево снято по простою — освобождаем
        # конвейер и даём outer finally сразу вызвать quality gate/post-flight/--finish.
        $idleDetail = ""
        if ($script:idleReason) { $idleDetail = " Причина: $script:idleReason" }
        Write-Log "[agent-steward] PL-124: дочерний агент завершён/простаивает, дерево снято; история финализируется сразу.$idleDetail"
        return 0
    }
    return $script:attemptExitCode
}

# Фильтр технического шума и служебных блоков OpenCode.
# Строки ответа ИИ проходят без изменений.
#
# В TS-шаблоне обратные слэши удвоены, иначе JS съедает \s и regex ломается.
$esc = [char]27
$script:inServiceBlock = $false
$script:inComment = $false

$serviceOpen = '<\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'
$serviceClose = '<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>'
$serviceTag = '<\\s*/?\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'

function Format-LogLine {
    param($Line)
    $text = "$Line"

    # PL-118: CLIXML-преамбула и ошибки десериализации дочернего powershell.exe
    # (ANSI ESC 0x1B не является допустимым XML-символом) — технический шум,
    # а не сообщение задачи. Нормальные строки ошибок остаются в логе.
    if ($text -match "#< CLIXML|Не удалось обработать XML|Failed to process XML|недопустимым знаком|is an invalid character") { return }
    $text = [regex]::Replace($text, "</?(?:Objs|Obj|TN|T|MS|I\\d+|S|B|DT|Nil)\\b[^>]*>", "")
    $text = $text.Replace("_x000D_", " ").Replace("_x000A_", " ").Replace("_x001B_", "")

    # ANSI-последовательности (цвета, управление курсором), например ESC[0m.
    $text = $text -replace "$esc\\[[0-9;?]*[A-Za-z]", ""

    # Служебные блоки, целиком уместившиеся в одной строке.
    $text = [regex]::Replace($text, "$serviceOpen.*?$serviceClose", "", "IgnoreCase")
    $text = [regex]::Replace($text, '<!--.*?-->', "", "IgnoreCase")

    # Начало многострочного служебного блока OpenCode:
    # <dcp-system-reminder> ... </dcp-system-reminder> (и <system-reminder>).
    # Блоком считаем только тег в начале строки: одиночный тег внутри текста
    # (например, ИИ упомянул его в объяснении) не должен съедать следующие строки.
    if ($text -match "^\\s*$serviceOpen") { $script:inServiceBlock = $true }
    if ($text -match '^\\s*<!--') { $script:inComment = $true }

    if ($script:inServiceBlock -or $script:inComment) {
        $closed = $false
        if ($script:inServiceBlock -and $text -match $serviceClose) {
            $script:inServiceBlock = $false
            $closed = $true
        }
        if ($script:inComment -and $text -match '-->') {
            $script:inComment = $false
            $closed = $true
        }

        if ($closed) {
            # Блок закончился в этой строке — сохраняем только хвост после тега.
            $text = ($text -split '-->|<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>')[-1]
        } else {
            # Внутри служебного блока — строку не пишем.
            return
        }
    }

    # Одиночные теги, оставшиеся после вывода ИИ.
    $text = [regex]::Replace($text, $serviceTag, "", "IgnoreCase")
    $text = $text.TrimEnd()

    # Технический шум вложенного powershell.exe.
    if ($text -match "NativeCommandError|CategoryInfo|FullyQualifiedErrorId|RemoteException") { return }
    if ($text -match "^At [A-Za-z]:.*:") { return }
    if ($text -match "^\\s*\\+\\s*~+\\s*$") { return }
    if (-not $text.Trim()) { return }

    return $text
}

# PL-140: общая санитизация причины — используется и веткой ошибки агента
# (PL-130), и веткой провала Quality Gate. Принимает уже отобранные строки,
# режет ANSI/управляющие символы, маскирует присваивания секретов (QA-D316-6)
# и ограничивает длину (по умолчанию 200 символов, для гейта — 2000).
function Get-SanitizedReason {
    param([string[]]$ReasonLines, [int]$MaxLength = 200)
    $errorReason = ""
    if ($ReasonLines -and $ReasonLines.Count -gt 0) { $errorReason = [string]$ReasonLines[0] }
    if (-not $errorReason) { return "" }
    $limit = $MaxLength
    if ($limit -lt 1) { $limit = 200 }
    $sanitizedLines = @()
    foreach ($reasonLine in $ReasonLines) {
        $errorReason = [string]$reasonLine
        if (-not $errorReason) { continue }
        # Санитизация ANSI/управляющих символов и ограничение длины (как в PL-83).
        $errorReason = [regex]::Replace($errorReason, "$esc\\[[0-9;?]*[A-Za-z]", "")
        $errorReason = ($errorReason -replace '[^\x20-\x7EА-Яа-яЁё]', '').Trim()
        # QA-D316-6: вывод гейта уходит в историю задачи — маскируем типичные
        # присваивания TOKEN=/API_KEY=/password:, как и redactSecretsInText().
        $errorReason = [regex]::Replace($errorReason, '(?i)\\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\\s*[=:]\\s*(""|'')?[^\\s"",;]+', '$1=***')
        if (-not $errorReason) { continue }
        if ($errorReason.Length -gt $limit) { $errorReason = $errorReason.Substring(0, $limit) + '...' }
        $sanitizedLines += $errorReason
    }
    # QA-D316-6: причина гейта — несколько строк вывода, а не одна последняя.
    $errorReason = $sanitizedLines -join "\`n"
    if ($errorReason.Length -gt 200 -and $limit -eq 200) { $errorReason = $errorReason.Substring(0, 200) + '...' }
    elseif ($errorReason.Length -gt $limit) { $errorReason = $errorReason.Substring(0, $limit) + '...' }
    return $errorReason
}

# Пытается вытащить из лога задачи информацию о расходе токенов и стоимости.
# OpenCode может печатать строки вида "Tokens: 1234", "Usage: 1234 tokens",
# "cost: $0.012" и т.п. Если данные не найдены — возвращает пустые строки,
# чтобы recorder записал поля как отсутствующие.
function Get-UsageFromLog {
    param([string]$File)

    $result = @{ Tokens = ""; Cost = "" }
    if (-not $File) { return $result }

    $tail = @()
    try {
        if (Test-Path $File) {
            $tail = Get-Content -Path $File -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    } catch { return $result }
    if (-not $tail) { return $result }

    # Шаблоны намеренно «якорные»: метка должна стоять в начале строки
    # (допускается префикс времени лога). Раньше подходило любое "token=" или
    # "cost:" внутри текста — конфиг-дампы и проза ИИ давали ложный расход.
    $prefix = '^\\s*(?:\\[[^\\]]{4,40}\\]\\s*)?'
    $tokenPatterns = @(
        ($prefix + '(?i)(?:tokens?|token\\s+usage|usage)\\s*[:=]\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b'),
        ($prefix + '(?i)(?:input|output|total)\\s+tokens?\\s*[:=]?\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b')
    )
    $costPatterns = @(
        ($prefix + '(?i)(?:cost|total\\s+cost)\\s*[:=]?\\s*\\$\\s*([0-9]+(?:[.,][0-9]+)?)'),
        ($prefix + '(?i)(?:cost|total\\s+cost)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)'),
        # QA-F.1: OpenCode печатает costUsd=0.1 / cost_usd=0.75 / cost=0.25 без
        # валютного знака. Без этих шаблонов PS-обёртка теряла стоимость, тогда
        # как TS-парсер (src/core/record-history.ts) её уже распознавал.
        ($prefix + '(?i)(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*\\$?\\s*([0-9]+(?:[.,][0-9]+)?)'),
        ($prefix + '(?i)(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)')
    )

    # Идём с конца: OpenCode печатает итог последним, а более ранние строки
    # могут быть эхом промпта или промежуточной статистикой.
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
        $text = "$($tail[$i])"
        if ($text -match '(?i)opencode\\.json|OPENCODE_CONFIG') { continue }

        if (-not $result.Tokens) {
            foreach ($pattern in $tokenPatterns) {
                if ($text -match $pattern) {
                    $raw = $matches[1] -replace ',', '.'
                    $value = 0.0
                    if ([double]::TryParse($raw, [ref]$value)) {
                        $suffix = ""
                        if ($matches.Count -gt 2 -and $matches[2]) {
                            $suffix = $matches[2].ToString().ToLower()
                        }
                        if ($suffix -eq 'k') { $value = $value * 1000 }
                        elseif ($suffix -eq 'm') { $value = $value * 1000000 }
                        $result.Tokens = [string]([int64][Math]::Round($value))
                    }
                    break
                }
            }
        }

        if (-not $result.Cost) {
            foreach ($pattern in $costPatterns) {
                if ($text -match $pattern) {
                    $result.Cost = $matches[1] -replace ',', '.'
                    break
                }
            }
        }

        if ($result.Tokens -and $result.Cost) { break }
    }

    return $result
}

try {
    # Рабочая директория нужна и хукам, и основной задаче.
    if ($Workdir) {
        Set-Location $Workdir
    }

    # PL-105: pre-flight проверка, что workingDirectory задачи совпадает с
    # git-репозиторием. Иначе PL-59 молча пишет "дерево не является
    # git-репозиторием", хотя каталог может быть полноценным worktree.
    $script:gitWorktreeActive = $false
    if ($Workdir) {
        try {
            $gitTreeOut = & git -C $Workdir rev-parse --is-inside-work-tree 2>$null
            $script:gitWorktreeActive = ($LASTEXITCODE -eq 0 -and "$gitTreeOut".Trim() -eq "true")
        } catch {}
    }
    if ($script:gitWorktreeActive) {
        Write-Log "[agent-steward] PL-105: WorkingDirectory '$Workdir' is a git worktree - snapshot/isolation active."
    } else {
        Write-Log "[agent-steward] PL-105: WARNING WorkingDirectory '$Workdir' is not a git worktree - snapshot/isolation disabled. Set workingDirectory to the git repository root."
    }

    # PL-25: фиксируем состояние рабочего дерева до запуска ИИ. Перед гейтом
    # сверяем его, чтобы чужие незакоммиченные правки src/ не давали ложный зелёный.
    if ($QualityGate -and $GateSnapshotFile -and $Workdir -and $gateIntegrityFile -and (Test-Path -LiteralPath $gateIntegrityFile)) {
        $worktreeSnapshotFile = [System.IO.Path]::ChangeExtension($GateSnapshotFile, ".worktree.json")
        $snapAllowArgs = @()
        if ($GateAllowPaths) { $snapAllowArgs = @("--allow", $GateAllowPaths) }
        $snapOut = & node $gateIntegrityFile worktree-snapshot --dir "$Workdir" --out "$worktreeSnapshotFile" @snapAllowArgs 2>&1
        foreach ($line in $snapOut) { Write-Log "[agent-steward] $line" }
    }

    if ($WorkspaceName) {
        $gitBranch = "-"
        $gitRemote = "-"
        try {
            $branchOut = & git -C "$Workdir" rev-parse --abbrev-ref HEAD 2>$null
            if ($LASTEXITCODE -eq 0 -and $branchOut) { $gitBranch = "$branchOut".Trim() }
        } catch {}
        try {
            $remoteOut = & git -C "$Workdir" remote get-url origin 2>$null
            if ($LASTEXITCODE -eq 0 -and $remoteOut) { $gitRemote = "$remoteOut".Trim() }
        } catch {}
        Write-Log "[workspace] name=$WorkspaceName, cwd=$Workdir, branch=$gitBranch, remote=$gitRemote"
    }

    # Спринт 32 / релиз 1.6: политика прав вычисляется в TypeScript
    # (src/core/permissions.ts) и передаётся готовым JSON в base64.
    # Старые .cmd, созданные до 1.6, параметр не передают — для них остаётся
    # прежнее поведение «разрешено всё» (fallback ниже).
    $toolToAction = @{
        "read" = "read"; "write" = "edit"; "edit" = "edit"; "apply_patch" = "edit"; "remove" = "edit"
        "bash" = "shell"; "shell" = "shell"; "glob" = "glob"; "grep" = "grep"
        "webfetch" = "webfetch"; "websearch" = "websearch"; "question" = "question"
        "subagent" = "subagent"; "skill" = "skill"
    }
    if ($PermissionsB64) {
        try {
            $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PermissionsB64))
            $config = $decoded | ConvertFrom-Json
            $env:OPENCODE_CONFIG_CONTENT = ($config | ConvertTo-Json -Depth 5 -Compress)
            Write-Log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT"
        } catch {
            Write-Log "[policy] ERROR: cannot decode PermissionsB64 ($($_.Exception.Message)); falling back to legacy permissions"
            $PermissionsB64 = ""
        }
    }
    if ($PolicyB64) {
        try {
            $policyJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PolicyB64)) | ConvertFrom-Json
            $legacyFlag = ""
            if ($policyJson.legacyShell) { $legacyFlag = ", legacyShell=true" }
            Write-Log "[policy] policy=$($policyJson.policy)$legacyFlag"
            foreach ($denied in @($policyJson.denied)) {
                if ($denied.action) {
                    Write-Log "[policy] deny $($denied.action): $($denied.hint)"
                }
            }
        } catch {
            Write-Log "[policy] WARN: cannot decode PolicyB64 ($($_.Exception.Message))"
        }
    }
    if (-not $PermissionsB64) {
        # Legacy fallback для обёрток, созданных до 1.6: все action разрешены,
        # DeniedTools/AllowedTools применяются как раньше.
        $defaultPermissions = @(
            @{ action = "read"; resource = "*"; effect = "allow" },
            @{ action = "edit"; resource = "*"; effect = "allow" },
            @{ action = "glob"; resource = "*"; effect = "allow" },
            @{ action = "grep"; resource = "*"; effect = "allow" },
            @{ action = "shell"; resource = "*"; effect = "allow" },
            @{ action = "subagent"; resource = "*"; effect = "allow" },
            @{ action = "skill"; resource = "*"; effect = "allow" },
            @{ action = "question"; resource = "*"; effect = "allow" },
            @{ action = "webfetch"; resource = "*"; effect = "allow" },
            @{ action = "websearch"; resource = "*"; effect = "allow" }
        )
        $permissions = @()
        foreach ($p in $defaultPermissions) { $permissions += $p }
        if ($DeniedTools) {
            $deniedList = @($DeniedTools -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
            foreach ($tool in $deniedList) {
                $action = $toolToAction[$tool]
                if ($action) {
                    $idx = $permissions | Where-Object { $_.action -eq $action }
                    if ($idx) { $idx.effect = "deny" }
                }
            }
        }
        if ($AllowedTools) {
            $allowedList = @($AllowedTools -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
            $allowedActions = @{}
            foreach ($tool in $allowedList) {
                $action = $toolToAction[$tool]
                if ($action) { $allowedActions[$action] = $true }
            }
            foreach ($p in $permissions) {
                if (-not $allowedActions.ContainsKey($p.action)) { $p.effect = "deny" }
            }
        }
        $config = @{ "$schema" = "https://opencode.ai/config.json"; "permissions" = $permissions }
        $env:OPENCODE_CONFIG_CONTENT = ($config | ConvertTo-Json -Depth 3 -Compress)
        Write-Log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT (legacy fallback)"
    }

    # Pre-flight: выполняется ДО основной задачи. Ненулевой код отменяет запуск.
    if ($BeforeScript) {
        Write-Stage -Stage "preFlight" -Message "Pre-flight: $BeforeScript"
        $preCode = Invoke-HookScript -Command $BeforeScript
        # PL-69: Invoke-HookScript складывает потоки в $script:lastHookStderr/$script:lastHookStdout.
        $preErrorLines = @($script:lastHookStderr -split "\r?\n") | Where-Object { $_ -ne "" }
        $preStdoutLines = @($script:lastHookStdout -split "\r?\n") | Where-Object { $_ -ne "" }
        $preStderrText = (@($preErrorLines) -join " | ")
        Write-HookStructuredOutput -Phase "preFlight" -ExitCode $preCode
        if ($preCode -ne 0) {
            # QA-PORT-1: таймаут pre-flight — это таймаут задачи, а не ошибка хука.
            if ($preCode -eq 124 -and $script:timedOut) {
                Write-Log "[agent-steward] Таймаут задачи '$TaskName' в pre-flight: превышено $TimeoutSeconds с."
                $script:exitCode = 124
            } else {
                # PL-6.1: SilentlyContinue не гарантирует код 0 — подсказываем явный exit 0.
                Write-Log "[agent-steward] ОШИБКА: Pre-flight script failed (код $preCode). Завершите хук явным 'exit 0' (например: if (Test-Path -LiteralPath '<path>') { Remove-Item -LiteralPath '<path>' -Force }; exit 0)."
                # PL-69: реальная причина должна быть видна в get_task_logs, а не только общая фраза.
                Write-Log "[agent-steward] Pre-flight причина: command=$BeforeScript; exitCode=$preCode"
                foreach ($line in $preErrorLines) {
                    Write-Log "[agent-steward] Pre-flight stderr: $line"
                }
                foreach ($line in $preStdoutLines) {
                    Write-Log "[agent-steward] Pre-flight stdout: $line"
                }
                $script:errorMessage = "Pre-flight script failed (command=$BeforeScript, exitCode=$preCode; stderr=$preStderrText)"
                $script:exitCode = 1
            }
            $script:preFlightStatus = "error"
            $script:skipMainTask = $true
        } else {
            $script:preFlightStatus = "success"
            Write-Log "[agent-steward] Pre-flight успешно завершён."
        }
    }

    # QA-PORT-1: проверяем общий бюджет и после pre-flight. Хук мог завершиться
    # по таймауту гейта раньше лимита задачи, но съесть весь остаток времени —
    # агент в таком случае запускать нельзя, иначе задача снова «зависнет».
    if ($TimeoutSeconds -gt 0 -and -not $script:skipMainTask) {
        $elapsedBeforeAgent = [Math]::Max(0, [int]((Get-Date) - $startTime).TotalSeconds)
        if ($elapsedBeforeAgent -ge $TimeoutSeconds) {
            $script:timedOut = $true
            $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с до запуска агента"
            Write-Log "[agent-steward] Таймаут задачи '$TaskName' до запуска агента: превышено $TimeoutSeconds с."
            $script:exitCode = 124
            $script:skipMainTask = $true
        }
    }

    if (-not $script:skipMainTask) {
    # QA-P0.2: граница реального прогона для extractLastRunLog(). Маркер пишется
    # без префикса времени и только после guard/pre-flight — отменённый запуск
    # не должен выглядеть как реальный. Лог дописывается, показываем последний сегмент.
    if ($LogFile) {
        try {
            Add-Content -Path $LogFile -Value ("[agent-steward] === Run started " + $startedAtIso + " (" + $TaskName + ") ===") -Encoding utf8
            $script:quotaScanStart = (Get-Item -LiteralPath $LogFile).Length
        } catch {}
    }
    $prompt = Get-Content -Path $PromptFile -Raw -Encoding UTF8

    # W-1: запуск в одноразовом git worktree — сообщаем путь агенту.
    # Переменную выставляет .cmd-обёртка после успешного создания копии.
    if ($env:AGENT_STEWARD_WORKTREE) {
        Write-Log "[agent-steward] Git worktree: $env:AGENT_STEWARD_WORKTREE (repo: $env:AGENT_STEWARD_WORKTREE_REPO)"
        $worktreeContext = "[agent-steward] Рабочая директория запуска - одноразовый git worktree: " + $env:AGENT_STEWARD_WORKTREE + [Environment]::NewLine
        $prompt = $worktreeContext + $prompt
    }

    # PL-113: для .ps1-шима промпт больше не попадает в cmdline дочернего
    # процесса - Invoke-ChildWithArgs передаёт аргументы через JSON-файл и
    # EncodedCommand. Ограничение CreateProcess 32767 символов на него не
    # действует; проверка оставлена только как защита от аномально большого
    # промпта при прямом вызове .cmd/.exe. Основная валидация - в schedule_task.
    if ($prompt -and $prompt.Length -gt 30000) {
        throw "Промпт слишком длинный: $($prompt.Length) символов (максимум 30000). Сократите промпт."
    }

    # Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.
    if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
        try {
            Get-Content -Path $EnvFile -Encoding UTF8 | ForEach-Object {
                $line = $_.Trim()
                if ($line -and -not $line.StartsWith("#") -and $line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
                    $envKey = $matches[1]
                    $envValue = $matches[2]
                    # P2-21: секрет удалён/переименован — не подставляем литерал
                    # \${secret:...} агенту, а прерываем запуск с понятной ошибкой.
                    if ($envValue -match '\$\{secret:[^}]+\}') {
                        throw "Workspace '$WorkspaceName': переменная $envKey содержит неразрешённый секрет. Запуск отменён."
                    }
                    Set-Item -Path ("env:" + $envKey) -Value $envValue
                }
            }
            Write-Log "[agent-steward] Переменные окружения workspace загружены."
        } catch {
            Write-Log "[agent-steward] Не удалось загрузить env-файл workspace: $($_.Exception.Message)"
            # P2-21: ошибка конфигурации секретов должна валить задачу,
            # а не оставлять её работать без переменной окружения.
            throw
        }
    }

    # P-3.2: harness-параметризация. По умолчанию поведение прежнее
    # (opencode run --auto), но задача может указать другой агент через
    # $AgentCommandPath / $AgentArgs (env AGENT_COMMAND_PATH / AGENT_ARGS).
    $AgentCommandPath = $env:AGENT_COMMAND_PATH
    $AgentArgs = $env:AGENT_ARGS
    if (-not $AgentCommandPath) { $AgentCommandPath = $HarnessCommandPath }
    if (-not $AgentArgs) { $AgentArgs = $HarnessArgsBaked }
    if ($AgentCommandPath) {
        $opencodeCmd = $AgentCommandPath
    } else {
        # Получаем путь к скрипту opencode (.ps1 или .cmd)
        $opencodeCmd = Get-Command opencode | Select-Object -ExpandProperty Source
    }

    # Формируем аргументы для opencode run (Спринт 24: сессия).
    # Спринт 29.2: --auto автоодобряет не запрещённые права, а ограничения
    # берутся из сгенерированного opencode.jsonc в Workdir.
    if ($AgentArgs) {
        $opencodeArgs = @($AgentArgs -split '\s+')
    } else {
        $opencodeArgs = @("run", "--auto")
    }
    if ($Model) {
        $opencodeArgs += @("--model", $Model)
    }
    if ($SessionMode -eq 'reuse') {
        # Спринт 24: актуальный id читаем из sidecar-файла — ротация сессии
        # обновляет файл, и обёртку не нужно пересоздавать.
        $effectiveSessionId = $SessionId
        if ($SessionFile -and (Test-Path -LiteralPath $SessionFile)) {
            try {
                $fromFile = (Get-Content -LiteralPath $SessionFile -Raw -ErrorAction Stop).Trim()
                if ($fromFile) { $effectiveSessionId = $fromFile }
            } catch {
                Write-Log "[agent-steward] Не удалось прочитать файл сессии: $($_.Exception.Message)"
            }
        }
        if ($effectiveSessionId) {
            $opencodeArgs += @("--session", $effectiveSessionId)
        }
    } elseif ($SessionMode -eq 'last') {
        $opencodeArgs += @("--continue")
    }
    if ($prompt) {
        # B11.1: «--» завершает разбор флагов opencode. Без него промпт,
        # начинающийся с «-», CLI принял бы за неизвестный флаг.
        $opencodeArgs += @("--", $prompt)
    }

    # Запускаем opencode и НАПРЯМУЮ направляем весь вывод (stdout + stderr) в лог.
    # Out-File -Append -Encoding utf8 пишет по мере поступления строк, поэтому
    # ответ ИИ появляется в GUI ещё до завершения задачи.
    # B2: обёртка делает РОВНО одну попытку. Повторы — зона recorder'а
    # (retryCount/retryDelay в БД), иначе на Windows получалось (1+N)^2
    # запусков: N попыток внутри обёртки × N+1 запуск из recorder'а.
    # Параметры -RetryCount/-RetryDelaySeconds принимаются, но игнорируются.
    # QA-D316-26/29: фиксируем состояние дерева ДО запуска. Иностранные
    # untracked-файлы (reports/*) не должны выдаваться за артефакт агента.
    $baselineDirty = @()
    if ($Workdir) {
        try { $baselineDirty = @(& git -C $Workdir status --porcelain --untracked-files=all 2>$null) } catch {}
    }
    Write-Stage -Stage "run" -Message "Запуск агента: $opencodeCmd"
    $script:exitCode = Invoke-OpenCodeOnce -CommandPath $opencodeCmd -Arguments $opencodeArgs
    # PL-81: код выхода процесса запоминаем до всех классификаторов (квота и т.д.),
    # чтобы потом отличить "ошибку агента" от "ошибки верификации".
    $agentExitCode = $script:exitCode
    $quotaDetected = $false

    # QA-PORT-6: сканируем лог НЕЗАВИСИМО от кода выхода. Дочерний агент может
    # упереться в лимит Free, а основной — успешно откатиться к primary (PL-72)
    # и завершиться с кодом 0. Раньше квота в таком прогоне терялась без следа.
    $quotaChild = $false
    $quotaPartialLines = @()
    $quotaLine = @()
    if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
        $quotaText = ""
        try {
            # QW-7: читаем только хвост после маркера текущего прогона —
            # -Tail 80 всё равно заглядывал в прошлый запуск при коротком выводе.
            $quotaStream = [System.IO.File]::Open($LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
                if ($script:quotaScanStart -gt 0 -and $script:quotaScanStart -lt $quotaStream.Length) {
                    $quotaStream.Position = $script:quotaScanStart
                }
                $quotaReader = New-Object System.IO.StreamReader($quotaStream, [System.Text.Encoding]::UTF8)
                try { $quotaText = $quotaReader.ReadToEnd() } finally { $quotaReader.Dispose() }
            } finally { $quotaStream.Dispose() }
        } catch {}
        if ($quotaText) {
            $quotaSegments = @($quotaText -split "\r?\n")
            $quotaIndexes = @()
            for ($qi = 0; $qi -lt $quotaSegments.Count; $qi++) {
                if ($quotaSegments[$qi] -match 'Free usage limit reached|Insufficient Balance|free usage limit') { $quotaIndexes += $qi }
            }
            if ($quotaIndexes.Count -gt 0) {
                $quotaLine = @($quotaSegments[$quotaIndexes[-1]])
                # QA-PORT-6: контекст дочернего агента — строка квоты или 3 строки перед ней.
                foreach ($qi in $quotaIndexes) {
                    $contextFrom = [Math]::Max(0, $qi - 3)
                    $quotaContext = @($quotaSegments[$contextFrom..$qi]) -join [char]10
                    if ($quotaContext -match 'subagent|sub-agent|explore|агент') { $quotaChild = $true; break }
                }
                $firstQuotaIndex = [int]$quotaIndexes[0]
                if ($firstQuotaIndex -gt 0) {
                    $quotaPartialLines = @($quotaSegments[0..($firstQuotaIndex - 1)] |
                        Where-Object { $_ -and $_ -notmatch '^\\[agent-steward\\]|^=== Run started |^\\[role-scoped\\]|^\\d{4}-\\d{2}-\\d{2}' } |
                        Select-Object -Last 40)
                }
            }
        }
    }

    if ($quotaLine.Count -gt 0 -or $quotaChild) {
    # PL-83: исчерпание квоты/баланса модели — отдельный класс ошибки, а не
    # обычный «Код возврата 1». Иначе гейт и afterScript пропускаются, а частично
    # изменённое дерево остаётся без артефакта и без понятной подсказки.
    if ($script:exitCode -ne 0 -and $quotaLine.Count -gt 0) {
        $quotaReason = [string]$quotaLine[0]
        # PL-114: strip ANSI/control noise and cap the length.
        $quotaReason = [regex]::Replace($quotaReason, "$esc\\[[0-9;?]*[A-Za-z]", "")
        $quotaReason = ($quotaReason -replace '[^\x20-\x7EА-Яа-яЁё]', '').Trim()
        if ($quotaReason.Length -gt 160) { $quotaReason = $quotaReason.Substring(0, 160) + '...' }
        $quotaSlug = $TaskName -replace '[^a-zA-Z0-9_-]', '-'
        $quotaDiff = ""
        try {
            # quota-diff должен пережить удаление одноразового worktree.
            $quotaBase = $script:checkoutRoot
            if (-not $quotaBase) { $quotaBase = (Get-Location).Path }
            $quotaDiff = Join-Path $quotaBase ("reports/quota-" + $quotaSlug + ".diff")
        } catch {}
        if (-not $quotaDiff) {
            $quotaDiff = Join-Path ([System.IO.Path]::GetTempPath()) ("quota-" + $quotaSlug + ".diff")
        }
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quotaDiff) | Out-Null
            & git -C $Workdir diff > $quotaDiff 2>&1
        } catch {}
        if ($quotaChild) { $quotaReason = "QA-PORT-6: дочерний агент — $quotaReason" }
        Write-Log "[agent-steward] PL-83: квота модели исчерпана: $quotaReason"
        if ($quotaChild) { Write-Log "[agent-steward] QA-PORT-6: PL-83 в дочернем агенте" }
        $modelHint = ""
        if ($Model) { $modelHint = " Текущая модель задачи: $Model." }
        $script:errorMessage = "PL-83: квота модели исчерпана ($quotaReason). Частичные правки сохранены в $quotaDiff. Перезапустите задачу с другой моделью: update_task name=$TaskName model=provider/model$modelHint"
        $script:exitCode = 126
        $quotaDetected = $true
    } elseif ($script:exitCode -eq 0 -and $quotaChild -and $quotaPartialLines.Count -gt 0) {
        # QA-PORT-6: основной агент завершился успешно, но дочерний упёрся в квоту.
        # Не перебиваем успешный статус (PL-72/PL-90 — fallback разрешён), но
        # сохраняем диагностику и частичный результат дочернего агента.
        $quotaSlug = $TaskName -replace '[^a-zA-Z0-9_-]', '-'
        $quotaPartialBase = $script:checkoutRoot
        if (-not $quotaPartialBase) { $quotaPartialBase = (Get-Location).Path }
        $quotaPartial = Join-Path $quotaPartialBase ("reports/quota-" + $quotaSlug + "-partial.txt")
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quotaPartial) | Out-Null
            $quotaPartialLines | Out-File -FilePath $quotaPartial -Encoding utf8
        } catch {}
        Write-Log "[agent-steward] QA-PORT-6: квота Free у дочернего агента; основной агент завершился успешно, частичный результат сохранён в $quotaPartial (fallback по PL-72)."
    }
    }

    # PL-81: код выхода процесса — факт завершения, а не вердикт проверки.
    # Гейт запускается и при ненулевом коде, если агент оставил артефакты/вывод
    # (workCompleted). Причину кода фиксируем в логе, но статус задачи defines
    # verdict гейта; post-flight в любом случае выполняется в finally.
    # PL-160: «артефакт работы» — реальное изменение дерева, а не вывод агента.
    # Разведка (2 шага без правок) создаёт строки в логе, но не изменения в git.
    $script:agentArtifactPresent = $false
    if ($Workdir) {
        try {
            $dirty = @(& git -C $Workdir status --porcelain --untracked-files=all 2>$null)
            if ($LASTEXITCODE -eq 0) {
                # QA-D316-26: артефакт — только НОВОЕ изменение относительно
                # состояния дерева до запуска, а не любой вывод агента в логе.
                foreach ($entry in $dirty) {
                    if ($baselineDirty -notcontains $entry) { $script:agentArtifactPresent = $true; break }
                }
            }
        } catch {}
    }
    $agentWorkCompleted = $script:agentArtifactPresent
    $gatePassed = $null
    # QA-D316-29: прерванный агент (idle/kill) не даёт гейту права
    # коммитить частичные правки — маркер гейта не создаётся, afterScript
    # (pl-commit.ps1) пропускает такой прогон.
    $agentInterrupted = $script:childIdleCompleted -or $agentExitCode -lt 0 -or $agentExitCode -eq 124
    $runQualityGate = $QualityGate -and -not $quotaDetected -and -not $agentInterrupted -and
        ($script:exitCode -eq 0 -or $agentWorkCompleted)
    if ($runQualityGate) {
        # G-1.2: перед запуском гейта сверяем его входы со snapshot'ом,
        # снятым при создании задачи. При расхождении гейт НЕ выполняется.
        $gateIntegrityOk = $false
        if ($GateSnapshotFile -and (Test-Path -LiteralPath $GateSnapshotFile)) {
            if (Test-Path -LiteralPath $gateIntegrityFile) {
                $verifyOutput = & node $gateIntegrityFile verify --snapshot "$GateSnapshotFile" --gate-file "$QualityGate" --prompt-file "$PromptFile" --timeout $GateTimeoutSeconds 2>&1
                $verifyCode = $LASTEXITCODE
                foreach ($line in $verifyOutput) { Write-Log "[agent-steward] $line" }
                if ($verifyCode -eq 0) {
                    $gateIntegrityOk = $true
                } else {
                    Write-Log "[agent-steward] ОШИБКА: целостность входов Quality Gate нарушена (snapshot mismatch)."
                    $script:errorMessage = "Quality Gate: целостность входов нарушена (snapshot mismatch)"
                    $script:exitCode = 1
                    $gatePassed = $false
                }
            } else {
                Write-Log "[agent-steward] ОШИБКА: не найден помощник проверки целостности гейта."
                $script:errorMessage = "Quality Gate: помощник проверки целостности не найден"
                $script:exitCode = 1
                $gatePassed = $false
            }
        } else {
            Write-Log "[agent-steward] ОШИБКА: snapshot гейта отсутствует — запуск с гейтом невозможен."
            $script:errorMessage = "Quality Gate: snapshot входов отсутствует"
            $script:exitCode = 1
            $gatePassed = $false
        }

        if ($gateIntegrityOk -and $worktreeSnapshotFile -and (Test-Path -LiteralPath $worktreeSnapshotFile)) {
            $verifyAllowArgs = @()
            if ($GateAllowPaths) { $verifyAllowArgs = @("--allow", $GateAllowPaths) }
            $worktreeOut = & node $gateIntegrityFile worktree-verify --dir "$Workdir" --snapshot "$worktreeSnapshotFile" @verifyAllowArgs 2>&1
            $worktreeCode = $LASTEXITCODE
            foreach ($line in $worktreeOut) { Write-Log "[agent-steward] $line" }
            if ($worktreeCode -ne 0) {
                # PL-121: не теряем причину — достаём строку gate-integrity: из вывода
                # worktree-verify, чтобы в логе/истории были конкретные изменившиеся пути.
                $worktreeReason = ""
                $gateMarker = "gate-integrity:"
                foreach ($line in $worktreeOut) {
                    $lineText = "$line"
                    $markerIndex = $lineText.IndexOf($gateMarker)
                    if ($markerIndex -ge 0) {
                        $worktreeReason = $lineText.Substring($markerIndex + $gateMarker.Length).Trim()
                        break
                    }
                }
                $gateIntegrityOk = $false
                $worktreeDetail = "Quality Gate: рабочее дерево изменилось во время прогона"
                if ($worktreeReason) { $worktreeDetail = "$worktreeDetail ($worktreeReason)" }
                Write-Log "[agent-steward] ОШИБКА: $worktreeDetail — гейт не доверяем."
                $script:errorMessage = $worktreeDetail
                $script:exitCode = 1
                $gatePassed = $false
            }
        }

        if ($gateIntegrityOk) {
            Write-Stage -Stage "gate" -Message "Запуск Quality Gate: $QualityGate"
            # Тот же таймаут, что у хуков: зависший gate не должен держать lock.
            # PL-107: хук видит список файлов задачи -> scoped lint вместо eslint src.
            $gateCode = Invoke-HookScript -Command $QualityGate -AllowPaths $GateAllowPaths
            # QA-D316-6: структурированный вывод гейта пишется сразу после прогона —
            # get_history/get_task_logs получают stdout/stderr и фазу qualityGate.
            Write-HookStructuredOutput -Phase "qualityGate" -ExitCode $gateCode

            if ($gateCode -eq 124) {
                if ($script:timedOut) {
                    # QA-PORT-1: гейт съел остаток бюджета задачи.
                    Write-Log "[agent-steward] Таймаут задачи '$TaskName' в Quality Gate: превышено $TimeoutSeconds с."
                    $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с в Quality Gate"
                    $script:exitCode = 124
                } else {
                    Write-Log "[agent-steward] ОШИБКА: Quality Gate превысил таймаут $GateTimeoutSeconds с и был остановлен."
                    $script:errorMessage = "Quality Gate: превышен таймаут $GateTimeoutSeconds с"
                    $script:exitCode = 1
                }
                $gatePassed = $false
            } elseif ($gateCode -ne 0) {
                # PL-140: причина провала — из хвоста вывода гейта (stdout/stderr,
                # которые Invoke-HookScript складывает в lastHookStdout/lastHookStderr),
                # а не только голый «Код возврата N». Санитизация — общим хелпером.
                $gateOutputLines = @()
                foreach ($gateStream in @($script:lastHookStdout, $script:lastHookStderr)) {
                    if ($gateStream) {
                        $gateOutputLines += @($gateStream -split "\r?\n" | Where-Object { $_ -and $_.Trim() })
                    }
                }
                # QA-GATE-REASON: npm notice/warn — это шум установки, а не причина
                # провала. Сначала берём первую строку с error/FAIL, иначе — хвост.
                $diagnosticLines = @($gateOutputLines | Where-Object { $_ -notmatch '^\\s*npm (?:notice|warn)\\b' })
                $errorLines = @($diagnosticLines | Where-Object { $_ -match '(?i)(?:\\berror\\b|\\bFAIL\\b)' })
                $gateReasonLines = @($errorLines | Select-Object -First 1)
                if ($gateReasonLines.Count -eq 0) {
                    $gateReasonLines = @($diagnosticLines | Select-Object -Last 1)
                }
                $gateReason = Get-SanitizedReason -ReasonLines $gateReasonLines
                # QA-D316-6: причина — хвост из ~10 непустых строк stdout+stderr,
                # санитизированный общим хелпером и ограниченный 2000 символов.
                $gateTailLines = @($diagnosticLines | Select-Object -Last 10)
                if ($errorLines.Count -gt 0) {
                    $gateTailLines = @($errorLines | Select-Object -First 3)
                }
                if ($gateTailLines.Count -gt 1) {
                    $gateReason = Get-SanitizedReason -ReasonLines $gateTailLines -MaxLength 2000
                }
                $gateDetail = "Quality Gate провален. Код возврата: $gateCode"
                if ($gateReason) { $gateDetail = "$gateDetail. Причина: $gateReason" }
                Write-Log "[agent-steward] ОШИБКА: $gateDetail"
                $script:errorMessage = $gateDetail
                $script:exitCode = 1
                $gatePassed = $false
            } else {
                Write-Log "[agent-steward] Quality Gate пройден."
                $gatePassed = $true
            }
        }
    }

    # QA-D316-10: idle-сторож прервал финализацию. Гейт, который успел пройти
    # до этого, подтверждает только проверенные им файлы (например, CHANGELOG
    # и маркер), но не полноту правок: строка ROADMAP могла остаться на месте,
    # а коммит после гейта не состоялся. Такой гейт недоверен — обнуляем его,
    # чтобы вердикт был partial, а не success.
    if ($script:childIdleCompleted -and $script:agentArtifactPresent -and $gatePassed -eq $true) {
        Write-Log "[agent-steward] QA-D316-10: PL-134 прервал финализацию после пройденного гейта — результат partial, полнота правок не подтверждена."
        $gatePassed = $false
        if (-not $script:errorMessage) {
            $script:errorMessage = "PL-134: финализация прервана сторожем простоя"
        }
    }

    # PL-81: разделяем "ошибку агента" и "ошибку верификации". Если гейт прошёл,
    # ненулевой код возврата агента не делает задачу error: причина кода
    # фиксируется в истории, а post-flight (коммит) выполняется в полном объёме.
    if ($gatePassed -eq $true -and $agentExitCode -ne 0 -and $script:exitCode -ne 0 -and
        -not ($script:childIdleCompleted -and -not $script:agentArtifactPresent)) {
        $divergenceReason = "Код возврата $agentExitCode при пройденном qualityGate (PL-81)"
        Write-Log "[agent-steward] PL-81: расхождение: код выхода процесса агента $agentExitCode, qualityGate=pass — задача '$TaskName' считается успешной, причина кода зафиксирована"
        $script:errorMessage = $divergenceReason
        $script:exitCode = 0
    }

    if ($script:exitCode -ne 0) {
        # Раньше пустое errorMessage превращалось в "-" в истории: причина
        # падения терялась (например, при отказе модели до вывода в лог).
        if (-not $script:errorMessage) {
            $script:errorMessage = "Код возврата $($script:exitCode)"
            # PL-130: последняя осмысленная строка хвоста лога объясняет,
            # почему агент упал, вместо голого «Код возврата 1».
            $reasonLines = @()
            if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
                try {
                    $reasonLines = @(Get-Content -LiteralPath $LogFile -Tail 80 -Encoding UTF8 -ErrorAction Stop |
                        Where-Object { $_ -match 'error|ERROR|Error|ошибка|OOM|limit|quota|ENOTFOUND|ECONNRESET' } |
                        Select-Object -Last 1)
                } catch {}
            }
            # PL-140: санитизация вынесена в общий хелпер (используется и гейтом).
            $errorReason = Get-SanitizedReason -ReasonLines $reasonLines
            if ($errorReason) {
                $script:errorMessage = "$($script:errorMessage). Причина: $errorReason"
                Write-Log "[agent-steward] PL-130: причина ошибки агента: $errorReason"
            }
        }
        Write-Log "[agent-steward] ОШИБКА: задача '$TaskName' завершилась с кодом $($script:exitCode). $script:errorMessage"
    } else {
        Write-Log "[agent-steward] Задача '$TaskName' успешно завершена."
    }
    } # конец блока основной задачи
} catch {
    Write-Log "[agent-steward] Ошибка выполнения задачи '$TaskName': $_"
    $script:errorMessage = "Ошибка выполнения задачи: $_"
    $script:exitCode = 1
} finally {
    # Post-flight: выполняется ВСЕГДА, даже если основная задача упала.
    if ($AfterScript) {
        Write-Stage -Stage "postFlight" -Message "Post-flight: $AfterScript"
        $postCode = Invoke-HookScript -Command $AfterScript
        Write-HookStructuredOutput -Phase "postFlight" -ExitCode $postCode
        if ($postCode -ne 0) {
            # QA-PORT-1: таймаут post-flight не должен перезаписать причину
            # таймаута задачи и статус 124, иначе история снова уйдёт в error.
            if ($postCode -eq 124 -and $script:timedOut) {
                Write-Log "[agent-steward] Таймаут задачи '$TaskName' в post-flight: превышено $TimeoutSeconds с."
            } else {
                Write-Log "[agent-steward] ОШИБКА: Post-flight script failed (код $postCode)."
                if ($script:exitCode -eq 0) {
                    $script:errorMessage = "Post-flight script failed"
                    $script:exitCode = 1
                }
            }
            $script:postFlightStatus = "error"
        } else {
            $script:postFlightStatus = "success"
            Write-Log "[agent-steward] Post-flight успешно завершён."
        }
    }

    # Фиксируем факт выполнения в историю и метрики (независимо от того, кто запустил: GUI или Windows)
    $endTime = Get-Date
    $durationMs = [int](($endTime - $startTime).TotalMilliseconds)
    # Hotfix 1.5.3.1: статус timeout теперь реально выставляется (см. Invoke-OpenCodeOnce).
    # PL-114: quota is the root cause even when the watchdog also fired.
    # PL-128: статус/причину записи считает Get-RecordVerdict — одно место для
    # PL-81, PL-114 и watchdog; --finish вызывается сразу после разблокировки
    # конвейера completion/idle-watcher'ом, без ожидания 900 с.
    $gateEvaluated = $null -ne $gatePassed
    $recordVerdict = Get-RecordVerdict -TimedOut ([bool]$script:timedOut) -ExitCode ([int]$script:exitCode) -GatePassed ([bool]$gatePassed) -GateEvaluated $gateEvaluated -AgentExitCode ([int]$agentExitCode) -IdleCompleted ([bool]$script:childIdleCompleted) -WorkCompleted ([bool]$script:agentArtifactPresent)
    if ($quotaDetected) {
        $status = "error"
    } else {
        $status = $recordVerdict.Status
        # QA-PORT-5: причина успешного вердикта (PL-81/PL-128) — диагностика,
        # а не ошибка задачи. Раньше она попадала в error history-записи со
        # статусом success. Реальную ошибку (pre/post-flight, гейт) не трогаем.
        if ($recordVerdict.Status -eq "success") {
            if ($recordVerdict.Reason -and $recordVerdict.Reason -notlike "PL-128:*" -and -not $script:errorMessage) {
                Write-Log "[agent-steward] $($recordVerdict.Reason)"
            }
        } elseif ($recordVerdict.Reason -and ($recordVerdict.Status -ne "error" -or -not $script:errorMessage)) {
            $script:errorMessage = $recordVerdict.Reason
        }
        if ($recordVerdict.Status -eq "success" -and $recordVerdict.NormalizedExitCode -ne $script:exitCode) {
            $script:exitCode = $recordVerdict.NormalizedExitCode
        }
        if ($recordVerdict.Status -eq "error" -and $recordVerdict.NormalizedExitCode -ne 0 -and $script:exitCode -eq 0) {
            $script:exitCode = $recordVerdict.NormalizedExitCode
        }
    }
    if ($recordVerdict.Reason -like "PL-128:*") {
        Write-Log "[agent-steward] $($recordVerdict.Reason)"
    }
    $usage = Get-UsageFromLog -File $LogFile
    $tokensArg = "-"
    if ($usage.Tokens) { $tokensArg = $usage.Tokens }
    $costArg = "-"
    if ($usage.Cost) { $costArg = $usage.Cost }
    $modelArg = "-"
    if ($Model) { $modelArg = $Model }
    # Hotfix 1.5.3.1: пустая строка ошибки раньше «съедалась» PowerShell и
    # сдвигала все следующие аргументы recorder (model получал preFlight,
    # postFlight терялся). Теперь всегда передаём непустое значение.
    $errorArg = "-"
    if ($script:errorMessage) { $errorArg = $script:errorMessage }
    if ($RecorderFile) {
        try {
            if ($script:runId) {
                & node "$RecorderFile" --finish "$script:runId" "$TaskName" "$status" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus" "$LogFile"
            } else {
                # Fallback: --start не удался (например, старая установка) —
                # пишем завершённую запись старым способом, без потери истории.
                & node "$RecorderFile" "$TaskName" "$status" "$startedAtIso" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus" "$LogFile"
            }
        } catch {}
    }

    # Снимаем блокировку только если мы её захватили: иначе пропущенный
    # параллельный запуск удалял бы lock активной задачи.
    if ($script:lockAcquired -and $LockFile -and (Test-Path $LockFile)) {
        try {
            Remove-Item $LockFile -Force
        } catch {}
    }
    # PL-121: checkout-lock общий для всех задач чек-аута — снимаем только тот,
    # который захватили сами; чужой живой lock не удаляем никогда.
    if ($script:checkoutLockAcquired -and $script:checkoutLockFile -and (Test-Path $script:checkoutLockFile)) {
        try {
            Remove-Item $script:checkoutLockFile -Force
        } catch {}
    }
}

exit $script:exitCode
`;

/**
 * Гарантирует existence директорий плагина и записывает generic-обёртку.
 * Возвращает путь к обёртке.
 */
/**
 * QA-CONSOLE-1: планировщик Windows запускает `.cmd` через `schtasks /tr`,
 * и сам `cmd.exe` показывает консольное окно даже внутри PowerShell-обёртки
 * с `-WindowStyle Hidden`. Единый windowless-шип на WScript.Shell запускает
 * целевую обёртку с `intWindowStyle = 0` и дожидается её завершения,
 * пробрасывая код выхода в Планировщик заданий.
 *
 * Скрипт намеренно ASCII-only: путь к `.cmd` передаётся аргументом в `/tr`,
 * поэтому кириллица в пути не зависит от кодировки файла скрипта.
 *
 * QA-CI-261: предел `schtasks /tr` — 261 символ. При длинном APPDATA
 * (CI-runner) полный путь к `.cmd` вместе с путём к лаунчеру не влезал.
 * Теперь для обёрток из того же каталога передаётся только basename, а
 * лаунчер сам приписывает `WScript.ScriptFullName` — каталог в `/tr` больше
 * не дублируется. Абсолютные пути извне WRAPPER_DIR (legacy-задачи) работают
 * как раньше.
 */
export const HIDDEN_LAUNCHER_FILENAME = "run-hidden.vbs";
export const WINDOWS_SCHTASKS_TR_LIMIT = 261;

export const HIDDEN_LAUNCHER_SCRIPT = `' agent-steward: hidden console launcher for Windows Task Scheduler
Option Explicit
Dim shell, target, quoted, code, folder
If WScript.Arguments.Count < 1 Then WScript.Quit 1
target = WScript.Arguments(0)
If InStr(target, "\\") = 0 And InStr(target, "/") = 0 Then
  folder = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\"))
  target = folder & target
End If
Set shell = CreateObject("WScript.Shell")
quoted = """" & target & """"
code = shell.Run(quoted, 0, True)
WScript.Quit code
`;

/**
 * QA-CONSOLE-1: гарантирует наличие скрытого launcher'а рядом с обёрткой.
 * Возвращает путь к `.vbs`; запись идемпотентна и не зависит от таски.
 */
export async function ensureHiddenLauncher(): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const launcherPath = path.join(WRAPPER_DIR, HIDDEN_LAUNCHER_FILENAME);
  await fs.writeFile(launcherPath, HIDDEN_LAUNCHER_SCRIPT, "ascii");
  return launcherPath;
}

/**
 * QA-CONSOLE-1: собирает значение `/tr` для `schtasks /create`.
 *
 * `schtasks` сам разбивает `/tr` на Command и Arguments, поэтому строку нельзя
 * оборачивать в внешние кавычки (иначе Command станет `wscript.exe //B...`).
 * `wscript.exe //B //Nologo` подавляет собственный UI, а `shell.Run(..., 0, True)`
 * внутри шипа скрывает консоль целевой `.cmd`-обёртки.
 *
 * QA-CI-261: если `.cmd` лежит рядом с лаунчером, в `/tr` идёт только его имя —
 * лаунчер сам резолвит каталог через `WScript.ScriptFullName`. Это убирает
 * дублирование длинного WRAPPER_DIR и укладывает `/tr` в лимит 261 символ.
 */
export function buildWindowsHiddenTaskCommand(
  command: string,
  launcherPath: string,
): string {
  // НЕ оборачиваем всю строку в кавычки: schtasks сам разбивает /tr на
  // <Command> (до первого пробела) и <Arguments> и не понимает \" внутри.
  // `wscript.exe` живёт в System32 и не требует кавычек; кавычки нужны только
  // вокруг путей-аргументов, которые могут содержать пробелы.
  const sameDir =
    path.dirname(command).toLowerCase() === path.dirname(launcherPath).toLowerCase();
  const target = sameDir ? path.basename(command) : command;
  const tr = `wscript.exe //B //Nologo "${launcherPath}" "${target}"`;
  if (tr.length > WINDOWS_SCHTASKS_TR_LIMIT) {
    throw new Error(
      `QA-CI-261: schtasks /tr exceeds ${WINDOWS_SCHTASKS_TR_LIMIT} chars (${tr.length}); ` +
        "use a shorter profile/task path or a wrapper next to the launcher",
    );
  }
  return tr;
}

export async function ensureWrapper(): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const wrapperPath = path.join(WRAPPER_DIR, WRAPPER_FILENAME);
  // BOM обязателен: Windows PowerShell 5.1 читает .ps1 без BOM как ANSI,
  // из-за чего кириллица в сообщениях Write-Log превращается в мусор.
  await fs.writeFile(wrapperPath, "\uFEFF" + WRAPPER_SCRIPT, "utf8");
  await ensureHiddenLauncher();
  return wrapperPath;
}

/**
 * Записывает промпт задачи во временный файл и возвращает его путь.
 *
 * Имя санитизируется внутри функции, а не только у вызывающей стороны:
 * defence-in-depth против path traversal, если taskName когда-либо придёт
 * из недоверенного источника (импорт, шаблон, RPC).
 */
/**
 * QA-D316-27: Windows может вернуть EBUSY/EPERM на записи файла задачи,
 * пока другой процесс (обёртка/логгер) держит его открытым. Раньше update_task
 * падал, удалял задание из ОС и не мог восстановить прежнюю версию.
 */
export async function withFileWriteRetry<T>(
  operation: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
    try {
      return await operation();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function writePromptFile(taskName: string, prompt: string): Promise<string> {
  const safety = inspectPromptSafety(prompt);
  if (!safety.safe) {
    // PL-112 предупреждает, но не блокирует: проверка смотрит только в текст
    // промпта (её обходят через qualityGate/beforeScript) и отсекает легитимные
    // задачи вроде «rm -rf node_modules». Граница разрешений — allowedTools/deniedTools.
    console.warn(
      `[agent-steward] PL-112: подозрительный промпт "${sanitizeName(taskName)}" (${safety.reasons.join("; ")}) — задача создана, проверка не блокирует`,
    );
  }
  const promptDir = path.join(PLUGIN_DIR, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `${sanitizeName(taskName)}.txt`);
  // BOM помогает Windows PowerShell 5.1 правильно прочитать кириллицу.
  // На POSIX BOM попал бы в промпт как мусорный символ — не пишем его.
  const content = process.platform === "win32" ? "\uFEFF" + prompt : prompt;
  await withFileWriteRetry(() => fs.writeFile(promptPath, content, "utf8"));
  return promptPath;
}

/**
 * Возвращает путь к lock-файлу задачи.
 *
 * Как и writePromptFile, санитизирует имя внутри: без этого значение с `../`
 * могло бы создать lock вне каталога locks.
 */
export function lockFilePath(taskName: string): string {
  return path.join(PLUGIN_DIR, "locks", `${sanitizeName(taskName)}.lock`);
}

/**
 * PL-47: извлекает список `-Files "a;b"` из PowerShell afterScript; возвращает
 * строку `a|b` для gate-integrity. Возвращает "", если afterScript не коммитит
 * через pl-commit.ps1 (тогда гейт работает по старой схеме).
 */
export function gateAllowPathsFromAfterScript(afterScript?: string): string {
  if (!afterScript) return "";
  const match = /-Files\s+"([^"]+)"/i.exec(afterScript);
  if (!match) return "";
  return match[1]
    .split(";")
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .join("|");
}

/**
 * PL-150: единый allow-список для post-flight `worktree-verify`.
 *
 * Раньше обёртка брала пути только из `-Files` afterScript; у задач без
 * afterScript (PL-140/PL-143) список был пустым, и гейт отклонял СОБСТВЕННЫЕ
 * правки агента как «защищённые пути (src) изменились с момента старта задачи».
 * Теперь в allowlist попадают объявленные SCOPE-пути, `filesCreate` и пути из
 * `gateAllowPathsFromAfterScript`. Пути вне этих трёх источников по-прежнему
 * не попадают в список и отклоняются гейтом.
 *
 * Возвращает детерминированную строку `a|b` в порядке: SCOPE → filesCreate →
 * afterScript; дубликаты отбрасываются. Пустые/отсутствующие входы дают ''.
 * Функция чистая: ни аргументы, ни окружение не изменяются.
 */
export function gateAllowPathsFromScope(
  scopePaths?: readonly string[] | null,
  filesCreate?: readonly string[] | null,
  afterScript?: string,
): string {
  // gate-integrity сравнивает относительные пути из `git status` в POSIX-форме:
  // уводим '\\' → '/', снимаем сегменты './' и ведущие/ведомые '/'.
  const normalize = (item: string): string =>
    item
      .trim()
      .replace(/\\/g, "/")
      .replace(/(^|\/)\.\//g, "$1")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .trim();

  const fromAfterScript = gateAllowPathsFromAfterScript(afterScript)
    .split("|")
    .filter(Boolean);
  const unique = new Set<string>();
  for (const item of [...(scopePaths ?? []), ...(filesCreate ?? []), ...fromAfterScript]) {
    const normalized = normalize(item);
    if (normalized) unique.add(normalized);
  }
  return [...unique].join("|");
}

/**
 * Генерирует per-task .cmd-обёртку, которую schtasks вызывает через /tr.
 * Внутри .cmd — жёстко заданный вызов run-task.ps1 с задачей, промптом,
 * таймаутом и lock-файлом. schtasks получает только один путь (в кавычках),
 * поэтому спецсимволы и кириллица в аргументах больше не ломают парсинг.
 *
 * @param sanitizedName  безопасное имя для файла (латиница, цифры, -, _)
 * @param taskName       отображаемое имя задачи в taskschd.msc (как есть, может быть кириллицей)
 * @param promptFile     абсолютный путь к файлу с промптом
 * @param timeoutSeconds таймаут в секундах
 * @param lockFile       абсолютный путь к lock-файлу
 * @param workdir        рабочая директория (опционально; по умолчанию — process.cwd())
 * @param logFile        путь к файлу лога
 * @param recorderFile   путь к record-history.js (история/метрики)
 * @param qualityGate    проверочная команда Quality Gate
 * @param model          LLM-модель для `opencode run --model` (опционально)
 * @param beforeScript   pre-flight команда (опционально)
 * @param afterScript    post-flight команда (опционально)
 * @param workspaceName  имя workspace для git-контекста в логе (опционально)
 * @param allowedTools   список разрешённых инструментов (спринт 14, опционально)
 * @param deniedTools    список запрещённых инструментов (спринт 14, опционально)
 * @param scheduleGate   гейт расписания (спринт 19): проверка cron в таймзоне
 *                       и окна запуска перед стартом PowerShell-обёртки.
 * @param envFile        env-файл workspace (спринт 21, опционально)
 * @param sessionMode    режим сессии OpenCode (спринт 24): "new" (по умолчанию,
 *                       без флагов), "reuse" (--session $SessionId), "last" (--continue)
 * @param sessionId      идентификатор сессии для режима "reuse" (спринт 24, опционально)
 */
/**
 * Hotfix 1.5.3.1: хуки и Quality Gate пишутся в отдельные .cmd-файлы.
 *
 * Раньше команда передавалась аргументом в однострочный вызов powershell.exe,
 * а кавычки внутри неё заменялись на апострофы: `echo x > "C:\Program Files\out.txt"`
 * превращался в нерабочий `echo x > 'C:\Program Files\out.txt'`. Файл снимает
 * проблему целиком — внутри .cmd можно использовать любые кавычки и пайпы.
 *
 * QA-D316-4: cmd.exe не понимает PowerShell-синтаксис — `$r = ...` даёт
 * «'$r' is not recognized», а `& ...` — «'& was unexpected at this time».
 * Поэтому PS-тело уезжает в соседний .ps1, а .cmd становится тонким шимом,
 * который дёргает powershell.exe -File. Чисто cmd-команды остаются в старом
 * формате для обратной совместимости.
 */

/** QA-D316-4: те же маркеры, что и в Invoke-HookScript внутри WRAPPER_SCRIPT. */
function isPowerShellHookBody(command: string): boolean {
  return /\$[A-Za-z_]|&\s/.test(command);
}

async function writeHookFile(
  sanitizedName: string,
  kind: "before" | "after" | "gate",
  command: string,
): Promise<string> {
  const dir = path.join(WRAPPER_DIR, "hooks");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `run-${sanitizedName}-${kind}.cmd`);
  if (isPowerShellHookBody(command)) {
    const ps1File = path.join(dir, `run-${sanitizedName}-${kind}.ps1`);
    await fs.writeFile(ps1File, command, "utf8");
    // В .cmd двойная кавычка внутри кавычек экранируется удвоением.
    const escapedPs1 = ps1File.replace(/"/g, '""');
    await fs.writeFile(
      file,
      `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${escapedPs1}" %*\r\n`,
      "utf8",
    );
  } else {
    await fs.writeFile(file, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, "utf8");
  }
  return file;
}

/**
 * PL-126: причина провала создания git worktree. Пишется в лог задачи и в
 * историю (--skip), чтобы «зависший prepared» стал понятной ошибкой.
 * ВАЖНО: без круглых скобок — эта строка попадает в `echo` внутри блока
 * `if (...)` сгенерированного .cmd, где `)` закрыл бы блок досрочно.
 */
export const WORKTREE_CREATE_FAILURE_REASON =
  "PL-126: не удалось создать git worktree, opencode не запущен, подробности в логе задачи";

/** PL-126: та же причина с именем задачи — для лога и истории. */
export function worktreeCreateFailureReason(taskName: string): string {
  const safeTask = taskName.replace(/[\r\n\0"]+/g, "").trim() || "unknown";
  return `${WORKTREE_CREATE_FAILURE_REASON} [задача: ${safeTask}]`;
}

export async function writeWrapperCmd(
  sanitizedName: string,
  taskName: string,
  promptFile: string,
  timeoutSeconds: number,
  lockFile: string,
  workdir?: string,
  logFile?: string,
  recorderFile?: string,
  qualityGate?: string,
  model?: string,
  beforeScript?: string,
  afterScript?: string,
  workspaceName?: string,
  allowedTools?: string[],
  deniedTools?: string[],
  scheduleGate?: ScheduleGateSpec & {
    gateFile: string;
    deferFile?: string;
    forceFile?: string;
    forceTtlMs?: number;
  },
  envFile?: string,
  sessionMode?: "new" | "reuse" | "last",
  sessionId?: string,
  gateTimeoutSeconds?: number,
  permissionsConfig?: string,
  policyMeta?: unknown,
  sessionFile?: string,
  /** W-1: запустить задачу в одноразовом git worktree. */
  worktree?: boolean,
  /** Путь к dist/core/worktree-run.js (обязателен при worktree=true). */
  worktreeHelperFile?: string,
  /** W-3: guard-условия перед запуском opencode. */
  guards?: TaskGuards,
  /** Путь к dist/core/guard-run.js (обязателен при guards). */
  guardHelperFile?: string,
  /** PL-47: RELATIVE-пути, которые задача вправе изменить (из -Files). */
  gateAllowPaths?: string,
  /** P-3.2: запечённый дефолт не-opencode харнесса (env AGENT_* важнее). */
  harnessDefaults?: { commandPath: string; args: string[] },
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const cmdPath = path.join(WRAPPER_DIR, `run-${sanitizedName}.cmd`);
  const ps1Path = path.join(WRAPPER_DIR, WRAPPER_FILENAME);

  // ВАЖНО: команда powershell.exe должна быть ОДНОЙ строкой.
  // Раньше -LogFile и -RecorderFile добавлялись отдельными строками .cmd,
  // из-за чего PowerShell их не получал, а cmd пытался выполнить их как
  // самостоятельные команды: логи оставались пустыми, история не писалась.
  // PL-86: рабочая директория нужна и .cmd (cd /d), и PowerShell-обёртке
  // (-Workdir): без неё квота/partial-diff не знает, где искать reports/ и git.
  // Вычисляем заранее и экранируем так же, как остальные пути-аргументы.
  const effectiveWorkdir = workdir?.trim() || process.cwd();
  const safeWorkdir = effectiveWorkdir.replace(/[\r\n\0"]+/g, "").trim();

  const psArgs: string[] = [
    `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "${ps1Path}"`,
    `-TaskName "${taskName}"`,
    `-PromptFile "${promptFile}"`,
    `-TimeoutSeconds ${timeoutSeconds}`,
    `-LockFile "${lockFile}"`,
    `-StaleLockMaxAgeMs ${STALE_LOCK_MAX_AGE_MS}`,
    `-Workdir "${safeWorkdir}"`,
  ];

  // Таймаут хуков/Quality Gate: 300 с по умолчанию, 0 — без ограничения.
  const safeGateTimeout =
    typeof gateTimeoutSeconds === "number" && Number.isFinite(gateTimeoutSeconds)
      ? Math.max(0, Math.floor(gateTimeoutSeconds))
      : 300;
  psArgs.push(`-GateTimeoutSeconds ${safeGateTimeout}`);

  // B2: ретраи сознательно не передаются в обёртку — единственный владелец
  // повторов это recorder (retryCount/retryDelay), иначе на Windows получается
  // (1+N)^2 запусков. Старые .cmd с -RetryCount продолжают работать: параметр
  // принимается, но игнорируется.

  if (logFile) {
    psArgs.push(`-LogFile "${logFile}"`);
  }

  if (recorderFile) {
    psArgs.push(`-RecorderFile "${recorderFile}"`);
  }

  if (qualityGate?.trim()) {
    // Hotfix 1.5.3.1: команда пишется в отдельный .cmd — кавычки и пайпы
    // внутри неё больше не ломают однострочный вызов powershell.exe.
    const gateFile = await writeHookFile(sanitizedName, "gate", qualityGate);
    psArgs.push(`-QualityGate "${gateFile}"`);

    // G-1.2: фиксируем входы гейта до первого запуска. Snapshot лежит в
    // PLUGIN_DIR, вне рабочей директории задачи.
    let prompt = "";
    let hook = qualityGate;
    try {
      prompt = await fs.readFile(promptFile, "utf8");
    } catch {
      // Промпт мог быть уже удалён — уникальность snapshot от этого не страдает.
    }
    try {
      hook = await fs.readFile(gateFile, "utf8");
    } catch {
      // Используем исходную команду, если прочитать хук не удалось.
    }
    const snapshotFile = createGateSnapshot(taskName, {
      gate: hook,
      prompt,
      gateTimeoutSeconds: safeGateTimeout,
    });
    psArgs.push(`-GateSnapshotFile "${snapshotFile}"`);
    const safeAllow = (gateAllowPaths ?? "").replace(/[\r\n"]+/g, "").trim();
    if (safeAllow) psArgs.push(`-GateAllowPaths "${safeAllow}"`);
  }

  if (model?.trim()) {
    const safeModel = model.replace(/[\r\n"]+/g, "").trim();
    if (safeModel) {
      const modelB64 = Buffer.from(safeModel, "utf8").toString("base64");
      psArgs.push(`-ModelB64 "${modelB64}"`);
    }
  }

  if (workspaceName?.trim()) {
    const workspaceB64 = Buffer.from(workspaceName.trim(), "utf8").toString("base64");
    psArgs.push(`-WorkspaceNameB64 "${workspaceB64}"`);
  }

  // Role-scoped tools (спринт 14): передаём списки одной строкой через запятую.
  for (const [flag, list] of [
    ["-AllowedToolsB64", allowedTools],
    ["-DeniedToolsB64", deniedTools],
  ] as const) {
    const joined = (Array.isArray(list) ? list : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(",");
    if (joined) {
      const b64 = Buffer.from(joined, "utf8").toString("base64");
      psArgs.push(`${flag} "${b64}"`);
    }
  }

  // Спринт 32: готовый JSON политики и метаданные для лога — в base64.
  // Base64 не содержит кавычек и переводов строк, поэтому безопасен для .cmd.
  if (permissionsConfig) {
    const b64 = Buffer.from(permissionsConfig, "utf8").toString("base64");
    psArgs.push(`-PermissionsB64 "${b64}"`);
  }
  if (policyMeta) {
    const b64 = Buffer.from(JSON.stringify(policyMeta), "utf8").toString("base64");
    psArgs.push(`-PolicyB64 "${b64}"`);
  }

  // Hotfix 1.5.3.1: хуки — в отдельные .cmd-файлы (см. writeHookFile).
  // Раньше кавычки заменялись на апострофы, из-за чего хуки с путями в кавычках
  // (например, "C:\Program Files\...") падали.
  for (const [flag, script, kind] of [
    ["-BeforeScript", beforeScript, "before"],
    ["-AfterScript", afterScript, "after"],
  ] as const) {
    if (script?.trim()) {
      const hookFile = await writeHookFile(sanitizedName, kind, script);
      psArgs.push(`${flag} "${hookFile}"`);
    }
  }

  // Спринт 21: env-файл workspace (пары KEY=VALUE). Значения не логируются.
  if (envFile?.trim()) {
    const safeEnvFile = envFile.replace(/[\r\n"]+/g, "").trim();
    if (safeEnvFile) {
      psArgs.push(`-EnvFile "${safeEnvFile}"`);
    }
  }

  // P-3.2: запекаем только префикс команды; --model/--session/--prompt обёртка
  // добавит сама. Base64 защищает путь с пробелами от разворачивания cmd.
  if (harnessDefaults?.commandPath) {
    const commandB64 = Buffer.from(harnessDefaults.commandPath, "utf8").toString("base64");
    psArgs.push(`-HarnessCommandB64 "${commandB64}"`);
    if (harnessDefaults.args.length > 0) {
      const argsB64 = Buffer.from(harnessDefaults.args.join(" "), "utf8").toString("base64");
      psArgs.push(`-HarnessArgsB64 "${argsB64}"`);
    }
  }

  // Спринт 24: режим сессии OpenCode. sessionId передаём только для reuse.
  const safeSessionMode =
    sessionMode === "reuse" || sessionMode === "last" ? sessionMode : "new";
  if (safeSessionMode !== "new") {
    psArgs.push(`-SessionMode "${safeSessionMode}"`);
    if (safeSessionMode === "reuse") {
      const safeSessionId = (sessionId ?? "").replace(/[\r\n"]+/g, "").trim();
      if (safeSessionId) {
        psArgs.push(`-SessionId "${safeSessionId}"`);
      }
      if (sessionFile?.trim()) {
        const safeSessionFile = sessionFile.replace(/[\r\n"]+/g, "").trim();
        if (safeSessionFile) {
          psArgs.push(`-SessionFile "${safeSessionFile}"`);
        }
      }
    }
  }

  const lines: string[] = ["@echo off", "chcp 65001 >nul"];

  // Рабочая директория: всегда переходим в неё ДО запуска PowerShell.
  // По умолчанию — текущая папка проекта (process.cwd()). Это критично для
  // MCP: opencode run подхватывает opencode.json из рабочей директории.
  lines.push(`cd /d "${effectiveWorkdir}"`);

  // Спринт 19: гейт расписания ДО PowerShell. Проверяет, что cron реально
  // сработал сейчас (для poll-режима и чужих таймзон), и при необходимости
  // переносит запуск до открытия окна notBefore..notAfter.
  // Exit 3 — «не сейчас», выходим тихо, не считая это запуском задачи.
  if (scheduleGate?.gateFile) {
    const gateArgs = [`node "${scheduleGate.gateFile}"`];
    if (scheduleGate.cron?.trim()) {
      gateArgs.push(`--cron "${scheduleGate.cron.replace(/[\r\n"]+/g, " ").trim()}"`);
    }
    if (scheduleGate.tz?.trim()) {
      gateArgs.push(`--tz "${scheduleGate.tz.trim()}"`);
    }
    if (scheduleGate.notBefore?.trim()) {
      gateArgs.push(`--not-before ${scheduleGate.notBefore.trim()}`);
    }
    if (scheduleGate.notAfter?.trim()) {
      gateArgs.push(`--not-after ${scheduleGate.notAfter.trim()}`);
    }
    // Спринт 27: дни недели и политика окна.
    if (Array.isArray(scheduleGate.days) && scheduleGate.days.length > 0) {
      gateArgs.push(`--days ${scheduleGate.days.join(",")}`);
    }
    if (scheduleGate.windowPolicy) {
      gateArgs.push(`--window-policy ${scheduleGate.windowPolicy}`);
    }
    if (scheduleGate.deferFile?.trim()) {
      gateArgs.push(`--defer-file "${scheduleGate.deferFile.trim()}"`);
    }
    // Маркер ручного запуска: run_task_now/файловый триггер/MCP-событие
    // создают его перед вызовом schtasks /run, чтобы gate не отсекал запуск
    // по cron. Без этого run_task_now был тихим no-op для poll-режима.
    if (scheduleGate.forceFile?.trim()) {
      gateArgs.push(`--force-file "${scheduleGate.forceFile.trim()}"`);
    }
    // BN-1: маркер догона пропущенных cron-тиков в poll-режиме.
    if (scheduleGate.catchupFile?.trim()) {
      gateArgs.push(`--catchup-file "${scheduleGate.catchupFile.trim()}"`);
    }
    // append к логу задачи, чтобы перенос/пропуск был виден в истории запусков
    if (logFile?.trim()) {
      gateArgs.push(`>> "${logFile.trim()}" 2>&1`);
    }
    lines.push(gateArgs.join(" "));
    lines.push("if \"%errorlevel%\"==\"3\" exit /b 0");
  }

  // PL-125/B-1.1: жёсткий бюджетный гейт ДО старта PowerShell/opencode.
  // Recorder проверяет и глобальный USD-бюджет, и tokenBudget задачи по той же
  // истории, что и ручные/MCP/RPC-входы, и пишет причину в лог + историю.
  // Exit 3 — штатный пропуск (запуск не стартует); любой иной код — fail-open.
  if (recorderFile) {
    const budgetRecorder = recorderFile.replace(/[\r\n"]+/g, "").trim();
    const budgetTask = taskName.replace(/[\r\n"]+/g, "").trim();
    const budgetArgs = [`node "${budgetRecorder}" --budget-gate "${budgetTask}"`];
    if (logFile?.trim()) {
      budgetArgs.push(`>> "${logFile.trim()}" 2>&1`);
    }
    lines.push(budgetArgs.join(" "));
    lines.push("if \"%errorlevel%\"==\"3\" exit /b 0");
  }

  // W-1 (0.0.6): одноразовый git worktree. Создаётся после гейта расписания,
  // чтобы пропущенный тик не плодил рабочие копии. Ошибка создания — fail-closed:
  // задача не должна молча работать в основном дереве.
  // PL-126: раньше путь ловился через `for /f ... in (`node ... 2>> log`)`.
  // cmd.exe считает `2>>` внутри подстановки синтаксической ошибкой и весь .cmd
  // падал ДО запуска PowerShell — в логе оставался только «Task prepared».
  // Теперь вывод помощника идёт во временные файлы, exit code проверяется явно,
  // причина пишется в лог и историю, а частично созданный worktree убирается.
  let wtHelper = "";
  let wtRepo = "";
  let wtLogRedirect = "";
  if (worktree) {
    wtHelper = (worktreeHelperFile ?? "").replace(/[\r\n"]+/g, "").trim();
    wtRepo = effectiveWorkdir.replace(/[\r\n"]+/g, "").trim();
    const safeTaskName = taskName.replace(/[\r\n"]+/g, "").trim();
    wtLogRedirect = logFile?.trim() ? `>> "${logFile.trim()}" 2>&1` : "";
    const wtResultFile = `${cmdPath}.wt-result`;
    const wtErrorFile = `${cmdPath}.wt-error`;
    const wtReason = worktreeCreateFailureReason(taskName);
    const wtReasonB64 = Buffer.from(wtReason, "utf8").toString("base64");
    const wtRecorder = (recorderFile ?? "").replace(/[\r\n"]+/g, "").trim();

    lines.push('set "AGENT_STEWARD_WORKTREE="');
    lines.push(`set "WT_RESULT=${wtResultFile}"`);
    lines.push(`set "WT_ERR=${wtErrorFile}"`);
    // Явная подкоманда create — реальный контракт worktree-run.ts.
    lines.push(
      `node "${wtHelper}" create --repo "${wtRepo}" --task "${safeTaskName}" > "%WT_RESULT%" 2> "%WT_ERR%"`,
    );
    lines.push('set "WT_CREATE_CODE=%errorlevel%"');
    // Читаем путь НЕЗАВИСИМО от кода: помощник мог создать worktree, но упасть
    // позже — тогда его надо очистить в ветке ошибки ниже.
    lines.push('if exist "%WT_RESULT%" set /p "AGENT_STEWARD_WORKTREE="< "%WT_RESULT%"');
    lines.push(
      'if "%WT_CREATE_CODE%"=="0" if not defined AGENT_STEWARD_WORKTREE set "WT_CREATE_CODE=1"',
    );
    lines.push('if not "%WT_CREATE_CODE%"=="0" (');
    lines.push(`  echo [agent-steward] ERROR: ${wtReason}, code %WT_CREATE_CODE% ${wtLogRedirect}`);
    lines.push(`  if exist "%WT_ERR%" type "%WT_ERR%" ${wtLogRedirect}`);
    lines.push("  if defined AGENT_STEWARD_WORKTREE (");
    lines.push(`    cd /d "${wtRepo}"`);
    lines.push(
      `    node "${wtHelper}" cleanup --path "%AGENT_STEWARD_WORKTREE%" --repo "${wtRepo}" ${wtLogRedirect}`,
    );
    lines.push("  )");
    if (wtRecorder) {
      lines.push(
        `  node "${wtRecorder}" --skip "${safeTaskName}" "${wtReasonB64}" ${wtLogRedirect}`,
      );
    }
    lines.push("  exit /b 1");
    lines.push(")");
    lines.push('cd /d "%AGENT_STEWARD_WORKTREE%"');
    lines.push(`set "AGENT_STEWARD_WORKTREE_REPO=${wtRepo}"`);
  }

  // W-3 (0.0.6): guard-условия до запуска opencode. Код 4 — штатный skip,
  // любой другой ненулевой код — ошибка проверки; в обоих случаях opencode
  // не запускается. Созданный worktree сразу убираем, чтобы не оставлять мусор.
  if (guards) {
    const guardHelper = (guardHelperFile ?? "").replace(/[\r\n"]+/g, "").trim();
    const guardB64 = Buffer.from(JSON.stringify(guards), "utf8").toString("base64");
    const skipTaskName = taskName.replace(/[\r\n"]+/g, "").trim();
    const skipRecorder = (recorderFile ?? "").replace(/[\r\n"]+/g, "").trim();
    const skipReasonB64 = Buffer.from("guard conditions not met", "utf8").toString("base64");
    const guardLog = logFile?.trim() ? `1>> "${logFile.trim()}" 2>&1` : "";
    const guardLogAppend = logFile?.trim() ? `>> "${logFile.trim()}" 2>&1` : "";
    const pushWorktreeCleanup = () => {
      if (!worktree) return;
      lines.push(`  cd /d "${wtRepo}"`);
      lines.push(
        `  node "${wtHelper}" cleanup --path "%AGENT_STEWARD_WORKTREE%" --repo "${wtRepo}" ${wtLogRedirect}`,
      );
    };
    lines.push(`node "${guardHelper}" --cwd "%CD%" --guards-b64 "${guardB64}" ${guardLog}`);
    lines.push('set "AGENT_STEWARD_GUARD_STATUS=%errorlevel%"');
    lines.push('if "%AGENT_STEWARD_GUARD_STATUS%"=="4" (');
    lines.push(`  echo [agent-steward] guard: run skipped ${guardLogAppend}`);
    // W-4: пишем skipped в историю/метрики. Причина фиксированная (в базе),
    // подробности guard-проверки остаются в логе задачи.
    if (skipRecorder) {
      lines.push(
        `  node "${skipRecorder}" --skip "${skipTaskName}" "${skipReasonB64}" ${guardLogAppend}`,
      );
    }
    pushWorktreeCleanup();
    lines.push("  exit /b 0");
    lines.push(")");
    lines.push('if not "%AGENT_STEWARD_GUARD_STATUS%"=="0" (');
    lines.push(
      `  echo [agent-steward] ERROR: guard failed with code %AGENT_STEWARD_GUARD_STATUS% ${guardLogAppend}`,
    );
    pushWorktreeCleanup();
    lines.push("  exit /b 1");
    lines.push(")");
  }

  lines.push(psArgs.join(" "));

  // W-2.1: удаляем одноразовый worktree после прогона при любом коде возврата.
  // Сначала выходим из него (Windows не даёт удалить текущий каталог), затем
  // возвращаем исходный код задачи — ошибка очистки не маскирует результат.
  if (worktree) {
    lines.push('set "AGENT_STEWARD_EXIT_CODE=%errorlevel%"');
    lines.push(`cd /d "${wtRepo}"`);
    lines.push(
      `node "${wtHelper}" cleanup --path "%AGENT_STEWARD_WORKTREE%" --repo "${wtRepo}" ${wtLogRedirect}`,
    );
    lines.push("exit /b %AGENT_STEWARD_EXIT_CODE%");
  }

  await fs.writeFile(cmdPath, lines.join("\r\n"), "utf8");
  return cmdPath;
}

// ---------------------------------------------------------------------------
// Маркер ручного запуска.

/** Сколько живёт маркер ручного запуска (должно совпадать с schedule-gate.ts). */
export const FORCE_FILE_TTL_MS = 2 * 60 * 1000;

/**
 * Путь к маркеру немедленного запуска задачи.
 *
 * Лежит рядом с lock-файлом и вычисляется из того же санитизированного имени,
 * поэтому обёртка (--force-file) и агент указывают на один и тот же файл.
 */
export function forceFilePath(taskName: string): string {
  return `${lockFilePath(taskName)}.force`;
}

/**
 * Создаёт маркер «запустить сейчас» перед вызовом планировщика ОС.
 *
 * Зачем: для poll-режима (нестандартный cron/чужая таймзона/окно запуска)
 * обёртка всегда прогоняет schedule-gate, и ручной запуск вне cron-окна
 * молча завершался с exit 3 — инструмент рапортовал success, но задача не
 * выполнялась. Gate поглощает свежий маркер и пропускает проверку расписания.
 *
 * Маркер самоуничтожается через FORCE_FILE_TTL_MS, если задача так и не
 * стартовала (например, отключена в планировщике), чтобы не влиять на
 * последующие плановые запуски.
 */
export async function requestImmediateRun(taskName: string): Promise<string> {
  const file = forceFilePath(taskName);
  await fs.mkdir(LOCK_DIR, { recursive: true });
  await fs.writeFile(file, new Date().toISOString(), "utf8");

  const timer = setTimeout(() => {
    void fs.unlink(file).catch(() => {
      /* маркер уже поглощён gate'ом или удалён вручную */
    });
  }, FORCE_FILE_TTL_MS);
  // Таймер не должен удерживать процесс хоста.
  if (typeof timer.unref === "function") timer.unref();

  return file;
}


/**
 * PL-114: quota errors arrive as long, ANSI-stained, sometimes double-decoded
 * lines. Turn them into one short ASCII/Cyrillic message so the dashboard and
 * the run history show "quota exhausted", not a timeout or a mojibake blob.
 */
export function normalizeQuotaReason(raw: string): string {
  const text = String(raw ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x1F]/g, " ") // PL-114: control chars become separators
    .replace(/[^\x20-\x7EА-Яа-яЁё]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = text.length > 160 ? text.slice(0, 160) + "..." : text;
  if (!short) return "Model quota error (details in task log)";
  return /free usage limit|insufficient balance/i.test(short)
    ? "Free quota exhausted: " + short
    : short;
}

/** Вход канонического вердикта записи ( PL-81 / PL-114 / PL-128 ). */
export interface WrapperRecordVerdictInput {
  /** Watchdog остановил дерево процесса. */
  timedOut: boolean;
  /** Код возврата агента/обёртки. */
  exitCode: number;
  /** Quality Gate пройден. */
  gatePassed: boolean;
  /** Гейт действительно запускался; false — гейта не было, решает exit-код. */
  gateEvaluated?: boolean;
  /** Квота/is balance — корневая причина (PL-114), имеет приоритет. */
  quotaDetected?: boolean;
  /** Код watchdog, по умолчанию 124. */
  watchdogExitCode?: number;
  /** Код завершения агента до нормализации PL-81/PL-128. */
  agentExitCode?: number;
  /** Агент убит completion/idle-сторожем (PL-124/PL-134). */
  idleCompleted?: boolean;
  /** В рабочем дереве появились изменения/новые файлы (артефакт работы). */
  workCompleted?: boolean;
}

/** Результат вердикта записи: статус, причина и итоговый exit-код обёртки. */
export interface WrapperRecordVerdict {
  status: "success" | "partial" | "timeout" | "error";
  reason: string;
  normalizedExitCode: number;
}

/**
 * PL-128: единственная спецификация вердикта записи. PowerShell-обёртка
 * использует тот же порядок правил через Get-RecordVerdict; эта чистая функция
 * позволяет тестировать вердикт детерминированно, без запуска powershell.exe.
 *
 * Порядок приоритетов: quota (PL-114) > idle без артефактов (PL-160) >
 * idle с артефактами (QA-D316-10, даже при gate=pass) > gate=pass + watchdog
 * (PL-128) > gate=pass (PL-81) > таймаут без гейта > ошибка.
 */
export function resolveWrapperRecordVerdict(
  input: WrapperRecordVerdictInput,
): WrapperRecordVerdict {
  const watchdogExitCode = input.watchdogExitCode ?? 124;
  const killedByWatchdog =
    input.timedOut ||
    (Number.isFinite(input.exitCode) && input.exitCode === watchdogExitCode);
  if (input.quotaDetected) {
    return {
      status: "error",
      reason: "PL-114: quota is the root cause",
      normalizedExitCode: input.exitCode,
    };
  }
  // P1-C / PL-160: idle без артефактов — error независимо от гейта и кода
  // возврата. PL-124 возвращает 0 после idle, поэтому agentExitCode=0 не должен
  // маскировать прерванный прогон. Watchdog-timeout сохраняет свой вердикт.
  if (
    input.idleCompleted === true &&
    input.workCompleted !== true &&
    !killedByWatchdog
  ) {
    return {
      status: "error",
      reason: "PL-160: агент завершён сторожем простоя без изменений",
      normalizedExitCode: (input.agentExitCode ?? input.exitCode) || 1,
    };
  }
  // QA-D316-5 / QA-D316-10: idle-сторож снял агента на финализации, когда
  // артефакты уже записаны. Это частичный успех независимо от гейта: PL-134
  // мог прервать агента ПОСЛЕ того, как гейт прошёл (проверял только CHANGELOG
  // и маркер), но до удаления строки из ROADMAP. Полностью пустой прогон —
  // PL-160 выше.
  if (input.idleCompleted === true && input.workCompleted === true) {
    return {
      status: "partial",
      reason: "PL-134: артефакты сохранены, финализация прервана сторожем простоя",
      normalizedExitCode: 0,
    };
  }
  if (input.gatePassed && killedByWatchdog) {
    return {
      status: "success",
      reason: "PL-128: завершено watchdog по таймауту, gate=pass",
      normalizedExitCode: 0,
    };
  }
  if (input.gatePassed) {
    return {
      status: "success",
      reason: "PL-81: quality gate passed",
      normalizedExitCode: 0,
    };
  }
  if (input.gateEvaluated === false && input.exitCode === 0) {
    return {
      status: "success",
      reason: "PL-81: успешное завершение без quality gate",
      normalizedExitCode: 0,
    };
  }
  if (killedByWatchdog) {
    return {
      status: "timeout",
      reason: "Таймаут: превышен лимит времени, quality gate не пройден",
      normalizedExitCode: input.exitCode,
    };
  }
  return {
    status: "error",
    reason: `Код возврата ${input.exitCode}`,
    normalizedExitCode: input.exitCode,
  };
}

/**
 * QA-D316-5: окно completion/idle-сторожа. Переменная окружения
 * `AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC` (по умолчанию 0, минимум 0)
 * добавляется к `idleSec`, только когда за последнее время менялись артефакты
 * задачи (git status/diff или файлы reports в рабочей папке). В этот интервал
 * счётчик простоя замораживается: генерация обёртки делает то же через
 * Get-CompletionArtifactStamp в Start-Job. Чистая функция нужна для
 * детерминированной регрессии без запуска powershell.exe.
 */
export function resolveCompletionIdleWindow(input: {
  idleSec: number;
  graceSec: number;
  artifactsChangedRecently: boolean;
}): {
  idleSec: number;
  graceSec: number;
  effectiveWindowSec: number;
  idleFrozen: boolean;
} {
  const idleSec = Number.isFinite(input.idleSec)
    ? Math.max(30, Math.floor(input.idleSec))
    : 60;
  const graceSec = Number.isFinite(input.graceSec)
    ? Math.max(0, Math.floor(input.graceSec))
    : 0;
  const appliedGrace = input.artifactsChangedRecently ? graceSec : 0;
  return {
    idleSec,
    graceSec,
    effectiveWindowSec: idleSec + appliedGrace,
    idleFrozen: appliedGrace > 0,
  };
}

/**
 * PL-118: a child powershell.exe serializes its error stream as CLIXML. When
 * that payload carries ANSI ESC (0x1B), Windows PowerShell 5.1 fails to
 * deserialize it and writes "Не удалось обработать XML ... 0x1B ...
 * недопустимым знаком" into the task log. The wrapper suppresses that at the
 * source (`2>&1` inside the child) and filters residual noise in
 * `Format-LogLine`; this pure helper mirrors the same rules so the regression
 * is deterministic and never spawns a real PowerShell.
 */
export function sanitizeChildStderr(raw: string): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^#< CLIXML\s*/gm, "")
    // CLIXML escapes control chars as _xHHHH_; decode them before stripping ANSI.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => {
      const code = parseInt(hex, 16);
      return code === 0x0a || code === 0x0d
        ? "\n"
        : code < 0x20 || code === 0x7f
          ? " "
          : String.fromCharCode(code);
    })
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\u001b/g, "")
    .replace(/<\/?(?:Objs|Obj|TN|T|MS|I\d+|S|B|DT|Nil)\b[^>]*>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/Не удалось обработать XML|Failed to process XML|недопустимым знаком|is an invalid character/i.test(
          line,
        ),
    )
    .join("\n");
}
