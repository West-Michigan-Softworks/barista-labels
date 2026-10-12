Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwTextResearch {
 public static void Inspect() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(@"C:\Program Files\Seagull\BarTender 12.1\Templates\Signage\Fire Extinguisher\Fire Extinguisher Sign 8 x 4 - Version 1.btw",false,"");
   var remove=new System.Collections.Generic.List<string>();BarTender.DesignObject text=null;
   foreach(BarTender.DesignObject o in f.Objects){if(o.Type==BarTender.BtObjectType.btObjectText)text=o;else remove.Add(o.Name);}
   foreach(var name in remove)f.Objects.Delete(name);
   System.Console.WriteLine(f.Objects.ExportDataSourceValuesToXML());
   System.Console.WriteLine(text.Name+" Value="+text.Value+" Font="+text.FontName+" Size="+text.FontSize);
   text.X=1;text.Y=0.25;text.FontName="Arial";text.FontSize=12;
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/text-only.btw"),true);
   text.FontSize=24;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/text-only-size24.btw"),true);
  }finally{app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwTextResearch]::Inspect()
