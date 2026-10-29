<#
  Toranit Agent - RMM agent for computers you are authorized to manage.
  Installs openly as a Windows Scheduled Task named "ToranitAgent" (visible in Task Scheduler),
  reports status to your Toranit server, and runs commands an admin queues there.
  Every command is logged on the server. This agent does not hide itself and does not touch antivirus.

  Install (run in an elevated PowerShell on the managed PC):
    $k='PUT-ENROLL-KEY'; iwr "https://YOURSERVER/api/agent/install.ps1?key=$k" -OutFile "$env:TEMP\ta.ps1"; & "$env:TEMP\ta.ps1"
  Uninstall:
    & "$env:ProgramData\ToranitAgent\toranit-agent.ps1" -Uninstall
#>
param([switch]$Run, [switch]$Uninstall, [switch]$User, [switch]$Diag, [switch]$VncDiag, [switch]$NoArp)

$Server = '@@SERVER@@'
$Key    = '@@KEY@@'
$Ver    = '1.30.2'
$Dir    = Join-Path $env:ProgramData 'ToranitAgent'
$State  = Join-Path $Dir 'state.json'
$VncFile = Join-Path $Dir 'vnc.json'
$Task   = 'ToranitAgent'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Save-State($o){ $o | ConvertTo-Json -Compress | Set-Content -LiteralPath $State -Encoding UTF8 }
function Load-State { if(Test-Path $State){ try{ return Get-Content -LiteralPath $State -Raw | ConvertFrom-Json }catch{} } return $null }
function MachineId { try{ (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid }catch{ $env:COMPUTERNAME } }

function Install-Agent {
  # stop any previous agent instance so the freshly-registered task (MultipleInstances=IgnoreNew) can start the new code
  try { Unregister-ScheduledTask -TaskName ($Task + 'User') -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  try { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*toranit-agent.ps1*-Run*' -or $_.CommandLine -like '*toranit-agent.ps1*-User*' } | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # keep an on-disk copy of this script so the scheduled task runs it
  try { Invoke-WebRequest "$Server/api/agent/install.ps1?key=$Key" -OutFile (Join-Path $Dir 'toranit-agent.ps1') -UseBasicParsing }
  catch { Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Dir 'toranit-agent.ps1') -Force -ErrorAction SilentlyContinue }
  $file = Join-Path $Dir 'toranit-agent.ps1'
  $act  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run' -f $file)
  $t1   = New-ScheduledTaskTrigger -AtStartup
  # repeats every minute as a watchdog AND to relaunch quickly after a self-update exit
  $t2   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $Task -Action $act -Trigger $t1,$t2 -Principal $prin -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName $Task
  # second task: runs in the logged-on user's session for screen view + input control (not SYSTEM)
  $uact = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -User' -f $file)
  $uprin = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
  $uset = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $ut1  = New-ScheduledTaskTrigger -AtLogOn
  $ut2  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName ($Task + 'User') -Action $uact -Trigger $ut1,$ut2 -Principal $uprin -Settings $uset -Force | Out-Null
  try { Start-ScheduledTask -TaskName ($Task + 'User') } catch {}
  # register in Add/Remove Programs so it can be uninstalled from Settings > Apps
  # (skipped with -NoArp: when installed by the Toranit setup.exe, that installer owns the Add/Remove entry)
  if(-not $NoArp){ try {
    $uk = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ToranitAgent'
    New-Item -Path $uk -Force | Out-Null
    Set-ItemProperty $uk -Name DisplayName -Value 'Toranit Remote Agent'
    Set-ItemProperty $uk -Name DisplayVersion -Value '1.0'
    Set-ItemProperty $uk -Name Publisher -Value 'Toranit'
    Set-ItemProperty $uk -Name DisplayIcon -Value $file
    Set-ItemProperty $uk -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $file + '" -Uninstall')
    Set-ItemProperty $uk -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty $uk -Name NoRepair -Value 1 -Type DWord
  } catch {} }
  Write-Host "Toranit Agent installed and started (tasks '$Task' and '${Task}User')." -ForegroundColor Green
}
function Uninstall-Agent {
  Unregister-ScheduledTask -TaskName ($Task + 'User') -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  # stop any running agent processes (so it cannot re-enroll and recreate its files), except this uninstaller
  try { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*toranit-agent*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
  Remove-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ToranitAgent' -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Toranit Agent removed." -ForegroundColor Yellow
}
# ---- self-update: fetch the latest script from the server and relaunch (no manual reinstall) ----
function Self-Update($token,$latest){
  if(-not $latest -or $latest -eq $Ver){ return }
  $ulog = Join-Path $Dir 'update.log'
  try{
    $tmp = Join-Path $Dir 'toranit-agent.new.ps1'
    Invoke-WebRequest ($Server+'/api/agent/self.ps1') -Headers @{Authorization="Bearer $token"} -OutFile $tmp -UseBasicParsing -TimeoutSec 60
    $txt = Get-Content $tmp -Raw
    if($txt -and $txt.Length -gt 5000 -and $txt -match 'Toranit Agent'){
      Copy-Item -LiteralPath $tmp -Destination (Join-Path $Dir 'toranit-agent.ps1') -Force
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      try{ Add-Content $ulog ((Get-Date -Format s)+" updated $Ver -> $latest; restarting") }catch{}
      # exit; the scheduled task's repetition trigger relaunches us running the new script
      exit
    } else {
      try{ Add-Content $ulog ((Get-Date -Format s)+" downloaded script looked invalid (len=$($txt.Length))") }catch{}
    }
  }catch{ try{ Add-Content $ulog ((Get-Date -Format s)+" update failed: "+$_.Exception.Message) }catch{} }
}

function Call($path, $body, $token){
  $h = @{}; if($token){ $h['Authorization'] = "Bearer $token" }
  $json = if($body){ $body | ConvertTo-Json -Depth 6 -Compress } else { '{}' }
  return Invoke-RestMethod -Uri ($Server + $path) -Method Post -Headers $h -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 60
}
function Enroll {
  $body = @{ key=$Key; hostname=$env:COMPUTERNAME; os=((Get-CimInstance Win32_OperatingSystem).Caption); machineId=(MachineId); agentVer=$Ver }
  $cf = Join-Path $Dir 'consent.json'
  if(Test-Path $cf){ try{ $body.consent = (Get-Content $cf -Raw | ConvertFrom-Json) }catch{} }
  $r = Call '/api/agent/enroll' $body
  Save-State @{ deviceId=$r.deviceId; token=$r.token }
  return $r.token
}
function Get-Metrics {
  $os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem
  $cpu=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
  $c=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $disks=@(); foreach($x in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")){ $disks+=@{ drive=$x.DeviceID; free=[math]::Round($x.FreeSpace/1073741824,1); total=[math]::Round($x.Size/1073741824,1) } }
  return @{
    host=$env:COMPUTERNAME; os=("{0} {1}" -f $os.Caption,$os.Version);
    cpu=[int]$cpu;
    memUsed=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1048576,1);
    memTotal=[math]::Round($os.TotalVisibleMemorySize/1048576,1);
    diskFree=[math]::Round($c.FreeSpace/1073741824,1);
    diskTotal=[math]::Round($c.Size/1073741824,1);
    disks=$disks;
    uptimeMin=[int]((Get-Date)-$os.LastBootUpTime).TotalMinutes;
    user=$cs.UserName
  }
}
function Get-Software {
  $keys='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } |
    Select-Object @{n='n';e={$_.DisplayName}},@{n='v';e={"$($_.DisplayVersion)"}},@{n='p';e={"$($_.Publisher)"}} |
    Sort-Object n -Unique
}
function Get-PendingUpdates {
  try{
    $s=New-Object -ComObject Microsoft.Update.Session
    $r=$s.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
    $titles=@(); foreach($u in $r.Updates){ $titles+=$u.Title }
    return @{ count=$r.Updates.Count; titles=$titles }
  }catch{ return @{ count=-1; titles=@("Could not check updates: $($_.Exception.Message)") } }
}
function Run-Shell($cmd,$shell,$timeout){
  $sb = if($shell -eq 'cmd'){ { param($c) & cmd.exe /c $c 2>&1 | Out-String } } else { { param($c) powershell -NoProfile -ExecutionPolicy Bypass -Command $c 2>&1 | Out-String } }
  $job=Start-Job -ScriptBlock $sb -ArgumentList $cmd
  if(Wait-Job $job -Timeout $timeout){ $out=[string](Receive-Job $job 2>&1 | Out-String); $st='done'; $ex=0 }
  else { Stop-Job $job -ErrorAction SilentlyContinue; $out="[command timed out after $timeout seconds and was cancelled]"; $st='error'; $ex=124 }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return @{ output=[string]$out; status=$st; exit=$ex }
}

# ---- user-session helper: screen view + input control (runs as the logged-on user, not SYSTEM) ----
function Wait-Token { while($true){ $s=Load-State; if($s -and $s.token){ return $s.token }; Start-Sleep -Seconds 5 } }
function Get-Screen {
  $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; $script:VS=$vs
  $bmp=New-Object System.Drawing.Bitmap $vs.Width,$vs.Height
  $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($vs.X,$vs.Y,0,0,$vs.Size); $g.Dispose()
  $maxw=1366.0; $scale=[Math]::Min(1.0,$maxw/$vs.Width)
  if($scale -lt 1){ $w=[int]($vs.Width*$scale); $h=[int]($vs.Height*$scale); $sb=New-Object System.Drawing.Bitmap $w,$h; $sg=[System.Drawing.Graphics]::FromImage($sb); $sg.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear; $sg.DrawImage($bmp,0,0,$w,$h); $sg.Dispose(); $bmp.Dispose(); $bmp=$sb }
  $ms=New-Object System.IO.MemoryStream
  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ep=New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),([int64]45)
  $bmp.Save($ms,$enc,$ep); $bmp.Dispose()
  return $ms.ToArray()
}
function Send-Frame($token,$bytes){ Invoke-WebRequest -Uri ($Server+'/api/agent/screen') -Method Post -Headers @{Authorization="Bearer $token"} -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 20 -UseBasicParsing | Out-Null }
function Escape-Keys($s){ $o=''; foreach($c in $s.ToCharArray()){ if('+^%~(){}[]'.IndexOf($c) -ge 0){ $o+='{'+$c+'}' } else { $o+=$c } }; return $o }
function Map-Key($k){ switch($k){ 'Enter'{'{ENTER}'} 'Backspace'{'{BS}'} 'Tab'{'{TAB}'} 'Escape'{'{ESC}'} 'Delete'{'{DEL}'} 'ArrowUp'{'{UP}'} 'ArrowDown'{'{DOWN}'} 'ArrowLeft'{'{LEFT}'} 'ArrowRight'{'{RIGHT}'} 'Home'{'{HOME}'} 'End'{'{END}'} 'PageUp'{'{PGUP}'} 'PageDown'{'{PGDN}'} default{''} } }
function Inject($ev){
  $vs=$script:VS; if(-not $vs){ $vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; $script:VS=$vs }
  $ax=0; $ay=0
  if($ev.x -ne $null){ $ax=[int]($vs.X + [double]$ev.x*$vs.Width); $ay=[int]($vs.Y + [double]$ev.y*$vs.Height) }
  switch($ev.t){
    'move'  { [RI]::SetCursorPos($ax,$ay) | Out-Null }
    'click' { [RI]::SetCursorPos($ax,$ay)|Out-Null; if($ev.btn -eq 'right'){ [RI]::mouse_event(0x08,0,0,0,[UIntPtr]::Zero); [RI]::mouse_event(0x10,0,0,0,[UIntPtr]::Zero) } else { [RI]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero); [RI]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero) } }
    'dbl'   { [RI]::SetCursorPos($ax,$ay)|Out-Null; foreach($i in 1..2){ [RI]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero); [RI]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero) } }
    'down'  { [RI]::SetCursorPos($ax,$ay)|Out-Null; if($ev.btn -eq 'right'){ [RI]::mouse_event(0x08,0,0,0,[UIntPtr]::Zero) } else { [RI]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero) } }
    'up'    { if($ev.btn -eq 'right'){ [RI]::mouse_event(0x10,0,0,0,[UIntPtr]::Zero) } else { [RI]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero) } }
    'scroll'{ [RI]::mouse_event(0x0800,0,0,([int]$ev.d*120),[UIntPtr]::Zero) }
    'text'  { [System.Windows.Forms.SendKeys]::SendWait((Escape-Keys ([string]$ev.text))) }
    'key'   { $k=Map-Key ([string]$ev.key); if($k){ [System.Windows.Forms.SendKeys]::SendWait($k) } }
  }
}
function Run-UserHelper {
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  Add-Type @"
using System;using System.Runtime.InteropServices;
public class RI {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,int dwData,UIntPtr dwExtraInfo);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd,int nIndex);
 [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd,int nIndex,int dwNewLong);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd,IntPtr hWndInsertAfter,int X,int Y,int cx,int cy,uint uFlags);
}
"@
  # on-screen indicator shown on the managed PC while a remote session is active
  $bTxt=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('16nXnNeZ15jXlCDXnteo15fXldenINek16LXmdec15QgICAgIFRvcmFuaXQ='))
  $banner=New-Object System.Windows.Forms.Form
  $banner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None; $banner.ShowInTaskbar=$false; $banner.TopMost=$true
  $banner.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual
  $banner.BackColor=[System.Drawing.Color]::FromArgb(200,45,35)
  $lab=New-Object System.Windows.Forms.Label; $lab.Dock=[System.Windows.Forms.DockStyle]::Fill; $lab.TextAlign=[System.Drawing.ContentAlignment]::MiddleCenter
  $lab.ForeColor=[System.Drawing.Color]::White; $lab.Font=New-Object System.Drawing.Font('Segoe UI',10,[System.Drawing.FontStyle]::Bold); $lab.Text=$bTxt
  $banner.Controls.Add($lab)
  $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $banner.Size=New-Object System.Drawing.Size(360,32)
  $banner.Location=New-Object System.Drawing.Point(([int]($wa.X+($wa.Width-360)/2)),($wa.Y+6))
  $bh=$banner.Handle
  $ex=[RI]::GetWindowLong($bh,-20); [RI]::SetWindowLong($bh,-20,($ex -bor 0x20 -bor 0x80 -bor 0x08000000)) | Out-Null  # TRANSPARENT|TOOLWINDOW|NOACTIVATE
  $shown=$false
  $LogDir=Join-Path $env:LOCALAPPDATA 'ToranitAgent'
  function ULog($m){ try{ New-Item -ItemType Directory -Force $LogDir|Out-Null; Add-Content (Join-Path $LogDir 'user.log') ((Get-Date -Format s)+' '+$m) }catch{} }
  ULog 'user-helper started'
  $token=Wait-Token
  while($true){
    try{
      $r=Call '/api/agent/remote' @{} $token
      if($r.agentVer -and $r.agentVer -ne $Ver){ ULog ("version changed $Ver -> "+$r.agentVer+"; exiting to relaunch"); exit }
      if($r.active){
        if(-not $shown){ [RI]::ShowWindow($bh,8) | Out-Null; $shown=$true }   # SW_SHOWNA
        [RI]::SetWindowPos($bh,[IntPtr](-1),0,0,0,0,0x13) | Out-Null           # HWND_TOPMOST, NOSIZE|NOMOVE|NOACTIVATE
        [System.Windows.Forms.Application]::DoEvents()
        if($r.inputs){ foreach($ev in $r.inputs){ try{ Inject $ev }catch{} } }
        $b=Get-Screen; if($b -and $b.Length){ Send-Frame $token $b }
        Start-Sleep -Milliseconds 120
      } else {
        if($shown){ [RI]::ShowWindow($bh,0) | Out-Null; $shown=$false }        # SW_HIDE
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 300
      }
    }catch{
      ULog ('error: '+$_.Exception.Message)
      if($_.Exception.Response.StatusCode.value__ -eq 401){ $token=Wait-Token }
      Start-Sleep -Seconds 2
    }
  }
}

# ---- diagnostics: run in a normal (visible) PowerShell window AS THE LOGGED-IN USER ----
function Run-Diag {
  $ok={param($m);Write-Host ("[ OK ] "+$m) -ForegroundColor Green}
  $bad={param($m);Write-Host ("[FAIL] "+$m) -ForegroundColor Red}
  Write-Host "== Toranit Agent diagnostics ==" -ForegroundColor Cyan
  Write-Host ("Server: "+$Server)
  Write-Host ("Running as: "+[System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $s=Load-State
  if($s -and $s.token){ &$ok ("Token found (device "+$s.deviceId+")") } else {
    &$bad ("No token in "+$State)
    Write-Host ("Enroll key baked in: "+$Key.Substring(0,[Math]::Min(9,$Key.Length))+"...")
    Write-Host "Trying to enroll now..." -ForegroundColor Cyan
    try{ $tk=Enroll; if($tk){ &$ok "Enrolled successfully - token saved. The computer should appear in the CRM within a minute." ; $s=Load-State } else { &$bad "Enroll returned no token" } }
    catch{ $code=''; try{ if($_.Exception.Response){ $code=' (HTTP '+$_.Exception.Response.StatusCode.value__+')' } }catch{}; &$bad ('Enroll FAILED'+$code+': '+$_.Exception.Message) }
  }
  try{ Add-Type -AssemblyName System.Windows.Forms,System.Drawing; &$ok "Loaded Windows.Forms/Drawing" }catch{ &$bad ("Assemblies: "+$_.Exception.Message) }
  try{ $b=Get-Screen; &$ok ("Screen capture "+$b.Length+" bytes ("+$script:VS.Width+"x"+$script:VS.Height+")") }catch{ &$bad ("Screen capture: "+$_.Exception.Message) }
  try{
    Add-Type @"
using System;using System.Runtime.InteropServices;
public class RID { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); }
"@
    if($script:VS){ [RID]::SetCursorPos(($script:VS.X+120),($script:VS.Y+120))|Out-Null; &$ok "Moved mouse cursor (watch it jump to top-left area)" } else { &$bad "No screen bounds for mouse test" }
  }catch{ &$bad ("Mouse move: "+$_.Exception.Message) }
  if($s -and $s.token){ try{ $r=Call '/api/agent/remote' @{} $s.token; &$ok ("Server reachable (session active="+[bool]$r.active+")") }catch{ &$bad ("Server call: "+$_.Exception.Message) } }
  Write-Host "Showing the red banner for 4 seconds..." -ForegroundColor Cyan
  try{
    $f=New-Object System.Windows.Forms.Form; $f.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None; $f.TopMost=$true; $f.ShowInTaskbar=$false
    $f.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual; $f.BackColor=[System.Drawing.Color]::FromArgb(200,45,35); $f.Size=New-Object System.Drawing.Size(360,32)
    $l=New-Object System.Windows.Forms.Label; $l.Dock=[System.Windows.Forms.DockStyle]::Fill; $l.TextAlign=[System.Drawing.ContentAlignment]::MiddleCenter; $l.ForeColor=[System.Drawing.Color]::White
    $l.Font=New-Object System.Drawing.Font('Segoe UI',10,[System.Drawing.FontStyle]::Bold); $l.Text=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('16nXnNeZ15jXlCDXnteo15fXldenINek16LXmdec15QgICAgIFRvcmFuaXQ='))
    $f.Controls.Add($l); $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $f.Location=New-Object System.Drawing.Point(([int]($wa.X+($wa.Width-360)/2)),($wa.Y+6))
    $f.Show(); for($i=0;$i -lt 40;$i++){ [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }; $f.Close()
    &$ok "Banner displayed"
  }catch{ &$bad ("Banner: "+$_.Exception.Message) }
  Write-Host "== Done. Copy everything above and send it to support. ==" -ForegroundColor Cyan
}

if($Uninstall){ Uninstall-Agent; return }
# ---- VNC diagnostics: run as the logged-on user in a normal PowerShell window ----
function Run-VncDiag {
  $ok={param($m);Write-Host ("[ OK ] "+$m) -ForegroundColor Green}
  $bad={param($m);Write-Host ("[FAIL] "+$m) -ForegroundColor Red}
  $info={param($m);Write-Host $m -ForegroundColor Cyan}
  &$info "== Toranit VNC diagnostics =="
  $svc=Get-Service tvnserver -ErrorAction SilentlyContinue
  if($svc){ &$ok ("TightVNC service status: "+$svc.Status) } else { &$bad "TightVNC service NOT installed" }
  $proc=Get-Process tvnserver -ErrorAction SilentlyContinue
  if($proc){ &$ok "tvnserver process is running" } else { &$bad "tvnserver process not running" }
  try{
    $c=New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',5900); $ns=$c.GetStream(); Start-Sleep -Milliseconds 400
    $buf=New-Object byte[] 12; $n=$ns.Read($buf,0,12); $banner=[System.Text.Encoding]::ASCII.GetString($buf,0,$n).Trim(); $c.Close()
    if($banner -like 'RFB*'){ &$ok ("VNC answering on 127.0.0.1:5900 ("+$banner+")") } else { &$bad ("port 5900 open but no RFB banner: '"+$banner+"'") }
  }catch{ &$bad ("cannot connect to 127.0.0.1:5900 - "+$_.Exception.Message) }
  if(Test-Path $VncFile){ try{ $vj=Get-Content $VncFile -Raw|ConvertFrom-Json; &$ok ("password file present (pass length "+($vj.pass.Length)+", ready="+$vj.ready+")") }catch{ &$bad "vnc.json unreadable" } } else { &$bad "vnc.json missing - VNC not configured yet (install may still be running or failed)" }
  $log=Join-Path $Dir 'vnc-install.log'
  if(Test-Path $log){ &$info "--- vnc-install.log (last 20 lines) ---"; Get-Content $log | Select-Object -Last 20 } else { Write-Host "no vnc-install.log yet (install not started)" -ForegroundColor Yellow }
  &$info "== Done. Copy everything above and send it to support. =="
}

if($Diag){ Run-Diag; return }
if($VncDiag){ Run-VncDiag; return }
if($User){ Run-UserHelper; return }
if(-not $Run){ Install-Agent; return }

# ---- VNC reverse tunnel: bridge the local VNC server (127.0.0.1:5900) out to the Toranit server ----
function Start-VncTunnel($token){
  if($script:vncJob -and $script:vncJob.State -eq 'Running'){ return }
  if($script:vncJob){ try{ Remove-Job $script:vncJob -Force }catch{} ; $script:vncJob=$null }
  $script:vncJob = Start-Job -ScriptBlock {
    param($server,$token,$logDir)
    $logf = Join-Path $logDir 'vnc-tunnel.log'
    function W($m){ try{ Add-Content $logf ((Get-Date -Format 'HH:mm:ss')+' '+$m) }catch{} }
    $ws=$null; $tcp=$null
    try{
      $wsurl = ($server -replace '^http','ws') + '/api/agent/vnc?token=' + $token
      W ("tunnel start, connecting WS to "+$wsurl)
      $ws = New-Object System.Net.WebSockets.ClientWebSocket
      $cts = New-Object System.Threading.CancellationTokenSource
      $ws.ConnectAsync([Uri]$wsurl, $cts.Token).GetAwaiter().GetResult()
      W ("WS connected, state="+$ws.State)
      $tcp = New-Object System.Net.Sockets.TcpClient
      $tcp.Connect('127.0.0.1',5900)
      W ("TCP connected to 127.0.0.1:5900, connected="+$tcp.Connected)
      $stream = $tcp.GetStream()
      $rbuf = New-Object byte[] 65536
      $recvSeg = New-Object System.ArraySegment[byte] -ArgumentList (,$rbuf)
      $recvTask = $ws.ReceiveAsync($recvSeg, $cts.Token)
      $sbuf = New-Object byte[] 65536
      $toSrv=0; $toVnc=0
      W 'pump loop running'
      while($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and $tcp.Connected){
        $did=$false
        if($recvTask.IsFaulted){ W ('recv faulted: '+$recvTask.Exception.GetBaseException().Message); break }
        if($recvTask.IsCompleted){
          $res=$recvTask.Result
          if($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close){ W 'WS close frame'; break }
          if($res.Count -gt 0){ $stream.Write($rbuf,0,$res.Count); $stream.Flush(); $toVnc+=$res.Count; if($toVnc -le 65536){ W ("browser->vnc first bytes total="+$toVnc) } }
          $recvTask = $ws.ReceiveAsync($recvSeg, $cts.Token); $did=$true
        }
        if($stream.DataAvailable){
          $n=$stream.Read($sbuf,0,$sbuf.Length)
          if($n -gt 0){ $seg=New-Object System.ArraySegment[byte] -ArgumentList $sbuf,0,$n; $ws.SendAsync($seg,[System.Net.WebSockets.WebSocketMessageType]::Binary,$true,$cts.Token).GetAwaiter().GetResult(); $toSrv+=$n; if($toSrv -le 65536){ W ("vnc->browser first bytes total="+$toSrv) } }
          $did=$true
        }
        if(-not $did){ Start-Sleep -Milliseconds 5 }
      }
      W ("pump ended; wsState="+$ws.State+" tcpConnected="+$tcp.Connected+" sent2srv="+$toSrv+" sent2vnc="+$toVnc)
    }catch{ W ('ERROR: '+$_.Exception.Message) }
    finally{ try{ $ws.Dispose() }catch{}; try{ $tcp.Close() }catch{}; W 'tunnel closed' }
  } -ArgumentList $Server,$token,$Dir
}

# ---- auto-install a VNC server (TightVNC) with a unique per-machine password, localhost-only ----
function Ensure-VncInstalled {
  if($script:vncInstJob){ return }
  if(Test-Path $VncFile){ try{ if((Get-Content $VncFile -Raw | ConvertFrom-Json).ready){ return } }catch{} }
  $script:vncInstJob = Start-Job -ScriptBlock {
    param($vncFile,$server)
    function W($m){ try{ Add-Content (Join-Path ([IO.Path]::GetDirectoryName($vncFile)) 'vnc-install.log') ((Get-Date -Format s)+' '+$m) }catch{} }
    try{
      $svc = Get-Service tvnserver -ErrorAction SilentlyContinue
      $existing=$null; if(Test-Path $vncFile){ try{ $existing=(Get-Content $vncFile -Raw|ConvertFrom-Json) }catch{} }
      if($svc -and $existing -and $existing.pass){ @{ pass=$existing.pass; ready=$true; at=(Get-Date -Format s) }|ConvertTo-Json -Compress|Set-Content $vncFile; W 'already installed'; return }
      $pw = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 8 | ForEach-Object {[char]$_})
      $is64 = [Environment]::Is64BitOperatingSystem
      $arch = if($is64){'64bit'}else{'32bit'}; $archN = if($is64){'64'}else{'32'}
      $msi = Join-Path $env:TEMP 'tightvnc.msi'
      [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
      $srvUrl = "$server/api/agent/vncmsi?arch=$archN"
      $fellBack=$false
      try{ W "downloading from server $srvUrl"; Invoke-WebRequest $srvUrl -OutFile $msi -UseBasicParsing -TimeoutSec 180 }
      catch{ $fellBack=$true; $url="https://www.tightvnc.com/download/2.8.81/tightvnc-2.8.81-gpl-setup-$arch.msi"; W ("server copy not available ("+$_.Exception.Message+"), trying "+$url); Invoke-WebRequest $url -OutFile $msi -UseBasicParsing -TimeoutSec 180 }
      if(-not (Test-Path $msi) -or (Get-Item $msi).Length -lt 100000){ throw "downloaded MSI missing or too small" }
      W ('downloaded ' + (Get-Item $msi).Length + ' bytes (fromServer=' + (-not $fellBack) + '); installing')
      $p = @('/i',"`"$msi`"",'/quiet','/norestart','ADDLOCAL=Server','SERVER_REGISTER_AS_SERVICE=1','SERVER_ADD_FIREWALL_EXCEPTION=0','SET_ACCEPTHTTPCONNECTIONS=1','VALUE_OF_ACCEPTHTTPCONNECTIONS=0','SET_RFBPORT=1','VALUE_OF_RFBPORT=5900','SET_USEVNCAUTHENTICATION=1','VALUE_OF_USEVNCAUTHENTICATION=1','SET_PASSWORD=1',"VALUE_OF_PASSWORD=$pw",'SET_USECONTROLAUTHENTICATION=1','VALUE_OF_USECONTROLAUTHENTICATION=0','SET_ALLOWLOOPBACK=1','VALUE_OF_ALLOWLOOPBACK=1','SET_LOOPBACKONLY=1','VALUE_OF_LOOPBACKONLY=1')
      $rc = (Start-Process msiexec.exe -ArgumentList $p -Wait -PassThru).ExitCode
      W "msiexec exit $rc"
      Start-Sleep -Seconds 3; try{ Start-Service tvnserver -ErrorAction SilentlyContinue }catch{}
      @{ pass=$pw; ready=$true; at=(Get-Date -Format s) } | ConvertTo-Json -Compress | Set-Content $vncFile
      W 'done'
    }catch{ W ('error: '+$_.Exception.Message) }
  } -ArgumentList $VncFile,$Server
}

# ---- make sure TightVNC is actually LISTENING on 127.0.0.1:5900 ----
# The TightVNC MSI's silent-config (SET_RFBPORT/SET_PASSWORD/...) often does not persist, leaving the
# service running with an empty config and no listening port. We write the config to the registry
# directly and restart the service. Loopback-only: the port is reachable only from this machine, i.e.
# only through our authenticated reverse tunnel, so no VNC password is needed and nothing is exposed to the LAN.
function Set-VncReg($name,$val){ New-ItemProperty -Path 'HKLM:\SOFTWARE\TightVNC\Server' -Name $name -Value $val -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null }
$script:vncCfgAt = 0
function Ensure-VncListening {
  $svc = Get-Service tvnserver -ErrorAction SilentlyContinue
  if(-not $svc){ return }
  $ok=$false; try{ $c=New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',5900); $ok=$true; $c.Close() }catch{}
  if($ok){ return }
  $now=(Get-Date).Ticks
  if($script:vncCfgAt -ne 0 -and ($now-$script:vncCfgAt) -lt [TimeSpan]::FromMinutes(3).Ticks){ return }
  $script:vncCfgAt=$now
  $log=Join-Path $Dir 'vnc-install.log'
  try{
    New-Item -Path 'HKLM:\SOFTWARE\TightVNC\Server' -Force -ErrorAction SilentlyContinue | Out-Null
    Set-VncReg 'AcceptRfbConnections' 1
    Set-VncReg 'RfbPort' 5900
    Set-VncReg 'UseVncAuthentication' 0
    Set-VncReg 'AllowLoopback' 1
    Set-VncReg 'LoopbackOnly' 1
    Set-VncReg 'AcceptHttpConnections' 0
    try{ Restart-Service tvnserver -Force -ErrorAction Stop }
    catch{ try{ Stop-Service tvnserver -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Start-Service tvnserver -ErrorAction SilentlyContinue }catch{} }
    Start-Sleep -Seconds 2
    $ok2=$false; try{ $c2=New-Object System.Net.Sockets.TcpClient; $c2.Connect('127.0.0.1',5900); $ok2=$true; $c2.Close() }catch{}
    Add-Content $log ((Get-Date -Format s)+" reconfigured TightVNC (port 5900, loopback-only, no-auth); listening=$ok2")
  }catch{ Add-Content $log ((Get-Date -Format s)+" reconfigure failed: "+$_.Exception.Message) }
}

# ---- run loop ----
$script:pendSoftware=$false; $script:pendUpdates=$false
$interval=30
while($true){
  try{
    $s=Load-State; $token=if($s){$s.token}else{$null}
    if(-not $token){ $token=Enroll }
    Ensure-VncInstalled
    Ensure-VncListening
    $beat=@{ agentVer=$Ver; metrics=(Get-Metrics) }
    if(Test-Path $VncFile){ try{ $vj=Get-Content $VncFile -Raw|ConvertFrom-Json; if($vj.pass){ $beat.vncPass=$vj.pass; $beat.vncReady=[bool]$vj.ready } }catch{} }
    # include the tail of the VNC tunnel log so remote VNC problems can be diagnosed from the CRM (no console needed)
    try{ $tl=Join-Path $Dir 'vnc-tunnel.log'; if(Test-Path $tl){ $beat.vncLog=((Get-Content $tl -Tail 15) -join "`n") } }catch{}
    if($script:pendSoftware){ $beat.software=@(Get-Software); $script:pendSoftware=$false }
    if($script:pendUpdates){ $beat.updates=(Get-PendingUpdates); $script:pendUpdates=$false }
    $resp=Call '/api/agent/beat' $beat $token
    Self-Update $token $resp.agentVer
    if($resp.interval){ $interval=[int]$resp.interval }
    if($resp.vnc){ Start-VncTunnel $token }
    foreach($c in $resp.commands){
      $res=$null
      switch($c.shell){
        'software' { $script:pendSoftware=$true; $n=(@(Get-Software)).Count; $res=@{ output="Collected software list: $n items. Shown in the computer card." ; status='done'; exit=0 } }
        'updates'  { $u=Get-PendingUpdates; $script:pendUpdates=$true; $res=@{ output=("Pending updates: {0}`n{1}" -f $u.count,(($u.titles) -join "`n")); status='done'; exit=0 } }
        'sysinfo'  { $m=Get-Metrics; $res=@{ output=($m | ConvertTo-Json); status='done'; exit=0 } }
        default    { $res=Run-Shell $c.cmd $c.shell ([int]$c.timeout) }
      }
      try{ Call '/api/agent/result' @{ id=$c.id; output=([string]$res.output); status=$res.status; exit=$res.exit } $token | Out-Null }catch{}
    }
  }catch{
    if($_.Exception.Response.StatusCode.value__ -eq 401){ Remove-Item -LiteralPath $State -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 15
  }
  Start-Sleep -Seconds $interval
}
