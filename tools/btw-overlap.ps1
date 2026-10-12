# Final reference check: distinguish transparent and white rectangle fill.
Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwOverlapResearch {
 public static void Check() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(System.IO.Path.GetFullPath("research-artifacts/btw/mail-core.btw"),false,"");
   foreach(BarTender.DesignObject o in f.Objects)if(o.Type==BarTender.BtObjectType.btObjectBox){o.X=2.5;o.Y=1;}
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/mail-core-overlap.btw"),true);
   f.ExportToFile(System.IO.Path.GetFullPath("research-artifacts/btw/mail-core-overlap.png"),"PNG",BarTender.BtColors.btColorsMono,(BarTender.BtResolution)300,BarTender.BtSaveOptions.btDoNotSaveChanges);
  }finally{app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwOverlapResearch]::Check()
