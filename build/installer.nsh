; Klakboard tourne resident (zone de notifications) : ses fichiers sont donc
; verrouilles la plupart du temps. Sans ceci, relancer l'installeur sur une
; instance en cours echoue silencieusement sur les fichiers en cours d'usage.
!macro customInit
  nsExec::Exec 'taskkill /F /IM Klakboard.exe /T'
  Sleep 500
!macroend
