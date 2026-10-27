<#
  Toranit Agent — RMM agent for computers you are authorized to manage.
  Installs openly as a Windows Scheduled Task named "ToranitAgent" (visible in Task Scheduler),
  reports status to your Toranit server, and runs commands an admin queues there.
  Every command is logged on the server. This agent does not hide itself and does not touch antivirus.

  Install (run in an elevated PowerShell on the managed PC):
    $k='PUT-ENROLL-KEY'; iwr "https://YOURSERVER/api/agent/install.ps1?key=$k" -OutFile "$env:TEMP\ta.ps1"; & "$env:TEMP\ta.ps1"
  Uninstall:
    & "$env:ProgramData\ToranitAgent\toranit-agent.ps1" -Uninstall
#>
param([switch]$Run, [switch]$Uninstall)

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
  Write-Host "Toranit Agent installed and started (scheduled task '$Task')." -ForegroundColor Green
}
function Uninstall-Agent {
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
  $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  return @{
    host=$env:COMPUTERNAME; os=("{0} {1}" -f $os.Caption,$os.Version);
    cpu=[int]$cpu;
    memUsed=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1048576,1);
    memTotal=[math]::Round($os.TotalVisibleMemorySize/1048576,1);
    diskFree=[math]::Round($d.FreeSpace/1073741824,1);
    diskTotal=[math]::Round($d.Size/1073741824,1);
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
  }catch{ return @{ count=-1; titles=@("לא ניתן לבדוק עדכונים: $($_.Exception.Message)") } }
}
function Run-Shell($cmd,$shell,$timeout){
  $sb = if($shell -eq 'cmd'){ { param($c) & cmd.exe /c $c 2>&1 | Out-String } } else { { param($c) powershell -NoProfile -ExecutionPolicy Bypass -Command $c 2>&1 | Out-String } }
  $job=Start-Job -ScriptBlock $sb -ArgumentList $cmd
  if(Wait-Job $job -Timeout $timeout){ $out=Receive-Job $job; $st='done'; $ex=0 }
  else { Stop-Job $job -ErrorAction SilentlyContinue; $out="— הפקודה חרגה מהזמן המותר ($timeout שניות) ובוטלה —"; $st='error'; $ex=124 }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  return @{ output=$out; status=$st; exit=$ex }
}

if($Uninstall){ Uninstall-Agent; return }
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
        'software' { $script:pendSoftware=$true; $n=(@(Get-Software)).Count; $res=@{ output="נאספה רשימת תוכנות: $n פריטים. מופיעה בכרטיס המחשב." ; status='done'; exit=0 } }
        'updates'  { $u=Get-PendingUpdates; $script:pendUpdates=$true; $res=@{ output=("עדכונים ממתינים: {0}`n{1}" -f $u.count,(($u.titles) -join "`n")); status='done'; exit=0 } }
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
