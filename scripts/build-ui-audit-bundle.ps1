$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutDir      = Join-Path $ProjectRoot "evaluation_bundles\ui_audit_context"

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

Write-Host "Building UI Audit Context Bundle in $OutDir..." -ForegroundColor Cyan

# -------------------------------------------------------------------------
# 1. Generate 01_UI_COMPONENT_MAP.md (.mjs & .html exports / classes)
# -------------------------------------------------------------------------
$CompMapFile = Join-Path $OutDir "01_UI_COMPONENT_MAP.md"
$CompHeader = @(
    "# UI Component Map (Auto-Generated)",
    "Map visual elements in screenshots to these live workspace files (.mjs / .html). Apply all Phase 3 edits to these paths:",
    ""
)

$UiFiles = Get-ChildItem -Path $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { 
        ($_.Extension -in '.mjs', '.html') -and 
        ($_.FullName -notmatch 'node_modules|\.git|evaluation_bundles')
    }

$CompEntries = foreach ($file in $UiFiles) {
    $relPath = $file.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/')
    $content = Get-Content $file.FullName -Raw
    
    # Extract ES exports, class declarations, and customElements.define
    $exports = [regex]::Matches($content, '(?m)(?:export\s+(?:default\s+)?(?:class|function|const)\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+)|customElements\.define\(["'']([^"'']+)["''])') |
        ForEach-Object { 
            if ($_.Groups[1].Value) { $_.Groups[1].Value } 
            elseif ($_.Groups[2].Value) { $_.Groups[2].Value } 
            else { $_.Groups[3].Value } 
        } | Select-Object -Unique

    $exportStr = if ($exports) { ($exports | Select-Object -First 4) -join ", " } else { "View/Module" }
    "- **$relPath** ($exportStr)"
}

($CompHeader + $CompEntries) | Set-Content -Path $CompMapFile -Encoding UTF8
Write-Host "  [+] Wrote 01_UI_COMPONENT_MAP.md ($($UiFiles.Count) UI/MJS modules indexed)" -ForegroundColor Green

# -------------------------------------------------------------------------
# 2. Generate 02_DESIGN_TOKENS_AND_RULES.md (Styles from .html, .mjs & Docs)
# -------------------------------------------------------------------------
$TokensFile = Join-Path $OutDir "02_DESIGN_TOKENS_AND_RULES.md"
$TokenLines = [System.Collections.Generic.List[string]]::new()
$TokenLines.Add("# Design Tokens & Layout Rules")
$TokenLines.Add("")

$fence = [string]::new([char]96, 3)

# Extract <style> blocks and CSS variables from .html and .mjs files
$StyleFiles = Get-ChildItem -Path $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { 
        ($_.Extension -in '.html', '.mjs') -and 
        ($_.FullName -notmatch 'node_modules|\.git|evaluation_bundles')
    }

$TokenLines.Add("## Embedded CSS & Variables")
$TokenLines.Add($fence + "css")
foreach ($sf in $StyleFiles) {
    $content = Get-Content $sf.FullName -Raw
    $cssMatches = [regex]::Matches($content, '(?si)<style[^>]*>(.*?)</style>')
    $varMatches = [regex]::Matches($content, '(?m)^\s*--[a-zA-Z0-9_-]+:\s*[^;]+;')

    if ($cssMatches.Count -gt 0 -or $varMatches.Count -gt 0) {
        $rel = $sf.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/')
        $TokenLines.Add("/* Source: $rel */")
        foreach ($cm in $cssMatches) {
            $TokenLines.Add($cm.Groups[1].Value.Trim())
        }
        foreach ($vm in $varMatches) {
            $TokenLines.Add($vm.Value.Trim())
        }
    }
}
$TokenLines.Add($fence)

$TokenLines | Set-Content -Path $TokensFile -Encoding UTF8
Write-Host "  [+] Wrote 02_DESIGN_TOKENS_AND_RULES.md" -ForegroundColor Green

# -------------------------------------------------------------------------
# 3. Generate 03_TELEMETRY_DATA_CONTRACT.md (Schemas from .mjs, .py, .json)
# -------------------------------------------------------------------------
$ContractFile = Join-Path $OutDir "03_TELEMETRY_DATA_CONTRACT.md"
$ContractLines = [System.Collections.Generic.List[string]]::new()
$ContractLines.Add("# Telemetry Data Contracts & State Models")
$ContractLines.Add("")

# Extract JSDoc typedefs, schema objects, or state models from .mjs and .py
$ModelFiles = Get-ChildItem -Path $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { 
        ($_.Extension -in '.mjs', '.py') -and 
        ($_.FullName -notmatch 'node_modules|\.git|evaluation_bundles|test')
    }

$ExtractRegex = '(?ms)(?:/\*\*.*?\*/|class\s+[A-Za-z0-9_]+(?:\([^\)]*\))?:|const\s+[A-Z0-9_]+_SCHEMA\s*=\s*\{.*?\})'

foreach ($mf in $ModelFiles) {
    $raw = Get-Content $mf.FullName -Raw
    $matches = [regex]::Matches($raw, $ExtractRegex) | 
        Where-Object { $_.Value -match 'telemetry|horizon|layer|capacity|state|schema|event|metric' }

    if ($matches.Count -gt 0) {
        $rel = $mf.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/')
        $lang = if ($mf.Extension -eq '.py') { "python" } else { "javascript" }
        $ContractLines.Add("## Source: $rel")
        $ContractLines.Add($fence + $lang)
        foreach ($m in $matches) {
            $ContractLines.Add($m.Value.Trim())
            $ContractLines.Add("")
        }
        $ContractLines.Add($fence)
        $ContractLines.Add("")
    }
}

$ContractLines | Set-Content -Path $ContractFile -Encoding UTF8
Write-Host "  [+] Wrote 03_TELEMETRY_DATA_CONTRACT.md" -ForegroundColor Green

# -------------------------------------------------------------------------
# 4. Seed 04_KNOWN_ANTI_PATTERNS.md
# -------------------------------------------------------------------------
$AntiPatternFile = Join-Path $OutDir "04_KNOWN_ANTI_PATTERNS.md"
if (-not (Test-Path $AntiPatternFile)) {
    @(
        "# Known UI Anti-Patterns & Regression Guardrails",
        "",
        "Reject any UI state or proposed fix that violates these rules:",
        "1. Maximize Data-Ink Ratio: No decorative card wrappers, oversized padding, or multi-line headers where a single compact bar suffices.",
        "2. Chrono-Attention Horizon: Keep primary capacity/horizon bar charts and Layer 1-6 telemetry visible at a glance without requiring hover states or modal clicks.",
        "3. Compact Controls: Enforce compact button dimensions; never introduce large pill buttons or redundant confirmation dialogs that clash with high-density HUD layouts.",
        "4. Contrast & Legibility: Do not use low-contrast muted grays for active telemetry numbers, root-cause diagnostics, or status badges."
    ) | Set-Content -Path $AntiPatternFile -Encoding UTF8
    Write-Host "  [+] Created seed 04_KNOWN_ANTI_PATTERNS.md" -ForegroundColor Green
} else {
    Write-Host "  [=] Kept existing 04_KNOWN_ANTI_PATTERNS.md" -ForegroundColor Yellow
}

Write-Host "`nBundle ready at: $OutDir" -ForegroundColor Cyan
