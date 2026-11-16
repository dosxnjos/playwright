# Grava o token novo da extensao Playwright de um perfil do Chrome no Doppler (harness/prd,
# PLAYWRIGHT_MCP_EXTENSION_TOKEN_<VARIANTE>) e no ~/.claude.json (PLAYWRIGHT_MCP_EXTENSION_TOKEN__<variante>).
# O token e digitado so nesta janela: nao passa pelo chat, nao aparece na tela e nao fica em arquivo.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File C:\Dev\playwright\scripts\gravar-token-perfil.ps1 -Variante jacira
#   perfil novo: ... -Variante <nome> -Perfil "Profile 8"   (pasta do perfil em chrome://version)
# Variantes de hoje: padrao (Profile 13), gabriel_pessoal (Default), jacira (Profile 6), andressa (Profile 7),
# dosxnjos (Profile 14), sofia (Profile 3).
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]*$')][string]$Variante,
  [string]$Perfil = ''
)

$seguro = Read-Host "Cole a linha PLAYWRIGHT_MCP_EXTENSION_TOKEN=... (ou so o token) da extensao do perfil '$Variante' e aperte Enter" -AsSecureString
$env:PW_TOKEN_NOVO = [System.Net.NetworkCredential]::new('', $seguro).Password
try {
  $helper = Join-Path $PSScriptRoot 'gravar-token-perfil.cjs'
  if ($Perfil) { node $helper $Variante $Perfil } else { node $helper $Variante }
  $codigo = $LASTEXITCODE
} finally {
  Remove-Item Env:PW_TOKEN_NOVO -ErrorAction SilentlyContinue
  Remove-Variable seguro -ErrorAction SilentlyContinue
}
if ($codigo -eq 0) {
  Write-Host 'Pronto. Pode fechar esta janela.' -ForegroundColor Green
} else {
  Write-Host 'Nao gravou (mensagem acima). Avise no chat, sem colar o token.' -ForegroundColor Red
}
