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
param([switch]$Run, [switch]$Uninstall, [switch]$User)

$Server = '@@SERVER@@'
$Key    = '@@KEY@@'
$Ver    = '1.0.0'
$Dir    = Join-Path $env:ProgramData 'ToranitAgent'
$State  = Join-Path $Dir 'state.json'
$Task   = 'ToranitAgent'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Save-State($o){ $o | ConvertTo-Json -Compress | Set-Content -LiteralPath $State -Encoding UTF8 }
function Load-State { if(Test-Path $State){ try{ return Get-Content -LiteralPath $State -Raw | ConvertFrom-Json }catch{} } return $null }
function MachineId { try{ (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid }catch{ $env:COMPUTERNAME } }

function Install-Agent {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  # keep an on-disk copy of this script so the scheduled task runs it
  try { Invoke-WebRequest "$Server/api/agent/install.ps1?key=$Key" -OutFile (Join-Path $Dir 'toranit-agent.ps1') -UseBasicParsing }
  catch { Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Dir 'toranit-agent.ps1') -Force -ErrorAction SilentlyContinue }
  $file = Join-Path $Dir 'toranit-agent.ps1'
  $act  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run' -f $file)
  $t1   = New-ScheduledTaskTrigger -AtStartup
  $t2   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $Task -Action $act -Trigger $t1,$t2 -Principal $prin -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName $Task
  # second task: runs in the logged-on user's session for screen view + input control (not SYSTEM)
  $uact = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -User' -f $file)
  $uprin = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
  $uset = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName ($Task + 'User') -Action $uact -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Principal $uprin -Settings $uset -Force | Out-Null
  try { Start-ScheduledTask -TaskName ($Task + 'User') } catch {}
  Write-Host "Toranit Agent installed and started (tasks '$Task' and '${Task}User')." -ForegroundColor Green
}
function Uninstall-Agent {
  Unregister-ScheduledTask -TaskName ($Task + 'User') -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Toranit Agent removed." -ForegroundColor Yellow
}

function Call($path, $body, $token){
  $h = @{}; if($token){ $h['Authorization'] = "Bearer $token" }
  $json = if($body){ $body | ConvertTo-Json -Depth 6 -Compress } else { '{}' }
  return Invoke-RestMethod -Uri ($Server + $path) -Method Post -Headers $h -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 60
}
function Enroll {
  $r = Call '/api/agent/enroll' @{ key=$Key; hostname=$env:COMPUTERNAME; os=((Get-CimInstance Win32_OperatingSystem).Caption); machineId=(MachineId); agentVer=$Ver }
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
  if(Wait-Job $job -Timeout $timeout){ $out=Receive-Job $job; $st='done'; $ex=0 }
  else { Stop-Job $job -ErrorAction SilentlyContinue; $out="[command timed out after $timeout seconds and was cancelled]"; $st='error'; $ex=124 }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return @{ output=$out; status=$st; exit=$ex }
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
  $token=Wait-Token
  while($true){
    try{
      $r=Call '/api/agent/remote' @{} $token
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
      if($_.Exception.Response.StatusCode.value__ -eq 401){ $token=Wait-Token }
      Start-Sleep -Seconds 2
    }
  }
}

if($Uninstall){ Uninstall-Agent; return }
if($User){ Run-UserHelper; return }
if(-not $Run){ Install-Agent; return }

# ---- run loop ----
$script:pendSoftware=$false; $script:pendUpdates=$false
$interval=30
while($true){
  try{
    $s=Load-State; $token=if($s){$s.token}else{$null}
    if(-not $token){ $token=Enroll }
    $beat=@{ agentVer=$Ver; metrics=(Get-Metrics) }
    if($script:pendSoftware){ $beat.software=@(Get-Software); $script:pendSoftware=$false }
    if($script:pendUpdates){ $beat.updates=(Get-PendingUpdates); $script:pendUpdates=$false }
    $resp=Call '/api/agent/beat' $beat $token
    if($resp.interval){ $interval=[int]$resp.interval }
    foreach($c in $resp.commands){
      $res=$null
      switch($c.shell){
        'software' { $script:pendSoftware=$true; $n=(@(Get-Software)).Count; $res=@{ output="Collected software list: $n items. Shown in the computer card." ; status='done'; exit=0 } }
        'updates'  { $u=Get-PendingUpdates; $script:pendUpdates=$true; $res=@{ output=("Pending updates: {0}`n{1}" -f $u.count,(($u.titles) -join "`n")); status='done'; exit=0 } }
        'sysinfo'  { $m=Get-Metrics; $res=@{ output=($m | ConvertTo-Json); status='done'; exit=0 } }
        default    { $res=Run-Shell $c.cmd $c.shell ([int]$c.timeout) }
      }
      try{ Call '/api/agent/result' @{ id=$c.id; output=$res.output; status=$res.status; exit=$res.exit } $token | Out-Null }catch{}
    }
  }catch{
    if($_.Exception.Response.StatusCode.value__ -eq 401){ Remove-Item -LiteralPath $State -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 15
  }
  Start-Sleep -Seconds $interval
}
