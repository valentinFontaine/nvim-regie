# Crée le raccourci Bureau « nvim-regie » (lancé à la main ; aucun démarrage automatique).
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'nvim-regie.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $node
$s.Arguments = 'src\server.js'
$s.WorkingDirectory = $repo
$s.WindowStyle = 1
$s.Description = 'nvim-regie : serveur local (fermer la fenêtre arrête tout)'
$s.Save()
Write-Host "Raccourci créé : $lnk"
