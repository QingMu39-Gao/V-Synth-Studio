Unicode true

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef PACKAGE_DIR
  !define PACKAGE_DIR "..\dist\V-Synth-Studio-${VERSION}-windows-x64"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\dist\V-Synth-Studio-${VERSION}-windows-x64-setup.exe"
!endif

Name "V-Synth Studio"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\V-Synth-Studio"
InstallDirRegKey HKCU "Software\V-Synth-Studio" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "V-Synth Studio ${VERSION}"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "Japanese"

Section "V-Synth Studio" SEC_APP
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${PACKAGE_DIR}\*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\V-Synth Studio"
  CreateShortcut "$SMPROGRAMS\V-Synth Studio\V-Synth Studio.lnk" "$INSTDIR\V-Synth-Studio.exe"
  CreateShortcut "$SMPROGRAMS\V-Synth Studio\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\V-Synth Studio.lnk" "$INSTDIR\V-Synth-Studio.exe"

  WriteRegStr HKCU "Software\V-Synth-Studio" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "DisplayName" "V-Synth Studio"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "Publisher" "QingMu39"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "DisplayIcon" "$INSTDIR\V-Synth-Studio.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\V-Synth Studio\V-Synth Studio.lnk"
  Delete "$SMPROGRAMS\V-Synth Studio\Uninstall.lnk"
  RMDir "$SMPROGRAMS\V-Synth Studio"
  Delete "$DESKTOP\V-Synth Studio.lnk"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\V-Synth-Studio"
  DeleteRegKey HKCU "Software\V-Synth-Studio"
SectionEnd
