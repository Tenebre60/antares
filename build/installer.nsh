; Registra o Antares como navegador no Windows. As chaves mantêm o nome interno "Aurora" (nome antigo) para que a escolha de navegador padrão continue valendo após a atualização.
!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora" "" "Antares"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\DefaultIcon" "" "$INSTDIR\Antares.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\shell\open\command" "" '"$INSTDIR\Antares.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationName" "Antares"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationDescription" "Navegador Antares, baseado em Chromium"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Aurora\Capabilities" "ApplicationIcon" "$INSTDIR\Antares.exe,0"
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

  WriteRegStr HKCU "Software\Classes\AuroraURL" "" "Antares URL"
  WriteRegStr HKCU "Software\Classes\AuroraURL" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\AuroraURL\DefaultIcon" "" "$INSTDIR\Antares.exe,0"
  WriteRegStr HKCU "Software\Classes\AuroraURL\shell\open\command" "" '"$INSTDIR\Antares.exe" --single-argument %1'
  WriteRegStr HKCU "Software\Classes\AuroraHTML" "" "Documento Antares"
  WriteRegStr HKCU "Software\Classes\AuroraHTML\DefaultIcon" "" "$INSTDIR\Antares.exe,0"
  WriteRegStr HKCU "Software\Classes\AuroraHTML\shell\open\command" "" '"$INSTDIR\Antares.exe" --single-argument %1'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Aurora"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Aurora"
  DeleteRegKey HKCU "Software\Classes\AuroraURL"
  DeleteRegKey HKCU "Software\Classes\AuroraHTML"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
