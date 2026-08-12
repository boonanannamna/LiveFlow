!macro NSIS_HOOK_PREINSTALL
  ; Close an older LiveFlow instance and its bundled connector so that files
  ; in $INSTDIR can always be replaced during an update.
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "liveflow-tiktok-connector.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "LiveFlow.exe"'
  Pop $0
  Pop $1
  Sleep 750
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\LiveFlow.lnk" "$INSTDIR\LiveFlow.exe" "" "$INSTDIR\LiveFlow.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "liveflow-tiktok-connector.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "LiveFlow.exe"'
  Pop $0
  Pop $1
  Sleep 750
  Delete "$DESKTOP\LiveFlow.lnk"
!macroend
