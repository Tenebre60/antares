; Registra o Aurora como navegador no Windows (aparece em Configurações > Aplicativos padrão)
!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora" "" "Aurora"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\DefaultIcon" "" "$INSTDIR\Aurora.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\shell\open\command" "" '"$INSTDIR\Aurora.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationName" "Aurora"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationDescription" "Navegador Aurora, baseado em Chromium"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationIcon" "$INSTDIR\Aurora.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\StartMenu" "StartMenuInternet" "Aurora"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\URLAssociations" "http" "AuroraURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\URLAssociations" "https" "AuroraURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".htm" "AuroraHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".html" "AuroraHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".shtml" "AuroraHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".xhtml" "AuroraHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".svg" "AuroraHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities\FileAssociations" ".pdf" "AuroraHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "Aurora" "Software\Clients\StartMenuInternet\Aurora\Capabilities"

  WriteRegStr HKCU "Software\Classes\AuroraURL" "" "Aurora URL"
  WriteRegStr HKCU "Software\Classes\AuroraURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\AuroraURL\DefaultIcon" "" "$INSTDIR\Aurora.exe,0"
  WriteRegStr HKCU "Software\Classes\AuroraURL\shell\open\command" "" '"$INSTDIR\Aurora.exe" --single-argument %1'
  WriteRegStr HKCU "Software\Classes\AuroraHTML" "" "Documento Aurora"
  WriteRegStr HKCU "Software\Classes\AuroraHTML\DefaultIcon" "" "$INSTDIR\Aurora.exe,0"
  WriteRegStr HKCU "Software\Classes\AuroraHTML\shell\open\command" "" '"$INSTDIR\Aurora.exe" --single-argument %1'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Aurora"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Aurora"
  DeleteRegKey HKCU "Software\Classes\AuroraURL"
  DeleteRegKey HKCU "Software\Classes\AuroraHTML"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
