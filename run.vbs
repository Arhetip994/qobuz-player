CreateObject("WScript.Shell").Run "python """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\qobuz_gui.py""", 0, False
