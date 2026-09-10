' Launch local/run.mjs with no console window.
'
' schtasks /TR "node ..." runs node.exe as a console app, so Windows opens a
' visible terminal on every fire -- every two minutes for the quotes job.
' WshShell.Run with window style 0 starts the same process hidden.
'
' Usage (from Task Scheduler):
'   wscript.exe "<repo>\local\run-hidden.vbs" quotes --publish
'
' WAIT for node instead of returning immediately. With bWaitOnReturn = False
' wscript.exe exits the instant node starts, so Task Scheduler marks the task
' "finished, result 0x0" before any work happens. That silently disables three
' safety nets: ExecutionTimeLimit can never kill a hung run, LastTaskResult
' always reads success, and MultipleInstances=IgnoreNew never sees an overlap.
' Waiting costs nothing -- window style 0 keeps it hidden either way -- and it
' makes the exit code real. See data/.run.lock for the in-app overlap guard,
' which had to exist precisely because the scheduler's own guard was inert.
'
' Comments are kept ASCII on purpose: VBScript files are read as ANSI, so
' UTF-8 Arabic here would be mojibake. See local/README.md for the Arabic notes.

Dim sh, fso, root, args, a, code
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next

sh.CurrentDirectory = root
code = sh.Run("node """ & root & "\local\run.mjs""" & args, 0, True)
WScript.Quit code
