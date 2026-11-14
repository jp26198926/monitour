; Custom NSIS macros — auto-included by electron-builder (buildResources: build).
!macro customUnInstall
  ; Runs before file removal. During upgrades the uninstall section also runs
  ; (installer invokes the old uninstaller with --updated) — keep the service,
  ; tasks and agent identity so the updated app keeps working.
  ${ifNot} ${isUpdated}
    ; Stop task instances first so the exe isn't locked during file removal.
    nsExec::ExecToLog 'schtasks /end /tn "MonitourAgent"'
    nsExec::ExecToLog 'schtasks /delete /tn "MonitourAgent" /f'
    nsExec::ExecToLog 'schtasks /end /tn "MonitourLockCapture"'
    nsExec::ExecToLog 'schtasks /delete /tn "MonitourLockCapture" /f'

    ; Wipe agent identity/config: current user's, the SYSTEM service instance's
    ; (schtasks /ru SYSTEM => os.homedir() = systemprofile), and the shared
    ; bootstrap copy. ReadEnvStr avoids hardcoding C:\ProgramData.
    RMDir /r "$PROFILE\.monitour-agent"
    RMDir /r "$WINDIR\System32\config\systemprofile\.monitour-agent"
    ReadEnvStr $R0 "ProgramData"
    RMDir /r "$R0\Monitour"
  ${endif}
!macroend
