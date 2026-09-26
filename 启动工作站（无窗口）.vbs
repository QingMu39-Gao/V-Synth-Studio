' 翻调工作站 — 无窗口启动
' 双击后在后台启动服务并弹出应用窗口，不显示黑色控制台。
' 停止服务请运行「停止工作站.bat」。

Option Explicit

Dim fso, sh, root, nodeExe, candidates, i, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

' ---------- 寻找 Node.js ----------
nodeExe = ""
candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
  sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node.exe", _
  "C:\Users\Administrator\Desktop\素材\DeepSeek Harness-3.1.2-win\resources\node\node.exe", _
  "D:\DeepSeek Harness-3.1.2-win\resources\node\node.exe" _
)

For i = 0 To UBound(candidates)
  If nodeExe = "" Then
    If fso.FileExists(candidates(i)) Then nodeExe = candidates(i)
  End If
Next

If nodeExe = "" Then
  ' 再试 PATH
  On Error Resume Next
  Dim exec
  Set exec = sh.Exec("cmd /c where node.exe")
  If Err.Number = 0 Then
    Dim line
    Do While Not exec.StdOut.AtEndOfStream
      line = Trim(exec.StdOut.ReadLine())
      If line <> "" And nodeExe = "" Then
        If fso.FileExists(line) Then nodeExe = line
      End If
    Loop
  End If
  On Error GoTo 0
End If

If nodeExe = "" Then
  MsgBox "没有找到 Node.js。" & vbCrLf & vbCrLf & _
         "本程序需要 Node.js 18 以上版本（无需安装任何依赖包）。" & vbCrLf & _
         "请到 https://nodejs.org/zh-cn 下载安装后重试。", _
         vbCritical, "翻调工作站"
  WScript.Quit 1
End If

' ---------- 启动服务（隐藏窗口） ----------
cmd = """" & nodeExe & """ """ & root & "\app\server\index.mjs"" --open"
sh.Run cmd, 0, False
