# Research-only. Never sends output to a printer. Requires an EXISTING Zebra
# Windows printer queue/driver; this script does not install or alter drivers.
$ErrorActionPreference = 'Stop'
$researchOutput = Join-Path $PSScriptRoot '..\research-artifacts\zpl'
New-Item -ItemType Directory -Force -Path $researchOutput | Out-Null
$researchDrivers = @(Get-PrinterDriver | Select-Object Name, Manufacturer)
$researchQueues = @(Get-Printer | Select-Object Name, DriverName)
@{ drivers = $researchDrivers; queues = $researchQueues } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $researchOutput 'driver-inventory.json')
$researchZebra = $researchQueues | Where-Object { $_.DriverName -match 'Zebra|ZDesigner' -and $_.DriverName -match 'ZPL' } | Select-Object -First 1
if (-not $researchZebra) {
  'Reference generation unavailable: no installed Zebra/ZDesigner ZPL printer queue and driver. No Print or template export called.' | Set-Content -LiteralPath (Join-Path $researchOutput 'reference-status.txt')
  Write-Output 'No existing Zebra ZPL queue/driver; reference generation skipped.'
  exit 0
}
Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class ZplReferenceResearch {
 public static void Export(string printer, string directory) {
  var app=new BarTender.ApplicationClass();
  try {
   var format=app.Formats.Add();
   // Set and verify file routing BEFORE selecting a printer or invoking Print.
   format.PrintToFile=true;
   format.PrinterFile=System.IO.Path.Combine(directory,"bartender-blank-4x2.zpl");
   format.Printer=printer;
   format.PageSetup.PaperWidth=4;format.PageSetup.PaperHeight=2;
   format.PageSetup.LabelSizeManual=true;
   format.PageSetup.LabelWidth=4;format.PageSetup.LabelHeight=2;
   format.PageSetup.MarginLeft=0;format.PageSetup.MarginRight=0;
   format.PageSetup.MarginTop=0;format.PageSetup.MarginBottom=0;
   format.SaveAs(System.IO.Path.Combine(directory,"bartender-blank-4x2.btw"),true);
   if(!format.PrintToFile || System.IO.Path.GetFullPath(format.PrinterFile)!=System.IO.Path.Combine(directory,"bartender-blank-4x2.zpl")) throw new System.Exception("Offline print routing not retained.");
   BarTender.Messages messages;
   var result=format.Print("Barista offline reference",true,30000,out messages);
   System.Console.WriteLine("Offline result: "+result+"; BarTender "+app.FullVersion);
   if(messages!=null) foreach(BarTender.Message message in messages)System.Console.WriteLine(message.Number+": "+message.Message);
  } finally {app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[ZplReferenceResearch]::Export($researchZebra.Name,[System.IO.Path]::GetFullPath($researchOutput)) | Tee-Object -FilePath (Join-Path $researchOutput 'reference-status.txt')
