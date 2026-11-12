<#
  Descarga los recursos 3D externos opcionales del juego (todos CC0) a la carpeta assets/ y genera
  assets/manifest.json (lo que carga el juego) y assets/CREDITS.txt (autoria y licencias).

    powershell -ExecutionPolicy Bypass -File tools\download-assets.ps1

  - Modelos de Poly Haven (https://polyhaven.com/license, CC0): version glTF con texturas de 1K. La lista de
    archivos de cada modelo (.gltf, .bin y texturas) se pide a la API publica de Poly Haven al descargar.
  - Materiales PBR de ambientCG (https://docs.ambientcg.com/license/, CC0): ZIP de 1K en JPG. Solo se guardan
    los mapas que usa el juego, con nombres fijos (color.jpg, normal.jpg, roughness.jpg, ao.jpg, metalness.jpg).

  Basta con ejecutarlo una vez (con -Force vuelve a descargarlo todo). Necesita Internet; despues el juego
  funciona sin conexion. Si no se ejecuta, el juego usa sus modelos procedurales.
  (Los textos van sin tildes para que Windows PowerShell 5.1 los muestre bien sin importar la codificacion.)
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest va mucho mas rapido sin la barra de progreso
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$agent = 'ParcelEmpire-AssetDownloader/1.0 (juego local; recursos CC0)'

# Deben coincidir con js/config/assets.js
$models = @('metal_office_desk', 'plastic_crate_02', 'industrial_pastic_container', 'utility_box_01')
$textures = @('Asphalt025C', 'Concrete034', 'RoofingTiles007', 'CorrugatedSteel005', 'Cardboard004', 'WoodFloor043')

$manifest = [ordered]@{ generated = (Get-Date).ToString('s'); models = [ordered]@{}; textures = [ordered]@{} }
$credits = New-Object System.Collections.Generic.List[string]
$credits.Add('Recursos 3D externos de Parcel Empire (descargados con tools/download-assets.ps1)')
$credits.Add('Todos son CC0 1.0 (dominio publico): se pueden usar, modificar y redistribuir, tambien en proyectos comerciales.')
$credits.Add('')

# Descarga a un archivo temporal y lo renombra al terminar: una descarga cortada no se da por buena.
# Si ya existe con el tamano esperado (o sin tamano conocido) y no se pide -Force, se reutiliza.
function Get-File([string]$url, [string]$path, [long]$size = 0) {
  if ((Test-Path $path) -and -not $Force) {
    if ($size -le 0 -or (Get-Item $path).Length -eq $size) { return }
  }
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $part = "$path.part"
  Invoke-WebRequest -Uri $url -OutFile $part -UserAgent $agent -UseBasicParsing
  if ($size -gt 0 -and (Get-Item $part).Length -ne $size) {
    Remove-Item -Force $part
    throw "Tamano inesperado al descargar $url"
  }
  Move-Item -Force $part $path
}

# ------------------------------------------------------------ Poly Haven ----
foreach ($id in $models) {
  try {
    Write-Host "Poly Haven: $id" -ForegroundColor Cyan
    $files = Invoke-RestMethod -Uri "https://api.polyhaven.com/files/$id" -UserAgent $agent
    $gltf = $files.gltf.'1k'.gltf
    if (-not $gltf) { throw 'No hay version glTF de 1K' }
    $dir = Join-Path $assets "models\$id"
    $name = [System.IO.Path]::GetFileName(([Uri]$gltf.url).AbsolutePath)
    Get-File $gltf.url (Join-Path $dir $name) $gltf.size
    # Archivos que referencia el .gltf, con su ruta relativa (el .bin y textures/*.jpg)
    foreach ($entry in $gltf.include.PSObject.Properties) {
      $relative = $entry.Name -replace '/', '\'
      if ($relative -match '\.\.' -or [System.IO.Path]::IsPathRooted($relative)) { throw "Ruta no valida: $relative" }
      Get-File $entry.Value.url (Join-Path $dir $relative) $entry.Value.size
    }
    $manifest.models[$id] = "models/$id/$name"
    $info = Invoke-RestMethod -Uri "https://api.polyhaven.com/info/$id" -UserAgent $agent
    $authors = ($info.authors.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '
    $credits.Add("Modelo '$($info.name)' ($id) - autor: $authors - Poly Haven, CC0 - https://polyhaven.com/a/$id")
  } catch {
    Write-Host "  No se pudo descargar ${id}: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# ------------------------------------------------------------ ambientCG ----
$wanted = [ordered]@{ '_Color' = 'color'; '_NormalGL' = 'normal'; '_Roughness' = 'roughness'; '_AmbientOcclusion' = 'ao'; '_Metalness' = 'metalness' }
foreach ($id in $textures) {
  try {
    Write-Host "ambientCG: $id" -ForegroundColor Cyan
    $dir = Join-Path $assets "textures\$id"
    $present = @()
    if ((Test-Path (Join-Path $dir 'normal.jpg')) -and -not $Force) {
      $present = @(Get-ChildItem $dir -Filter '*.jpg' | ForEach-Object { $_.BaseName })
    } else {
      $zip = Join-Path $env:TEMP "$id`_1K-JPG.zip"
      $tmp = Join-Path $env:TEMP "$id`_1K-JPG"
      Get-File "https://ambientcg.com/get?file=$id`_1K-JPG.zip" $zip
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      foreach ($suffix in $wanted.Keys) {
        $file = Get-ChildItem $tmp -Recurse -Filter "*$suffix.jpg" | Select-Object -First 1
        if ($file) {
          Copy-Item $file.FullName (Join-Path $dir "$($wanted[$suffix]).jpg") -Force
          $present += $wanted[$suffix]
        }
      }
      Remove-Item -Recurse -Force $tmp
      Remove-Item -Force $zip
    }
    if ($present.Count -gt 0) {
      $manifest.textures[$id] = @($present)
      $credits.Add("Material $id - ambientCG.com, CC0 - https://ambientcg.com/a/$id")
    } else {
      Write-Host "  El ZIP de $id no tenia los mapas esperados" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  No se pudo descargar ${id}: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Path $assets -Force | Out-Null }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $assets 'manifest.json') -Encoding UTF8
$credits | Set-Content -Path (Join-Path $assets 'CREDITS.txt') -Encoding UTF8

$size = (Get-ChildItem $assets -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ''
Write-Host ("Listo: {0} modelos y {1} materiales ({2:N1} MB) en {3}" -f $manifest.models.Count, $manifest.textures.Count, $size, $assets) -ForegroundColor Green
Write-Host 'Recarga el juego (iniciar.bat) para verlos. La consola del navegador (F12) indica que se ha cargado.'
