; Extra instructions for the Windows installer (used by electron-builder).
;
; The installer is self-contained: the app, its runtime and every library it
; needs are inside the one .exe. There is nothing else to download or install,
; and no command line is involved.
;
; Install for the current Windows user only. This removes the "who should this
; be installed for?" page and the administrator prompt, so the only thing the
; installer asks is where to install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Suggest a readable install folder the first time. If the app is already
; installed, the folder it is in is kept.
!macro preInit
  SetRegView 64
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Species Specific VoIP"
  ${endif}
!macroend
