; Toranit Remote Support - Windows installer (NSIS)
; Builds a normal setup.exe with a wizard: welcome -> consent -> progress -> finish.
; The enroll key is a fixed-length placeholder that the server patches per download.

Unicode true
SetCompress off            ; keep strings uncompressed so the server can patch the enroll key placeholder
CRCCheck off               ; allow the server to patch the enroll key placeholder without tripping the integrity check

!include "MUI2.nsh"

!define APPNAME   "Toranit Remote Support"
!define COMPANY   "Toranit"
!define APPVER    "1.30.2"
!ifndef SERVERURL
  !define SERVERURL "https://crm.toranit.co.il"
!endif
!ifndef ENROLLKEY
  !define ENROLLKEY "ek_0000000000000000000000000000000000000000"   ; 43 chars; server replaces with the real key
!endif
!define ARPKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ToranitAgent"

Name "${APPNAME}"
OutFile "ToranitAgentSetup.exe"
InstallDir "$PROGRAMFILES64\ToranitAgent"
RequestExecutionLevel admin
ShowInstDetails show
BrandingText "${COMPANY}"

!define MUI_ABORTWARNING

; ---- welcome ----
!define MUI_WELCOMEPAGE_TITLE "${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "אשף זה יתקין את תוכנת התמיכה מרחוק של Toranit על המחשב.$\r$\n$\r$\nלחץ 'הבא' כדי להמשיך."
!insertmacro MUI_PAGE_WELCOME

; ---- consent / agreement ----
!define MUI_PAGE_HEADER_TEXT "אישור והסכמה"
!define MUI_PAGE_HEADER_SUBTEXT "התקנת תוכנת תמיכה מרחוק"
!define MUI_LICENSEPAGE_TEXT_TOP "אנא קרא/י את ההסבר לפני ההתקנה:"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "סמן/י את התיבה ולחץ/י 'התקן' כדי להמשיך."
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "אני מאשר/ת ומבין/ה"
!define MUI_LICENSEPAGE_BUTTON "התקן"
!insertmacro MUI_PAGE_LICENSE "consent.txt"

; ---- install progress ----
!insertmacro MUI_PAGE_INSTFILES

; ---- finish ----
!define MUI_FINISHPAGE_TITLE "ההתקנה הושלמה"
!define MUI_FINISHPAGE_TEXT "תוכנת התמיכה מרחוק הותקנה. המחשב יופיע במערכת Toranit תוך כדקה."
!insertmacro MUI_PAGE_FINISH

; ---- uninstaller ----
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Hebrew"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Install the agent via ONE inline PowerShell command (no generated .ps1 files, so no text-encoding pitfalls).
  ; It records the user's consent, downloads the agent (server fills in URL + key), installs it with -NoArp
  ; (this installer owns the Add/Remove entry), and writes a transcript to %ProgramData%\toranit-setup.log.
  DetailPrint "מתקין את סוכן התמיכה..."
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $\"$$ErrorActionPreference='Continue'; Start-Transcript -Path ($$env:ProgramData+'\toranit-setup.log') -Force | Out-Null; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $$d=$$env:ProgramData+'\ToranitAgent'; New-Item -ItemType Directory -Force $$d | Out-Null; @{accepted=$$true;at=(Get-Date -Format s);user=$$env:USERNAME;host=$$env:COMPUTERNAME;via='setup.exe'} | ConvertTo-Json -Compress | Set-Content ($$d+'\consent.json'); $$k='${ENROLLKEY}'; $$p=$$env:TEMP+'\ta.ps1'; Invoke-WebRequest ('${SERVERURL}/api/agent/install.ps1?key='+$$k) -OutFile $$p -UseBasicParsing -TimeoutSec 120; Write-Output ('downloaded '+((Get-Item $$p).Length)+' bytes'); & $$p -NoArp; Stop-Transcript | Out-Null$\""
  Pop $0
  DetailPrint "קוד התקנה: $0"

  ; uninstaller + Add/Remove Programs entry
  DetailPrint "משלים את ההתקנה..."
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${ARPKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${ARPKEY}" "DisplayVersion" "${APPVER}"
  WriteRegStr HKLM "${ARPKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${ARPKEY}" "DisplayIcon" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${ARPKEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${ARPKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${ARPKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${ARPKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  DetailPrint "מסיר את סוכן התמיכה..."
  ExpandEnvStrings $1 "%ProgramData%"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$1\ToranitAgent\toranit-agent.ps1" -Uninstall'
  Pop $0
  DeleteRegKey HKLM "${ARPKEY}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
