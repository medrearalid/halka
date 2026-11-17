; Installing over a running Halka: close it without asking, reopen it when done.
; (The self-updater already exits the app and passes /R, so this only matters for manual installs.)
Var HalkaWasRunning

!macro NSIS_HOOK_PREINSTALL
  StrCpy $HalkaWasRunning 0
  ; only the copy installed here, never dev builds or other folders
  nsExec::ExecToStack `powershell -NoProfile -NonInteractive -Command "$$p = Get-Process halka -EA 0 | ? Path -eq '$INSTDIR\${MAINBINARYNAME}.exe'; if ($$p) { $$p | Stop-Process -Force; $$p | Wait-Process -Timeout 10 -EA 0; exit 3 }"`
  Pop $0
  Pop $1
  ${If} $0 == 3
    StrCpy $HalkaWasRunning 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $HalkaWasRunning = 1
  ${AndIf} $UpdateMode <> 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
