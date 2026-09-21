$AppName = "MLMVPN"
$DistDir = "dist\portable-build"
$AppDir = "$DistDir\resources\app"

Write-Host "Cleaning up old build..."
Remove-Item -Path $DistDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "MLMVPN_Portable.zip" -Force -ErrorAction SilentlyContinue

Write-Host "Copying Electron binaries..."
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Copy-Item -Path "node_modules\electron\dist\*" -Destination $DistDir -Recurse -Force

Write-Host "Renaming electron.exe to MLM VPN.exe..."
Rename-Item -Path "$DistDir\electron.exe" -NewName "MLM VPN.exe" -ErrorAction SilentlyContinue

Write-Host "Copying app source code..."
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

$FilesToCopy = @(
    "server.js",
    "ip-provider.js",
    "scanner.js",
    "sni-manager.js",
    "xray-manager.js",
    "main.js",
    "package.json"
)

foreach ($file in $FilesToCopy) {
    Copy-Item -Path $file -Destination $AppDir -Force
}

Copy-Item -Path "public" -Destination $AppDir -Recurse -Force
Copy-Item -Path "core" -Destination $AppDir -Recurse -Force
Copy-Item -Path "node_modules" -Destination $AppDir -Recurse -Force

Write-Host "Creating zip file MLMVPN_Portable.zip..."
Compress-Archive -Path "$DistDir\*" -DestinationPath "MLMVPN_Portable.zip" -Force

Write-Host "✅ Done! You can find your app in MLMVPN_Portable.zip and dist\portable-build"
