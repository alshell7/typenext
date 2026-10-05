; Keep the uninstaller on the same mark as the app and installer. The pinned
; Rust configuration parser predates the newer uninstallerIcon JSON setting.
; Tauri includes this file before NSIS creates its Modern UI pages.
!ifndef MUI_UNICON
  !define MUI_UNICON "${__FILEDIR__}\icon.ico"
!endif
