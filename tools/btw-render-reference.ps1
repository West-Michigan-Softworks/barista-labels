$ErrorActionPreference = 'Stop'
Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwRenderReference {
 public static void Run(string document,string directory) {
  System.IO.Directory.CreateDirectory(directory);
  var app=new BarTender.ApplicationClass();
  try {
   var format=app.Formats.Open(document,false,"");
   // This routine only calls image export, never Print/template export. Set
   // offline routing defensively before export; any accidental future Print
   // call would still have a research-file target.
   format.PrintToFile=true;
   format.PrinterFile=System.IO.Path.Combine(directory,"unused-offline.zpl");
   foreach(int dpi in new int[]{203,300}) {
    string filename=System.IO.Path.Combine(directory,"bartender-core-"+dpi+"dpi.png");
    format.ExportToFile(filename,"PNG",BarTender.BtColors.btColorsMono,(BarTender.BtResolution)dpi,BarTender.BtSaveOptions.btSaveChanges);
    System.Console.WriteLine("Image exported "+filename+"; requested "+dpi+" dpi; BarTender "+app.FullVersion);
   }
  } finally {app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwRenderReference]::Run([System.IO.Path]::GetFullPath('research-artifacts/btw/mail-core.btw'),[System.IO.Path]::GetFullPath('research-artifacts/zpl/btw-core-full-resolution'))
