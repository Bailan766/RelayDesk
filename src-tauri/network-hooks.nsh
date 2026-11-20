!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\relaydesk.exe" 0 relaydesk_preinstall_done
    ExecWait '"$INSTDIR\relaydesk.exe" --recover-network' $0
    ${If} $0 != 0
      Abort "Exit RelayDesk from the tray before updating."
    ${EndIf}
  relaydesk_preinstall_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\relaydesk.exe" 0 relaydesk_preuninstall_done
    ExecWait '"$INSTDIR\relaydesk.exe" --recover-network' $0
    ${If} $0 != 0
      Abort "Exit RelayDesk from the tray before uninstalling."
    ${EndIf}
  relaydesk_preuninstall_done:
!macroend
