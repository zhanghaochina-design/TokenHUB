; 覆盖安装/卸载前结束旧实例：窗口关闭只隐藏到托盘，安装器默认的关闭请求无法结束进程，
; 否则会提示「TokenHUB 无法关闭」。taskkill 在进程不存在时返回非零，忽略即可。
!macro customInit
  nsExec::Exec 'taskkill /IM TokenHUB.exe /F'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /IM TokenHUB.exe /F'
  Pop $0
!macroend