# =============================================================================
# repair-ghost-plugin-deps.ps1
# 修复 dsh-config-manager 导入后插件全部安装失败的幽灵依赖状态。
#
# 背景：备份里的 dsh-memory-evolve / dsh-notification 是 GitHub 来源依赖
#   （github:csyangwen/dsh-memory-evolve、github:omdsh-dev/dsh-notification）。
#   旧版 config-manager 导入时只按裸包名执行 `dsh plugin add <name>`，pnpm 在
#   npm registry 查不到 → fetch-404，并把幽灵依赖行残留在 profile package.json，
#   导致 pnpm 拒绝之后所有安装（其余 7 个插件连带失败）。
#
# 用法：在【目标机】以普通用户身份运行本脚本（Windows PowerShell 5.1+ 均可）。
#   本机来源的 pnpm-workspace.yaml（allowBuilds 等）见仓库 Docs/ 说明。
#   运行后重启 DSH 生效。
# =============================================================================
$ErrorActionPreference = 'Stop'

$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
if (-not (Test-Path $profile)) {
    Write-Error "未找到 profile 目录: $profile（请确认目标机 DSH 的 web profile 路径）"
}

$pkgJson = Join-Path $profile 'package.json'
$m = Get-Content $pkgJson -Raw | ConvertFrom-Json

# 1) 移除幽灵依赖（registry 上不存在的裸名条目，会拖垮所有 pnpm 操作）
$ghost = @('dsh-memory-evolve', 'dsh-notification')
$changed = $false
if ($null -ne $m.dependencies) {
    foreach ($g in $ghost) {
        if ($m.dependencies.PSObject.Properties.Name -contains $g) {
            $m.dependencies.PSObject.Properties.Remove($g)
            Write-Host "已从 dependencies 移除幽灵依赖: $g"
            $changed = $true
        }
    }
}
# 同时清掉 bundles 里的残留（重装后会由 dsh reconcile 重新维护）
if ($null -ne $m.dsh -and $null -ne $m.dsh.profile -and $null -ne $m.dsh.profile.bundles) {
    $kept = @($m.dsh.profile.bundles | Where-Object { $_ -notin $ghost })
    if ($kept.Count -ne $m.dsh.profile.bundles.Count) {
        $m.dsh.profile.bundles = $kept
        Write-Host "已从 dsh.profile.bundles 移除幽灵条目"
        $changed = $true
    }
}
if ($changed) {
    $m | ConvertTo-Json -Depth 20 | Set-Content $pkgJson -Encoding utf8
    Write-Host "package.json 已清理，幽灵依赖已删除"
} else {
    Write-Host "package.json 中未发现幽灵依赖（可能已被手动清理）"
}

# 2) 确保 pnpm-workspace.yaml 含插件构建白名单（git/原生依赖插件安装需要；
#    按来源机实际配置合并，缺失才追加，绝不覆盖已有内容）
$wsYaml = Join-Path $profile 'pnpm-workspace.yaml'
$wsText = if (Test-Path $wsYaml) { Get-Content $wsYaml -Raw } else { "packages:`n  - .`n" }
if ($wsText -notmatch 'allowBuilds:') {
    $wsText += @'

allowBuilds:
  cloudflared: true
  cpu-features: true
  node-pty: true
  protobufjs: true
  ssh2: true
'@
    Set-Content $wsYaml $wsText -Encoding utf8
    Write-Host "pnpm-workspace.yaml 已补 allowBuilds（cloudflared/cpu-features/node-pty/protobufjs/ssh2）"
} else {
    Write-Host "pnpm-workspace.yaml 已有 allowBuilds，跳过"
}

# 3) 重装 7 个 registry 插件（此前因幽灵依赖连带失败）
$registryPlugins = @(
    '@linxin666/dsh-web-ui-all',
    '@liustack/modlens',
    '@nanmicoder/dsh-agent-teams',
    'dsh-better-sidebar',
    'dsh-config-manager',
    'dsh-find-plugin',
    'dshmarket'
)
foreach ($p in $registryPlugins) {
    Write-Host "== 安装 $p =="
    dsh plugin --profile web add $p
    if ($LASTEXITCODE -ne 0) { Write-Warning "$p 安装失败（exit $LASTEXITCODE），继续下一个" }
}

# 4) 两个 GitHub 来源插件按正确 spec 安装
$gitSpecs = @(
    'github:csyangwen/dsh-memory-evolve',
    'github:omdsh-dev/dsh-notification'
)
foreach ($spec in $gitSpecs) {
    Write-Host "== 安装 $spec =="
    dsh plugin --profile web add $spec
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$spec 安装失败（exit $LASTEXITCODE）。若 dsh CLI 不接受 github: spec，"
        Write-Warning "请手动把 package.json 中该行写为 `"$spec`" 后重跑本脚本第 3 步。"
    }
}

Write-Host ''
Write-Host '修复完成。请重启 DSH（插件/MCP 变更重启后生效）。'
Write-Host '验证：dsh plugin --profile web list（或重启后侧边栏确认 9 个插件已加载）'
