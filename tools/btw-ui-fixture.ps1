# Research-only: opens an ORIGINAL fixture for editing; never prints.
# Run with Windows PowerShell, not the application's server runtime.
Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwVisibleResearch {
 public static BarTender.ApplicationClass App;
 public static void Open() {
  App = new BarTender.ApplicationClass();
  App.Visible=true;
  App.Formats.Open(System.IO.Path.GetFullPath("research-artifacts/btw/blank.btw"),false,"");
  System.Console.WriteLine("Research editor PID: " +App.ProcessId);
 }
}
'@
[BtwVisibleResearch]::Open()
