Add-Type -Path 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll'
Add-Type -ReferencedAssemblies 'C:\Program Files\Seagull\BarTender 12.1\Interop.BarTender.dll' -TypeDefinition @'
public static class BtwObjectResearch {
 public static void Inspect() {
  var app=new BarTender.ApplicationClass();
  try {
   var f=app.Formats.Open(@"C:\Program Files\Seagull\BarTender 12.1\Templates\Signage\Fire Extinguisher\Fire Extinguisher Sign 8 x 4 - Version 1.btw",false,"");
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/sign-research-copy.btw"),true);
   System.Console.WriteLine("Objects "+f.Objects.Count);
   var remove=new System.Collections.Generic.List<string>();
   BarTender.DesignObject box=null;
   foreach(BarTender.DesignObject o in f.Objects) {
    System.Console.WriteLine(o.Name+" "+o.Type+" "+o.X+","+o.Y+" "+o.Width+","+o.Height);
    if(o.Type==BarTender.BtObjectType.btObjectBox)box=o;else remove.Add(o.Name);
   }
   foreach(var name in remove)System.Console.WriteLine("Delete "+name+" "+f.Objects.Delete(name));
   box.X=0.25;box.Y=0.25;box.Width=1;box.Height=0.5;box.LineThickness=0.01;
   f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/rectangle-only.btw"),true);
   box.X=0.5;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/rectangle-only-moved.btw"),true);
   box.Width=1.5;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/rectangle-only-width.btw"),true);
   box.Height=0.75;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/rectangle-only-height.btw"),true);
   box.RotationAngle=90;f.SaveAs(System.IO.Path.GetFullPath("research-artifacts/btw/rectangle-only-rotation.btw"),true);
  } finally {app.Quit(BarTender.BtSaveOptions.btDoNotSaveChanges);}
 }
}
'@
[BtwObjectResearch]::Inspect()
