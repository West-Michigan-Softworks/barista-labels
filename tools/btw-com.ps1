Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwFixtureResearch {
 public static void Inspect() {
  var app = new BarTender.ApplicationClass();
  try {
   var formats=app.Formats;
   var format=formats.Add();
   format.PageSetup.PaperWidth=4;
   format.PageSetup.PaperHeight=2;
   format.PageSetup.MarginLeft=0;
   format.PageSetup.MarginRight=0;
   format.PageSetup.MarginTop=0;
   format.PageSetup.MarginBottom=0;
   format.PageSetup.LabelSizeManual=true;
   format.PageSetup.LabelWidth=4;
   format.PageSetup.LabelHeight=2;
   System.IO.Directory.CreateDirectory("research-artifacts/btw");
   format.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/blank.btw"),true);
   format.PageSetup.LabelWidth=3;
   format.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/blank-width3.btw"),true);
   format.PageSetup.LabelHeight=1;
   format.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/blank-height1.btw"),true);
   System.Console.WriteLine("Created original fixtures; " + app.FullVersion);
  } finally { app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges); }
 }
}
'@
[BtwFixtureResearch]::Inspect()
