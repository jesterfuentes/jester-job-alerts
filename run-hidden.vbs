' Runs the checker with no visible window (powershell -WindowStyle Hidden still flashes briefly).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """C:\Program Files\nodejs\node.exe"" checker.mjs", 0, False
